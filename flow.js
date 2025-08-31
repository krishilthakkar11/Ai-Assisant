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
import { franc } from "franc";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;
const app = express();

const NGROK_URL = (process.env.NGROK_URL || "").replace(/\/+$/, "");
const audioDir = path.join(process.cwd(), "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

// Sarvam client for TTS (we will use REST for STT to force translate=false)
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

// --- Download Twilio recording ---
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
const outPath = path.join(outDir, `${recordingSid}_raw.wav`);
fs.writeFileSync(outPath, buffer);
log("Downloaded recording to:", outPath);
return outPath;
} catch (err) {
log("download attempt error:", err?.message || err);
}
}
throw new Error("Could not download recording from Twilio (checked variations).");
}

// --- Convert to 16k mono WAV ---
function convertTo16kMono(inputPath, outPath) {
return new Promise((resolve, reject) => {
ffmpeg(inputPath)
.outputOptions(["-ar 16000", "-ac 1", "-y"])
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

// --- Helpers for language normalization/override ---

function normalizeLangCode(code) {
if (!code) return "unknown";
const lc = String(code).toLowerCase();
if (lc.startsWith("gu")) return "gu-IN";
if (lc.startsWith("hi")) return "hi-IN";
if (lc.startsWith("en")) return "en-IN";
if (lc.startsWith("bn")) return "bn-IN";
if (lc.startsWith("kn")) return "kn-IN";
if (lc.startsWith("ml")) return "ml-IN";
if (lc.startsWith("mr")) return "mr-IN";
if (lc.startsWith("od")) return "od-IN";
if (lc.startsWith("pa")) return "pa-IN";
if (lc.startsWith("ta")) return "ta-IN";
if (lc.startsWith("te")) return "te-IN";
return code;
}

function detectLanguageLocal(text) {
if (!text || text.trim().length === 0) return "en-IN";
if (/[\u0A80-\u0AFF]/.test(text)) return "gu-IN"; // Gujarati script
if (/[\u0900-\u097F]/.test(text)) return "hi-IN"; // Devanagari (Hindi)
if (text.trim().length < 6) return "en-IN";

const francLang = franc(text, { minLength: 3 });
if (francLang === "guj") return "gu-IN";
if (francLang === "hin") return "hi-IN";
if (francLang === "eng") return "en-IN";
return "en-IN";
}

// Romanized cues (if STT outputs Latin letters but user spoke Indic)
const romanGujaratiRe = /\b(kem|cho|maja|majama|tame|tamne|shu|su|mane|hu|maru|bhai|barabar|krupaya|dhanyavaad)\b/i;
const romanHindiRe = /\b(aap|aapka|kaise|naam|namaste|shukriya|haan|nahi|kya|kyu|kyun|theek|thik|bahut|kripya|dhanyavad)\b/i;

function resolveFinalLang(sttLangCode, transcript) {
const scriptGu = /[\u0A80-\u0AFF]/.test(transcript);
const scriptHi = /[\u0900-\u097F]/.test(transcript);

if (scriptGu) return "gu-IN";
if (scriptHi) return "hi-IN";

let lang = normalizeLangCode(sttLangCode);

// If STT says English but romanized cues suggest otherwise, override
if (lang === "en-IN") {
if (romanGujaratiRe.test(transcript)) return "gu-IN";
if (romanHindiRe.test(transcript)) return "hi-IN";
}

// If unknown, fall back to local detector
if (!lang || lang === "unknown") {
lang = detectLanguageLocal(transcript);
}

return lang || "en-IN";
}

// --- Sarvam STT via REST (forces translate=false) ---
async function sarvamSTT(filePath) {
try {
const url = "https://api.sarvam.ai/speech-to-text";
const model = process.env.SARVAM_STT_MODEL || "saarika:v2.5";

const fd = new FormData();
fd.append("file", fs.createReadStream(filePath));
fd.append("model", model);
fd.append("language_code", "unknown"); // let Sarvam auto-detect input language
fd.append("translate", "false"); // hard-stop any translation to English

const headers = fd.getHeaders();
headers["api-subscription-key"] = process.env.SARVAM_API_KEY;

log("Calling Sarvam STT with model:", model);
const res = await fetch(url, { method: "POST", headers, body: fd });
const json = await res.json().catch(() => null);

if (!res.ok) {
console.error("Sarvam STT error:", res.status, json);
throw new Error("Sarvam STT error");
}

const transcript =
json?.transcript ||
json?.text ||
(Array.isArray(json?.results) && json.results[0]?.alternatives?.[0]?.transcript) ||
"";

const langCode = normalizeLangCode(json?.language_code || "unknown");

if (!transcript) throw new Error("Sarvam STT returned no transcript");

log("Sarvam STT transcript:", transcript);
log("Sarvam detected language code:", langCode);

return { transcript, langCode };
} catch (err) {
console.error("Sarvam STT error:", err?.message || err);
return { transcript: "", langCode: "unknown" };
}
}

// --- DeepSeek chat (short replies, same language) ---
async function callDeepSeek(userText, langCode) {
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_API_KEY missing in .env");
const model = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";

const messages = [
{
role: "system",
content: `You are an AI assistant on a phone call.
The user speaks in ${langCode}.
Always reply ONLY in ${langCode}.
Keep it short: 1 sentence only, max 20 words.`
},
{ role: "user", content: userText }
];

const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
method: "POST",
headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
body: JSON.stringify({ model, messages, temperature: 0.25, max_tokens: 60 })
});

const json = await res.json().catch(() => null);
if (!res.ok) throw new Error("DeepSeek API error");

let reply = json?.choices?.[0]?.message?.content || "";
if (!reply) throw new Error("DeepSeek returned no text");

// Remove emojis and surrogate symbols
reply = reply.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
reply = reply.replace(/[\uD800-\uDFFF]/g, "");
reply = reply.replace(/([!?.,])\1+/g, "$1");

if (reply.length > 200) reply = reply.slice(0, 200) + "...";

log("DeepSeek reply:", reply);
return reply.trim();
}

// --- Sarvam TTS ---
async function sarvamTTSAndSave(text, outFilePath, langCode = "en-IN") {
const response = await sarvam.textToSpeech.convert({
text,
target_language_code: langCode,
speaker: process.env.SARVAM_TTS_VOICE || "anushka",
pitch: 0,
pace: 1,
loudness: 1,
speech_sample_rate: 22050,
enable_preprocessing: true,
model: "bulbul:v2"
});

const base64Audio = Array.isArray(response.audios) && response.audios[0];
if (!base64Audio) throw new Error("No audio returned from Sarvam TTS");

const audioBuffer = Buffer.from(base64Audio, "base64");
fs.writeFileSync(outFilePath, audioBuffer);

log(`Saved TTS audio (${langCode}):`, outFilePath);
return outFilePath;
}

// --- TwiML record tag ---
function recordTagXml() {
return `<Record action="${NGROK_URL}/recording" method="POST" maxLength="20" timeout="6" playBeep="true" finishOnKey="*" trim="trim-silence" />`;
}

// --- Twilio endpoints ---
app.use(express.urlencoded({ extended: false }));

app.get("/answer", (req, res) => {
const twiml = `
<Response>
<Say>AI assistant connected. You can speak after the beep. Press star to end.</Say>
${recordTagXml()}
</Response>`;
res.type("text/xml").send(twiml);
});

app.post("/recording", async (req, res) => {
try {
const recordingUrl = req.body.RecordingUrl;
const recordingSid = req.body.RecordingSid || ("RE" + Date.now());
const digits = (req.body.Digits || "").trim();

if (digits === "*") {
res.type("text/xml").send(`<Response><Say>Okay, ending the call. Goodbye.</Say><Hangup/></Response>`);
return;
}
if (!recordingUrl) throw new Error("No RecordingUrl in webhook");

// 1) Download & convert
const rawPath = await downloadRecording(recordingUrl, audioDir, recordingSid);
const convertedPath = path.join(audioDir, `${recordingSid}_16k.wav`);
await convertTo16kMono(rawPath, convertedPath);

// 2) STT (no translation) + robust language resolve
const { transcript, langCode: sttLang } = await sarvamSTT(convertedPath);

if (!transcript || transcript.trim().length === 0) {
  console.log("⚠ No speech detected");
  const twiml = `
  <Response>
    <Say>I didn’t hear anything. Please try speaking after the beep.</Say>
    ${recordTagXml()}
  </Response>`;
  res.type("text/xml").send(twiml);
  return;
}
const langCode = resolveFinalLang(sttLang, transcript);
log("Final chosen language code:", langCode);

// 3) DeepSeek reply
let aiReply;
try {
aiReply = await callDeepSeek(transcript, langCode);
} catch {
aiReply = (langCode === "gu-IN") ? "માફ કરશો, કૃપા કરીને ફરી પૂછો." :
(langCode === "hi-IN") ? "माफ करें, कृपया फिर पूछें।" :
"Sorry, please ask again.";
}

// 4) TTS
const outTtsPath = path.join(audioDir, `tts_${recordingSid}.wav`);
let ttsWorked = false;
try {
await sarvamTTSAndSave(aiReply, outTtsPath, langCode);
ttsWorked = true;
} catch {
log("TTS failed, fallback to <Say>");
}

// 5) Build TwiML
const playUrl = `${NGROK_URL}/audio/${path.basename(outTtsPath)}`;
const twiml = ttsWorked ? `
<Response>
<Play>${playUrl}</Play>
<Pause length="1"/>
${recordTagXml()}
</Response>` : `
<Response>
<Say>${aiReply}</Say>
<Pause length="1"/>
${recordTagXml()}
</Response>`;

res.type("text/xml").send(twiml);

} catch (err) {
console.error("❌ Flow error:", err?.message || err);
res.type("text/xml").send(`<Response><Say>Sorry, the AI failed. Goodbye.</Say><Hangup/></Response>`);
}
});

// static audio
app.use("/audio", express.static(audioDir));
app.listen(PORT, () => {
log(`✅ Flow server running on http://localhost:${PORT}`);
});