// flow.js (updated) — drop-in replacement
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import fetch from "node-fetch"; // v2
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { SarvamAIClient } from "sarvamai";
import { franc } from "franc";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;
const app = express();

const NGROK_URL = (process.env.NGROK_URL || "").replace(/\/+$/, "");
const audioDir = path.join(process.cwd(), "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

// Sarvam client for TTS
const sarvam = new SarvamAIClient({
apiSubscriptionKey: process.env.SARVAM_API_KEY
});

// small helpers
function log(...args) { console.log(...args); }
function warn(...args) { console.warn(...args); }

// --- Twilio auth header for recording download ---
function twilioAuthHeader() {
const sid = process.env.TWILIO_SID;
const token = process.env.TWILIO_AUTH;
if (!sid || !token) return null;
return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

// --- Download Twilio recording (try variations) ---
async function downloadRecording(recordingUrl, outDir, recordingSid) {
const attempts = [recordingUrl, `${recordingUrl}.wav`, `${recordingUrl}.mp3`];
const auth = twilioAuthHeader();
if (!auth) throw new Error("TWILIO_SID or TWILIO_AUTH missing in .env");

for (const url of attempts) {
try {
log("Attempt download:", url);
const res = await fetch(url, { headers: { Authorization: auth }, timeout: 20000 });
if (!res.ok) {
log("recording fetch not ok", url, res.status);
continue;
}
const buffer = await res.buffer();
const outPath = path.join(outDir, `${recordingSid}_raw`);
fs.writeFileSync(outPath, buffer);
log("Downloaded recording to:", outPath);
return outPath;
} catch (err) {
log("download attempt error:", err?.message || err);
}
}
throw new Error("Could not download recording from Twilio (checked variations).");
}

// --- Convert to 16k mono WAV (ffmpeg) ---
function convertTo16kMono(inputPath, outPath) {
return new Promise((resolve, reject) => {
// Use minimal logs and force quick conversion settings
ffmpeg(inputPath)
.outputOptions([
"-ar 16000",
"-ac 1",
"-y" // overwrite if exists
])
.format("wav")
.on("error", (err) => {
console.error("FFmpeg error:", err);
reject(err);
})
.on("end", () => {
log("Converted to 16k mono WAV:", outPath);
resolve(outPath);
})
.save(outPath);
});
}

// --- Sarvam STT (REST) ---
async function sarvamSTT(wavFilePath) {
const url = "https://api.sarvam.ai/speech-to-text";
const model = process.env.SARVAM_STT_MODEL || "saarika:v2.5";
const fd = new FormData();
fd.append("file", fs.createReadStream(wavFilePath));
fd.append("model", model);
// we keep language hint optional (Sarvam will auto-detect usually)
// fd.append("language_code", "auto");

const headers = fd.getHeaders();
headers["api-subscription-key"] = process.env.SARVAM_API_KEY;

log("Calling Sarvam STT with model:", model);
const res = await fetch(url, { method: "POST", headers, body: fd });

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

log("Sarvam STT transcript:", transcript);
return transcript;
}

// --- Robust language detection (script check + franc fallback) ---
// returns normalized codes used in TTS and prompts: "gu-IN", "hi-IN", "en-IN"
function detectLanguage(text) {
if (!text || text.trim().length === 0) return "en-IN";

// 1) check for Gujarati script (U+0A80–U+0AFF)
const hasGujarati = /[\u0A80-\u0AFF]/.test(text);
if (hasGujarati) return "gu-IN";

// 2) check for Devanagari (Hindi) (U+0900–U+097F)
const hasDevanagari = /[\u0900-\u097F]/.test(text);
if (hasDevanagari) return "hi-IN";

// 3) if text has Latin letters only but short, franc may return unreliable 'und' — for short text prefer English
if (text.trim().length < 6) {
// look for Gujarati/Hindi words transliterated? fallback to English
return "en-IN";
}

// 4) franc fallback (returns ISO 639-3 like 'guj','hin','eng')
const francLang = franc(text, { minLength: 3 });
if (francLang === "guj") return "gu-IN";
if (francLang === "hin") return "hi-IN";
if (francLang === "eng") return "en-IN";

// default fallback
return "en-IN";
}

// --- DeepSeek chat (short replies, language-aware) ---
async function callDeepSeek(userText, langCode) {
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_API_KEY missing in .env");
const model = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";

// system prompt forces short replies & same-language response
const systemPrompt = `You are an AI assistant on a phone call. The user speaks in language code ${langCode}.
Always reply in the same language. Keep replies concise and conversational — 1 or 2 short sentences only.`;

const messages = [
{ role: "system", content: systemPrompt },
{ role: "user", content: userText }
];

const body = {
model,
messages,
temperature: 0.25,
max_tokens: 120 // keep answers short to limit TTS length and latency
};

const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
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

const reply = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || json?.output_text || "";
if (!reply) throw new Error("DeepSeek returned no text");

// final safety trim (max characters)
let safeReply = reply.trim();
if (safeReply.length > 400) safeReply = safeReply.slice(0, 400) + "...";

log("DeepSeek reply:", safeReply);
return safeReply;
}

// --- Sarvam TTS & save (language-aware) ---
async function sarvamTTSAndSave(text, outFilePath, langCode = "en-IN") {
// Accept either "gu-IN", "hi-IN", "en-IN"
const target = langCode || "en-IN";
try {
const response = await sarvam.textToSpeech.convert({
text,
target_language_code: target,
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
log(`Saved TTS audio (${target}):`, outFilePath);
return outFilePath;
} catch (err) {
console.error("Sarvam TTS failed:", err?.message || err);
throw err;
}
}

// --- Helpers to build TwiML record tag (shorter for speed) ---
function recordTagXml() {
// maxLength and timeout tuned for responsive loop
return `<Record action="${NGROK_URL}/recording" method="POST" maxLength="20" timeout="2" playBeep="true" finishOnKey="*" trim="trim-silence" />`;
}

// --- Twilio endpoints ---

app.use(express.urlencoded({ extended: false }));

app.get("/answer", (req, res) => {
log("== /answer hit ==", req.query || {});
if (!NGROK_URL) warn("⚠ NGROK_URL missing in .env; TwiML will have bad callback URL.");
const twiml = `
<Response>
<Say>AI assistant connected. You can speak after the beep. Press star to end.</Say>
${recordTagXml()}
</Response>`.trim();
res.type("text/xml").send(twiml);
});

app.post("/recording", async (req, res) => {
try {
log("== /recording webhook hit ==", req.body);
const recordingUrl = req.body.RecordingUrl;
const recordingSid = req.body.RecordingSid || ("RE" + Date.now());
const digits = (req.body.Digits || "").trim();
if (digits === "*") {
res.type("text/xml").send(`<Response><Say>Okay, ending the call. Goodbye.</Say><Hangup/></Response>`);
return;
}
if (!recordingUrl) throw new Error("No RecordingUrl in Twilio webhook");

// 1) Download recording
const rawPath = await downloadRecording(recordingUrl, audioDir, recordingSid);

// 2) Convert to 16k mono wav (fast)
const convertedPath = path.join(audioDir, `${recordingSid}_16k.wav`);
await convertTo16kMono(rawPath, convertedPath);

// 3) STT
const transcript = await sarvamSTT(convertedPath);

// 4) Detect language (script-first: handles short initial utterances)
const langCode = detectLanguage(transcript);
log("Detected language:", langCode);

// 5) Call DeepSeek (short reply)
let aiReply;
try {
aiReply = await callDeepSeek(transcript, langCode);
} catch (dsErr) {
console.error("DeepSeek error, fallback message:", dsErr?.message || dsErr);
aiReply = (langCode === "gu-IN") ? "માફ કરશો, મને તકલીફ થઈ છે. કૃપા કરીને ફરી પૂછો." :
(langCode === "hi-IN") ? "माफ करें, मुझे समस्या हुई। कृपया फिर पूछें।" :
"Sorry, I had an issue. Please ask again.";
}

// 6) TTS -> file
const outTtsPath = path.join(audioDir, `tts_${recordingSid}.wav`);
let ttsWorked = false;
try {
await sarvamTTSAndSave(aiReply, outTtsPath, langCode);
ttsWorked = true;
} catch (ttsErr) {
console.error("TTS failed, will fallback to <Say>:", ttsErr?.message || ttsErr);
}

// 7) Build TwiML response: play if TTS ok, else Say fallback (English)
let twiml;
const playUrl = `${NGROK_URL}/audio/${path.basename(outTtsPath)}`;
if (ttsWorked) {
// Play the TTS audio and then loop back to record
twiml = `
<Response>
<Play>${playUrl}</Play>
<Pause length="1"/>
<Say>You can speak now. Press star to end.</Say>
${recordTagXml()}
</Response>`.trim();
} else {
// Use Say fallback (limited languages supported by Twilio; we'll use English fallback)
twiml = `
<Response>
<Say>${aiReply}</Say>
<Pause length="1"/>
<Say>You can speak now. Press star to end.</Say>
${recordTagXml()}
</Response>`.trim();
}

res.type("text/xml").send(twiml);

} catch (err) {
console.error("❌ Flow error:", err?.message || err);
// Graceful fallback — say short apology and hang up
res.type("text/xml").send(`<Response><Say>Sorry, the AI failed. Please try again later.</Say><Hangup/></Response>`);
}
});

// static audio
app.use("/audio", express.static(audioDir));
app.get("/", (_req, res) => res.send("flow.js running"));

app.listen(PORT, () => {
log(`✅ Flow server running on http://localhost:${PORT}`);
log(`✅ /answer at ${NGROK_URL ? NGROK_URL + "/answer" : "set NGROK_URL in .env"}`);
});