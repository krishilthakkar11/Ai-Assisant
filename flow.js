// flow.js
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import fetch from "node-fetch"; // v2
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { SarvamAIClient } from "sarvamai";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;
const app = express();

const NGROK_URL = (process.env.NGROK_URL || "").replace(/\/+$/, "");
const audioDir = path.join(process.cwd(), "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

// Sarvam client for TTS (REST for STT stays below)
const sarvam = new SarvamAIClient({
apiSubscriptionKey: process.env.SARVAM_API_KEY
});

// --- Twilio basic auth for recording download ---
function twilioAuthHeader() {
const sid = process.env.TWILIO_SID;
const token = process.env.TWILIO_AUTH;
if (!sid || !token) return null;
return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

// --- Download Twilio recording (try base url, .wav, .mp3) ---
async function downloadRecording(recordingUrl, outDir, recordingSid) {
const attempts = [recordingUrl, `${recordingUrl}.wav`, `${recordingUrl}.mp3`];
const auth = twilioAuthHeader();
if (!auth) throw new Error("TWILIO_SID or TWILIO_AUTH missing in .env");

for (const url of attempts) {
try {
console.log("Attempt download:", url);
const res = await fetch(url, { headers: { Authorization: auth }, timeout: 20000 });
if (!res.ok) {
console.log("recording fetch not ok", url, res.status);
continue;
}
const buffer = await res.buffer();
const outPath = path.join(outDir, `${recordingSid}_raw`);
fs.writeFileSync(outPath, buffer);
console.log("Downloaded recording to:", outPath);
return outPath;
} catch (err) {
console.log("download attempt error:", err && err.message ? err.message : err);
}
}
throw new Error("Could not download recording from Twilio (checked variations).");
}

// --- Convert any input to 16k mono WAV (for STT) ---
function convertTo16kMono(inputPath, outPath) {
return new Promise((resolve, reject) => {
ffmpeg(inputPath)
.audioFrequency(16000)
.audioChannels(1)
.format("wav")
.on("error", (err) => {
console.error("FFmpeg error:", err);
reject(err);
})
.on("end", () => {
console.log("Converted to 16k mono WAV:", outPath);
resolve(outPath);
})
.save(outPath);
});
}

// --- Sarvam STT via REST (multipart/form-data) ---
async function sarvamSTT(wavFilePath) {
const url = "https://api.sarvam.ai/speech-to-text"; // correct endpoint
const model = process.env.SARVAM_STT_MODEL || "saarika:v2.5";
const fd = new FormData();
fd.append("file", fs.createReadStream(wavFilePath));
fd.append("model", model);
// latency-friendly hints (optional)
fd.append("language_code", "en-IN");

const headers = fd.getHeaders();
headers["api-subscription-key"] = process.env.SARVAM_API_KEY;

console.log("Calling Sarvam STT with model:", model);
const res = await fetch(url, {
method: "POST",
headers,
body: fd
});

const json = await res.json().catch(() => null);
if (!res.ok) {
console.error("Sarvam STT error:", res.status, json);
const err = new Error("Sarvam STT error " + (json?.error?.code || res.status));
err.raw = json;
throw err;
}

const transcript =
json?.text ||
(Array.isArray(json?.results) && json.results[0]?.alternatives?.[0]?.transcript) ||
json?.transcript ||
"";

if (!transcript) {
console.error("Sarvam STT returned (no transcript):", json);
throw new Error("Sarvam STT returned no transcript");
}

console.log("Sarvam STT transcript:", transcript);
return transcript;
}

// --- DeepSeek chat completions ---
async function callDeepSeek(userText) {
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_API_KEY missing in .env");
const model = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";
const url = "https://api.deepseek.com/v1/chat/completions";

const body = {
model,
messages: [{ role: "user", content: userText }],
temperature: 0.3,
max_tokens: 256
};

const res = await fetch(url, {
method: "POST",
headers: {
"Authorization": `Bearer ${key}`,
"Content-Type": "application/json"
},
body: JSON.stringify(body)
});

const json = await res.json().catch(() => null);
if (!res.ok) {
console.error("DeepSeek error:", res.status, json);
throw new Error("DeepSeek API error");
}
const reply = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || json?.text;
if (!reply) {
console.error("DeepSeek returned no reply:", json);
throw new Error("DeepSeek returned no text");
}
console.log("DeepSeek reply:", reply);
return reply;
}

// --- Sarvam TTS via SDK (unchanged) ---
async function sarvamTTSAndSave(text, outFilePath) {
const response = await sarvam.textToSpeech.convert({
text,
target_language_code: "en-IN",
speaker: process.env.SARVAM_TTS_VOICE || "anushka",
pitch: 0,
pace: 1,
loudness: 1,
speech_sample_rate: 22050,
enable_preprocessing: true,
model: "bulbul:v2"
});

const base64Audio = Array.isArray(response.audios) && response.audios[0];
if (!base64Audio) {
console.error("No audio returned from Sarvam TTS:", response);
throw new Error("No audio returned from Sarvam TTS");
}
const audioBuffer = Buffer.from(base64Audio, "base64");
fs.writeFileSync(outFilePath, audioBuffer);
console.log("Saved TTS audio:", outFilePath);
}

// --- Helpers to build TwiML blocks ---
function recordTagXml() {
// finishOnKey lets caller press * to end; trim removes leading/trailing silence -> lower latency
return `<Record action="${NGROK_URL}/recording" method="POST" maxLength="30" timeout="3" playBeep="true" finishOnKey="*" trim="trim-silence" />`;
}

// --- Twilio webhook endpoints ---
// First hit: prompt + first Record
app.get("/answer", (req, res) => {
console.log("== /answer hit ==", req.query || {});
if (!NGROK_URL) console.warn("⚠ NGROK_URL missing in .env; TwiML will have bad callback URL.");

const twiml = `
<Response>
<Say>Connecting you to the A I assistant. Please speak after the beep. Press star to end.</Say>
${recordTagXml()}
</Response>
`.trim();

res.type("text/xml").send(twiml);
});

// Each time Twilio finishes recording, it POSTs here.
// We run STT -> DeepSeek -> TTS, Play reply, then LOOP into another Record.
app.post("/recording", express.urlencoded({ extended: false }), async (req, res) => {
try {
console.log("== /recording webhook hit ==", req.body);
const recordingUrl = req.body.RecordingUrl;
const recordingSid = req.body.RecordingSid || ("RE" + Date.now());
const digits = (req.body.Digits || "").trim();

// If caller pressed *, end gracefully
if (digits === "*") {
res.type("text/xml").send(`<Response><Say>Okay, ending the call. Goodbye.</Say><Hangup/></Response>`);
return;
}

if (!recordingUrl) throw new Error("No RecordingUrl in Twilio webhook");

// 1) Download recording
const rawPath = await downloadRecording(recordingUrl, audioDir, recordingSid);

// 2) Convert to 16k mono wav
const convertedPath = path.join(audioDir, `${recordingSid}_16k.wav`);
await convertTo16kMono(rawPath, convertedPath);

// 3) STT
const transcript = await sarvamSTT(convertedPath);

// 4) DeepSeek
console.log("Calling DeepSeek with user text...");
const aiReply = await callDeepSeek(transcript);

// 5) TTS and save file
const outTtsPath = path.join(audioDir, `tts_${recordingSid}.wav`);
await sarvamTTSAndSave(aiReply, outTtsPath);

// 6) Respond TwiML: Play reply, then LOOP to another Record
const playUrl = `${NGROK_URL}/audio/${path.basename(outTtsPath)}`;
const twiml = `
<Response>
<Play>${playUrl}</Play>
<Pause length="1"/>
<Say>You can speak now. Press star to end.</Say>
${recordTagXml()}
</Response>
`.trim();

res.type("text/xml").send(twiml);

} catch (err) {
console.error("❌ Sarvam/flow error:", err && err.message ? err.message : err);
res.type("text/xml").send(`<Response><Say>Sorry, the A I failed. Please try again later.</Say><Hangup/></Response>`);
}
});

// serve audio files
app.use("/audio", express.static(audioDir));

// health
app.get("/", (_req, res) => res.send("flow.js running"));

app.listen(PORT, () => {
console.log(`✅ Flow server running on http://localhost:${PORT}`);
console.log(`✅ /answer endpoint available at ${NGROK_URL ? NGROK_URL + "/answer" : "set NGROK_URL in .env"}`);
});