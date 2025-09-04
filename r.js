// s.js
// Real-time Twilio Media Stream -> Sarvam streaming STT (SDK preferred) -> fallback REST STT
// -> DeepSeek -> Sarvam TTS -> stream TTS back into Twilio Media Stream (mu-law 8k).
// Run: node s.js
// Required packages: express ws node-fetch form-data sarvamai franc
import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";
import FormData from "form-data";
import { SarvamAIClient, SarvamAI } from "sarvamai";
import { franc } from "franc";

dotenv.config();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const NGROK_URL = (process.env.NGROK_URL || "").replace(/\/+$/, "");
const SARVAM_KEY = process.env.SARVAM_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const sttModel = process.env.SARVAM_STT_MODEL || "saarika:v2.5";
const langCode = process.env.LANGUAGE_CODE || "en-IN";

if (!NGROK_URL) console.warn("⚠ NGROK_URL not set in .env (required for Twilio webhooks).");
if (!SARVAM_KEY) console.warn("⚠ SARVAM_API_KEY not set in .env");
if (!DEEPSEEK_KEY) console.warn("⚠ DEEPSEEK_API_KEY not set in .env");

// tuning for latency
const CHUNK_SECONDS = parseFloat(process.env.CHUNK_SECONDS || "0.9"); // ~0.9s chunks
const TWILIO_SAMPLE_RATE = 8000; // Twilio telephony is 8k (µ-law)
const TTS_SAMPLE_RATE = 16000; // Sarvam TTS uses 16k by default

// audio dir for TTS playback (kept for debugging)
const audioDir = path.join(process.cwd(), "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

// ---------- helpers ----------
function log(...args) { console.log(new Date().toISOString(), ...args); }
function warn(...args) { console.warn(new Date().toISOString(), ...args); }
function errLog(...args) { console.error(new Date().toISOString(), ...args); }

function makeStreamUrl() {
if (!NGROK_URL) return "wss://your-ngrok/stream";
return NGROK_URL.replace(/^https?:/, "wss:") + "/stream";
}

async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Twilio call update helper (left as fallback)
async function updateCallPlayAndReconnect(callSid, audioUrl) {
if (!TWILIO_SID || !TWILIO_AUTH) throw new Error("Missing TWILIO_SID or TWILIO_AUTH in env");
if (!NGROK_URL) throw new Error("NGROK_URL missing");
const streamWss = NGROK_URL.replace(/^http/, "ws") + "/stream";
const twiml = `<Response><Play>${audioUrl}</Play><Connect><Stream url="${streamWss}" track="inbound_track"/></Connect></Response>`;
const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${callSid}.json`;
const params = new URLSearchParams();
params.append("Twiml", twiml);

const res = await fetch(url, {
method: "POST",
headers: {
Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString("base64"),
"Content-Type": "application/x-www-form-urlencoded"
},
body: params.toString()
});
const json = await res.json().catch(()=>null);
if (!res.ok) {
errLog("Twilio update failed:", res.status, json);
throw new Error("Twilio update failed");
}
log("Twilio call updated to play TTS and reconnect stream");
return json;
}

// ---------- language heuristics ----------
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
if (/[\u0A80-\u0AFF]/.test(text)) return "gu-IN";
if (/[\u0900-\u097F]/.test(text)) return "hi-IN";
if (text.trim().length < 6) return "en-IN";
const francLang = franc(text, { minLength: 3 });
if (francLang === "guj") return "gu-IN";
if (francLang === "hin") return "hi-IN";
if (francLang === "eng") return "en-IN";
return "en-IN";
}

const romanGujaratiRe = /\b(kem|cho|maja|majama|tame|tamne|shu|su|mane|hu|maru|bhai|barabar|krupaya|dhanyavaad)\b/i;
const romanHindiRe = /\b(aap|aapka|kaise|naam|namaste|shukriya|haan|nahi|kya|kyu|kyun|theek|thik|bahut|kripya|dhanyavad)\b/i;

function resolveFinalLang(sttLangCode, transcript) {
const scriptGu = /[\u0A80-\u0AFF]/.test(transcript);
const scriptHi = /[\u0900-\u097F]/.test(transcript);
if (scriptGu) return "gu-IN";
if (scriptHi) return "hi-IN";
let lang = normalizeLangCode(sttLangCode);
if (lang === "en-IN") {
if (romanGujaratiRe.test(transcript)) return "gu-IN";
if (romanHindiRe.test(transcript)) return "hi-IN";
}
if (!lang || lang === "unknown") {
lang = detectLanguageLocal(transcript);
}
return lang || "en-IN";
}

// ---------- mu-law decode (we already had) ----------
function muLawToPcm16Buffer(muLawBuf) {
const out = Buffer.alloc(muLawBuf.length * 2);
for (let i = 0; i < muLawBuf.length; i++) {
const u_val = ~muLawBuf[i] & 0xff;
const sign = (u_val & 0x80);
const exponent = (u_val >> 4) & 0x07;
const mantissa = u_val & 0x0f;
let sample = ((mantissa << 3) + 0x84) << exponent;
sample = sample - 0x84;
if (sign !== 0) sample = -sample;
if (sample > 32767) sample = 32767;
if (sample < -32768) sample = -32768;
out.writeInt16LE(sample, i * 2);
}
return out;
}

// ---------- make WAV header (PCM16LE) ----------
function makeWavBuffer(pcm16Buffer, sampleRate = TWILIO_SAMPLE_RATE, numChannels = 1) {
const byteRate = sampleRate * numChannels * 2;
const blockAlign = numChannels * 2;
const dataSize = pcm16Buffer.length;
const buffer = Buffer.alloc(44 + dataSize);
let offset = 0;
buffer.write("RIFF", offset); offset += 4;
buffer.writeUInt32LE(36 + dataSize, offset); offset += 4;
buffer.write("WAVE", offset); offset += 4;
buffer.write("fmt ", offset); offset += 4;
buffer.writeUInt32LE(16, offset); offset += 4;
buffer.writeUInt16LE(1, offset); offset += 2;
buffer.writeUInt16LE(numChannels, offset); offset += 2;
buffer.writeUInt32LE(sampleRate, offset); offset += 4;
buffer.writeUInt32LE(byteRate, offset); offset += 4;
buffer.writeUInt16LE(blockAlign, offset); offset += 2;
buffer.writeUInt16LE(16, offset); offset += 2;
buffer.write("data", offset); offset += 4;
buffer.writeUInt32LE(dataSize, offset); offset += 4;
pcm16Buffer.copy(buffer, 44);
return buffer;
}


// ---------- call DeepSeek ----------
async function callDeepSeek(userText, langCode) {
if (!DEEPSEEK_KEY) {
warn("DEEPSEEK_KEY missing — returning fallback text");
return (langCode === "gu-IN") ? "માફ કરશો, કૃપા કરીને ફરી પૂછો." :
(langCode === "hi-IN") ? "माफ करें, कृपया फिर पूछें।" :
"Sorry, please ask again.";
}
try {
const model = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";
const messages = [
{ role: "system", content: `You are an AI assistant on a phone call. The user speaks in ${langCode}. Reply ONLY in ${langCode}. Keep answers short, 1 sentence only.` },
{ role: "user", content: userText }
];
const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
method: "POST",
headers: { "Authorization": `Bearer ${DEEPSEEK_KEY}`, "Content-Type": "application/json" },
body: JSON.stringify({ model, messages, temperature: 0.25, max_tokens: 60 })
});
const json = await res.json().catch(()=>null);
if (!res.ok) {
errLog("DeepSeek error:", res.status, json);
throw new Error("DeepSeek error");
}
let reply = json?.choices?.[0]?.message?.content || "";
reply = reply.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
reply = reply.replace(/[\uD800-\uDFFF]/g, "");
reply = reply.replace(/([!?.,])\1+/g, "$1");
if (reply.length > 200) reply = reply.slice(0,200) + "...";
log("DeepSeek reply:", reply);
return reply.trim();
} catch (e) {
errLog("DeepSeek failed:", e?.message || e);
return (langCode === "gu-IN") ? "માફ કરશો, કૃપા કરીને ફરી પૂછો." :
(langCode === "hi-IN") ? "माफ करें, कृपया फिर पूछें।" :
"Sorry, please ask again.";
}
}

// ---------- Sarvam REST STT (fallback) ----------
async function sarvamRestSttFromPcm(pcm16Buffer, sampleRate = TWILIO_SAMPLE_RATE) {
try {
const url = "https://api.sarvam.ai/speech-to-text";
const fd = new FormData();
const wav = makeWavBuffer(pcm16Buffer, sampleRate);
fd.append("file", wav, { filename: "chunk.wav", contentType: "audio/wav" });
fd.append("model", process.env.SARVAM_STT_MODEL || "saarika:v2.5");
fd.append("language_code", "en-IN");
fd.append("translate", "false");

const headers = fd.getHeaders();
headers["api-subscription-key"] = SARVAM_KEY;

const res = await fetch(url, { method: "POST", headers, body: fd });
const json = await res.json().catch(()=>null);
if (!res.ok) {
errLog("Sarvam REST STT error:", res.status, json);
return { transcript: "", langCode: "en-IN" };
}
const transcript = json?.transcript || json?.text || (Array.isArray(json?.results) && json.results[0]?.alternatives?.[0]?.transcript) || "";
const langCode = normalizeLangCode(json?.language_code || json?.language || "unknown");
log("Sarvam REST STT transcript:", transcript, "lang:", langCode);
return { transcript, langCode };
} catch (e) {
errLog("Sarvam REST STT failed:", e?.message || e);
return { transcript: "", langCode: "unknown" };
}
}

// ---------- Sarvam TTS -> return buffer (SDK preferred, REST fallback) ----------
async function sarvamTtsGetBuffer(sarvamClient, text, langCode="en-IN") {
try {
// Try SDK
const resp = await sarvamClient.textToSpeech.convert({
text,
target_language_code: langCode,
speaker: process.env.SARVAM_TTS_VOICE || "anushka",
pitch: 0,
pace: 1,
loudness: 1,
speech_sample_rate: TTS_SAMPLE_RATE,
enable_preprocessing: true,
model: process.env.SARVAM_TTS_MODEL || "bulbul:v2"
});
const base64Audio = Array.isArray(resp?.audios) && resp.audios[0];
if (!base64Audio) throw new Error("No audio from Sarvam TTS (SDK)");
const buf = Buffer.from(base64Audio, "base64");
return buf;
} catch (sdkErr) {
warn("Sarvam TTS SDK failed, trying REST fallback:", sdkErr?.message || sdkErr);
try {
const res = await fetch("https://api.sarvam.ai/text-to-speech", {
method: "POST",
headers: {
"Authorization": `Bearer ${SARVAM_KEY}`,
"Content-Type": "application/json"
},
body: JSON.stringify({
model: process.env.SARVAM_TTS_MODEL || "bulbul:v2",
input: text,
voice: process.env.SARVAM_TTS_VOICE || "anushka",
sample_rate: TTS_SAMPLE_RATE,
language: langCode
})
});
const j = await res.json().catch(()=>null);
if (!res.ok || !j?.audio) throw new Error("Sarvam TTS REST failed");
const buf = Buffer.from(j.audio, "base64");
return buf;
} catch (restErr) {
errLog("Sarvam TTS REST fallback failed:", restErr?.message || restErr);
return null;
}
}
}

// ---------------- Express + WSS server ----------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/audio", express.static(audioDir));

app.all("/answer", (req, res) => {
try {
const streamWss = makeStreamUrl();
const twiml = `
<Response>
<Say>Connecting you to Sarvam AI assistant</Say>
<Connect>
<Stream url="${streamWss}" track="inbound_track"/>
</Connect>
</Response>`;
log("📞 Twilio requested /answer — returning TwiML to connect media stream");
res.type("text/xml").send(twiml);
} catch (e) {
errLog("Error in /answer:", e);
res.status(500).send("Internal Server Error");
}
});

app.all("/recording", (req, res) => {
log("📼 Twilio requested /recording");
res.sendStatus(200);
});

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
log("HTTP upgrade request ->", req.url, "headers:", Object.keys(req.headers).map(k=>`${k}:${req.headers[k]}`).join(" | "));
});

const wss = new WebSocketServer({ server, path: "/stream" });

// Create Sarvam client instance (used for TTS and SDK attempts)
const sarvamClientForTTS = new SarvamAIClient({
apiSubscriptionKey: SARVAM_KEY,
// environment is optional — SDK will default to production
});

// --------------------- fast resample 8k->16k and 16k->8k ---------------------
function resample8kTo16k(pcm16leBuffer) {
const inSamples = pcm16leBuffer.length / 2;
const inView = new Int16Array(pcm16leBuffer.buffer, pcm16leBuffer.byteOffset, inSamples);
const outSamples = inSamples * 2;
const outView = new Int16Array(outSamples);
for (let i = 0; i < inSamples - 1; i++) {
const s1 = inView[i];
const s2 = inView[i + 1];
outView[i * 2] = s1;
outView[i * 2 + 1] = Math.floor((s1 + s2) / 2);
}
if (inSamples > 0) {
outView[(outSamples - 2)] = inView[inSamples - 1];
outView[(outSamples - 1)] = inView[inSamples - 1];
}
return Buffer.from(outView.buffer);
}

// Simple 16k -> 8k downsample by averaging pairs
function resample16kTo8k(pcm16leBuffer) {
const inSamples = pcm16leBuffer.length / 2;
const inView = new Int16Array(pcm16leBuffer.buffer, pcm16leBuffer.byteOffset, inSamples);
const outSamples = Math.floor(inSamples / 2);
const outView = new Int16Array(outSamples);
for (let i = 0; i < outSamples; i++) {
const s1 = inView[i*2];
const s2 = inView[i*2 + 1];
outView[i] = Math.floor((s1 + s2) / 2);
}
return Buffer.from(outView.buffer);
}

// PCM16 -> mu-law 8-bit
function pcm16ToMuLawBuffer(pcm16Buffer) {
const out = Buffer.alloc(pcm16Buffer.length / 2);
for (let i = 0; i < pcm16Buffer.length; i += 2) {
const sample = pcm16Buffer.readInt16LE(i);
out[i/2] = linearToMuLawSample(sample);
}
return out;
}

// μ-law encoding helper (A-law alternative omitted). Standard μ-law companding.
function linearToMuLawSample(sample) {
const MU = 255;
const MAX = 32767;
// Get sign and magnitude
let sign = (sample >> 8) & 0x80;
if (sign) sample = -sample;
if (sample > MAX) sample = MAX;
// Mu-law companding
const magnitude = Math.log1p(MU * sample / MAX) / Math.log1p(MU);
let compressed = Math.floor(magnitude * 127);
let muByte = (~(sign | compressed)) & 0xFF;
return muByte;
}

// send mu-law chunks to Twilio WS as media frames (20ms per frame)
async function streamPcm16ToTwilioWs(twilioWs, pcm16Buffer, sampleRate = 8000) {
if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
warn("Twilio WS not open — cannot stream TTS into call");
return false;
}

// Ensure pcm16Buffer is 8k
let pcm8kBuffer = pcm16Buffer;
if (sampleRate === 16000) {
pcm8kBuffer = resample16kTo8k(pcm16Buffer);
} else if (sampleRate !== 8000) {
// If Sarvam returns something else, try to handle simply by skipping/averaging
// (most likely Sarvam returns 16000)
warn("TTS sampleRate not 8k/16k, got", sampleRate);
}

// Convert to mu-law
const muBuf = pcm16ToMuLawBuffer(pcm8kBuffer);

// chunk for 20ms: 8000 samples/sec -> 160 samples per 20ms -> 160 bytes mu-law
const chunkBytes = 160;
for (let i = 0; i < muBuf.length; i += chunkBytes) {
const chunk = muBuf.slice(i, i + chunkBytes);
const payload = chunk.toString("base64");
const frame = {
event: "media",
media: { payload }
};
try {
twilioWs.send(JSON.stringify(frame));
} catch (e) {
warn("Failed send TTS chunk to Twilio WS:", e?.message || e);
return false;
}
// wait ~20ms to pace playback
await sleep(20);
}
return true;
}

// ---------------- WebSocket handler (Twilio -> our server) ----------------
wss.on("connection", async (ws, req) => {
log("☎ New Twilio Media Stream WS connection from", req.socket.remoteAddress);

const state = {
callSid: null,
sampleRate: TWILIO_SAMPLE_RATE,
channels: 1,
pcmBufferParts: [],
pcmBytes: 0,
inFlight: false,
ignoreUntil: 0
};

// stt streaming handles (per-call)
let sttSocket = null;
let sttReady = false;
let sttAttempted = false;
let pendingSendChunks = [];

// store twilio ws in closure
const twilioWs = ws;

// wrapper to send audio to current STT (handles multiple stream object shapes)
function sendToStt(pkt) {
  if (!sttSocket) {
    pendingSendChunks.push(pkt);
    return;
  }
  try {
    if (typeof sttSocket.sendAudio === "function") {
      // ✅ Correct SDK API
      sttSocket.sendAudio(pkt.audio.data, pkt.audio.sample_rate);

    } else if (typeof sttSocket.send === "function") {
      // fallback for raw WebSocket
      sttSocket.send(JSON.stringify(pkt));

    } else if (typeof sttSocket.write === "function") {
      sttSocket.write(JSON.stringify(pkt));

    } else {
      // buffer if nothing works
      pendingSendChunks.push(pkt);
    }

  } catch (e) {
    warn("sendToStt failed, buffering:", e?.message || e);
    pendingSendChunks.push(pkt);
  }
}

function flushPendingToStt() {
if (!pendingSendChunks || pendingSendChunks.length === 0) return;
log(`Flushing ${pendingSendChunks.length} pending audio frames to STT`);
const copy = pendingSendChunks.slice();
pendingSendChunks = [];
for (const pkt of copy) sendToStt(pkt);
}

// try to initialize Sarvam streaming (prefer SDK, else raw WS fallback)
async function tryInitSarvamStreaming() {
if (sttSocket || sttReady) return; // already connected

try {
log("Connecting to Sarvam STT via SDK...");

sttSocket = await sarvamClientForTTS.speechToTextStreaming.connect({
model: sttModel,
"language-code": langCode,
high_vad_sensitivity: true,
vad_signals: true,
});

// --- Hook into SDK events ---
if (typeof sttSocket.on === "function") {
sttSocket.on("open", () => {
log("✅ Sarvam SDK STT WebSocket is OPEN");
sttReady = true;
flushPendingToStt();
});

sttSocket.on("transcript", async (evt) => {
const { text, is_final, language_code } = evt || {};
if (!text) return;
log(`📝 Sarvam transcript${is_final ? " (final)" : ""}:`, text);
if (is_final) {
await handleFinalTranscript(text, language_code || "unknown");
}
});

sttSocket.on("speech_start", () => log("🎤 VAD: speech_start"));

sttSocket.on("speech_end", async (evt) => {
const transcript = evt?.text || "";
if (transcript) {
log("🔚 VAD: speech_end ->", transcript);
await handleFinalTranscript(transcript, evt?.language_code || "unknown");
}
});

sttSocket.on("error", (e) => {
errLog("⚠️ Sarvam SDK STT error:", e?.message || e);
sttReady = false;
});

sttSocket.on("close", () => {
log("ℹ️ Sarvam SDK STT closed");
sttReady = false;
sttSocket = null;
});
}
return;
} catch (err) {
warn("SDK streaming attempt failed — falling back to raw WebSocket. Error:", err?.message || err);
}

// Raw WebSocket fallback
try {
const url = `wss://api.sarvam.ai/speech_to_text_streaming?model=${encodeURIComponent(sttModel)}&language_code=${encodeURIComponent(langCode)}&high_vad_sensitivity=true&vad_signals=true`;
log("Connecting raw WebSocket to Sarvam streaming URL:", url);

const headers = { "api-subscription-key": SARVAM_KEY, "Authorization": `Bearer ${SARVAM_KEY}` };
sttSocket = new WebSocket(url, { headers });

sttSocket.on("open", () => {
sttReady = true;
log("✅ Connected to Sarvam streaming STT (raw WS fallback)");
flushPendingToStt();
});

sttSocket.on("message", async (msgRaw) => {
try {
const msgStr = (typeof msgRaw === "string") ? msgRaw : msgRaw.toString();
const msg = JSON.parse(msgStr);
if (msg?.event === "speech_start") {
log("Sarvam VAD: speech_start");
} else if (msg?.event === "speech_end") {
const transcript = msg?.data?.text || "";
if (transcript && transcript.trim().length > 0) {
await handleFinalTranscript(transcript, msg?.data?.language_code || msg?.data?.language || "unknown");
}
} else if (msg?.event === "transcript" || msg?.type === "transcript") {
const isFinal = msg?.data?.is_final || msg?.is_final || msg?.data?.final || false;
const text = msg?.data?.text || msg?.data?.transcript || "";
log(`Sarvam transcript${isFinal ? " (final)" : " (partial)"}:`, text);
if (isFinal && text && text.trim().length > 0) {
await handleFinalTranscript(text, msg?.data?.language_code || msg?.data?.language || "unknown");
}
}
} catch (e) { errLog("Error handling Sarvam message (raw ws):", e); }
});

sttSocket.on("close", (code, reason) => {
log("ℹ️ Sarvam raw WS closed", code, reason && reason.toString ? reason.toString() : reason);
sttReady = false;
sttSocket = null;
});

sttSocket.on("error", (e) => {
errLog("⚠ Sarvam raw WS error:", e && (e.message || e));
sttReady = false;
});
} catch (e) {
errLog("❌ Failed to create raw WebSocket to Sarvam:", e?.message || e);
sttReady = false;
sttSocket = null;
}
} // end tryInitSarvamStreaming

// call to process a final transcript: reply -> tts buffer -> stream into Twilio WS
async function handleFinalTranscript(transcript, sttLang) {
if (Date.now() < (state.ignoreUntil || 0)) {
log("Ignoring transcript because in ignore window");
return;
}
if (state.inFlight) {
log("Already processing a chunk — skipping this final transcript");
return;
}
state.inFlight = true;
try {
const lang = resolveFinalLang(sttLang, transcript);
log("Final language (after heuristics):", lang, " transcript:", transcript);

let aiReply;
try { aiReply = await callDeepSeek(transcript, lang); }
catch (e) { errLog("DeepSeek error:", e); aiReply = (lang==="gu-IN") ? "માફ કરશો, ફરી પૂછો." : (lang==="hi-IN") ? "माफ करें, कृपया फिर पूछें।" : "Sorry, please ask again."; }

// Get TTS audio buffer (WAV PCM16LE, expected 16000)
const ttsBuf = await sarvamTtsGetBuffer(sarvamClientForTTS, aiReply, lang);
if (!ttsBuf) {
errLog("No TTS buffer produced — skipping TTS playback");
} else {
// Optional: save for debugging
try {
const ttsFilename = `tts_${state.callSid || "call"}_${Date.now()}.wav`;
const ttsPath = path.join(audioDir, ttsFilename);
fs.writeFileSync(ttsPath, ttsBuf);
log("Saved TTS (debug) to:", ttsPath);
} catch(e){}

// Parse the WAV to get sample rate and PCM16 payload:
// Quick WAV parse: expect header 44 bytes and PCM16LE format
let headerSampleRate = TTS_SAMPLE_RATE;
try {
// parse sample rate from bytes 24..28 little-endian uint32
headerSampleRate = ttsBuf.readUInt32LE(24);
} catch(e) { headerSampleRate = TTS_SAMPLE_RATE; }

// PCM data usually starts at byte 44; but some WAVs have extra chunks -> find "data" chunk
let dataOffset = 44;
try {
let i = 12;
while (i + 8 < ttsBuf.length) {
const chunkId = ttsBuf.toString('ascii', i, i+4);
const chunkSize = ttsBuf.readUInt32LE(i+4);
if (chunkId === 'data') {
dataOffset = i + 8;
break;
}
i += 8 + chunkSize;
}
} catch(e){ dataOffset = 44; }

const pcm16Data = ttsBuf.slice(dataOffset);
// stream to Twilio WS (downsample inside function if needed)
const streamed = await streamPcm16ToTwilioWs(twilioWs, pcm16Data, headerSampleRate);
if (streamed) {
// compute ignore window to not re-transcribe our own TTS (approx)
const approxPayload = Math.max(0, pcm16Data.length);
const approxSec = approxPayload / (headerSampleRate * 2);
const ignoreMs = Math.ceil((approxSec * 1000) + 350);
state.ignoreUntil = Date.now() + ignoreMs;
} else {
warn("Streaming TTS to Twilio WS failed or WS closed. Falling back to Twilio call update (redirect).");
// fallback: keep existing behavior - update call to play file and reconnect
if (state.callSid) {
try {
const audioUrl = `${NGROK_URL}/audio/${path.basename(ttsFilename)}`;
await updateCallPlayAndReconnect(state.callSid, audioUrl);
log("Played TTS (fallback redirect) and reconnected stream");
} catch (e) {
errLog("Failed fallback update Twilio:", e?.message || e);
}
}
}
}
} catch (e) {
errLog("Error in handleFinalTranscript:", e?.message || e);
} finally {
state.inFlight = false;
}
}

// forward a base64 chunk (incoming Twilio media payload) to Sarvam streaming if ready,
// otherwise buffer pcm for REST STT
async function forwardFrameToSarvamOrBuffer(b64payload) {
const muLawBuf = Buffer.from(b64payload, "base64");
const pcmBuf8k = muLawToPcm16Buffer(muLawBuf);

if (sttReady && sttSocket) {
try {
const pcmBuf16k = resample8kTo16k(pcmBuf8k);
const b64Pcm16k = pcmBuf16k.toString("base64");
const pkt = {
audio: {
data: b64Pcm16k,
sample_rate: 16000,
encoding: "pcm_s16le"
}
};
sendToStt(pkt);
return;
} catch (e) {
warn("Error forwarding to Sarvam streaming - falling back to buffering:", e?.message || e);
}
}

// Buffer locally (for REST fallback)
state.pcmBufferParts.push(pcmBuf8k);
state.pcmBytes += pcmBuf8k.length;

const chunkByteTarget = Math.ceil(CHUNK_SECONDS * state.sampleRate * 2);
if (state.pcmBytes >= chunkByteTarget && !state.inFlight) {
const combined = Buffer.concat(state.pcmBufferParts, state.pcmBytes);
state.pcmBufferParts = [];
state.pcmBytes = 0;

const { transcript, langCode } = await sarvamRestSttFromPcm(combined, state.sampleRate);
if (transcript && transcript.trim().length > 0) {
await handleFinalTranscript(transcript, langCode);
}
}
}

// WSS message handler (from Twilio)
ws.on("message", async (raw) => {
try {
const parsed = JSON.parse(raw.toString());
if (!parsed || !parsed.event) return;

if (parsed.event === "start") {
const s = parsed.start || {};
state.callSid = s.call_sid || s.callSid || parsed.start?.callSid || parsed.start?.call_sid || null;
if (s.media) {
state.sampleRate = parseInt(s.media.sample_rate) || TWILIO_SAMPLE_RATE;
state.channels = parseInt(s.media.channels) || 1;
} else {
state.sampleRate = TWILIO_SAMPLE_RATE;
state.channels = 1;
}
log("WS start — callSid:", state.callSid, "sampleRate:", state.sampleRate);
tryInitSarvamStreaming();
return;
}

if (parsed.event === "media") {
if (Date.now() < (state.ignoreUntil || 0)) return;
if (!parsed.media || !parsed.media.payload) return;
const b64 = parsed.media.payload;
await forwardFrameToSarvamOrBuffer(b64);
return;
}

if (parsed.event === "stop") {
log("⏹ Stream stop for call:", state.callSid);
if (state.pcmBytes > 0 && !state.inFlight) {
const combined = Buffer.concat(state.pcmBufferParts, state.pcmBytes);
state.pcmBufferParts = [];
state.pcmBytes = 0;
const { transcript, langCode } = await sarvamRestSttFromPcm(combined, state.sampleRate);
if (transcript && transcript.trim().length > 0) {
await handleFinalTranscript(transcript, langCode);
}
}
if (sttSocket && typeof sttSocket.close === "function") {
try { sttSocket.close(); } catch (e) {}
}
return;
}
} catch (e) {
errLog("Error on incoming WS message:", e?.message || e);
}
});

ws.on("close", () => {
log("❌ Twilio stream closed for call:", state.callSid);
if (sttSocket && typeof sttSocket.close === "function") {
try { sttSocket.close(); } catch (e) {}
}
});

ws.on("error", (e) => {
errLog("WS error:", e);
if (sttSocket && typeof sttSocket.close === "function") {
try { sttSocket.close(); } catch (err) {}
}
});

}); // end wss.on connection

// Global unhandled rejection handler to avoid node crash
process.on("unhandledRejection", (reason) => {
errLog("UnhandledPromiseRejection:", reason);
});

// start server
server.listen(PORT, () => {
log(`✅ Real-time server listening on http://localhost:${PORT}`);
if (NGROK_URL) log(`✅ /answer TwiML endpoint should be set at ${NGROK_URL}/answer`);
else log("⚠ NGROK_URL not set in .env — set it to your public HTTPS tunnel URL so Twilio can reach /answer");
});