// final3.js (integrated version)
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import express from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { SarvamAIClient } from "sarvamai";
import mime from "mime-types";
import { franc } from "franc";

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  const mod = await import("node-fetch");
  fetchFn = mod.default;
}

// -------- ENV & CONSTANTS --------
const PORT = process.env.PORT || 3000;
const NGROK_URL = process.env.NGROK_URL;
const STREAM_URL_OVERRIDE = process.env.STREAM_URL;
const SARVAM_KEY = process.env.SARVAM_API_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";

const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL || "saarika:v2.5";
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v2";
const SARVAM_TTS_VOICE = process.env.SARVAM_TTS_VOICE || "anushka";

// 🔒 Language lock strictness (0 = always update, 1 = moderate, 2 = strict)
const LANG_LOCK_STRICTNESS = parseInt(process.env.LANG_LOCK_STRICTNESS || "1", 10);

if (!SARVAM_KEY) throw new Error("Missing SARVAM_API_KEY in .env");
if (!TWILIO_SID || !TWILIO_AUTH) throw new Error("Missing Twilio creds in .env");
if (!NGROK_URL && !STREAM_URL_OVERRIDE) throw new Error("Set NGROK_URL or STREAM_URL in .env");

const PUBLIC_DIR = path.join(process.cwd(), "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

// ----------------- helpers -----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function buildStreamUrl() {
  if (STREAM_URL_OVERRIDE) return STREAM_URL_OVERRIDE;
  if (!/^https?:\/\//i.test(NGROK_URL)) throw new Error("NGROK_URL must start with http(s)://");
  return NGROK_URL.replace(/^http/i, "ws") + "/media";
}
function buildAnswerUrl() {
  return NGROK_URL.replace(/\/+$/, "") + "/answer";
}
function makeSarvamClient() {
  return new SarvamAIClient({ apiSubscriptionKey: SARVAM_KEY });
}

// --- audio decode helpers ---
function mulawDecodeSample(muLawByte) {
  const MULAW_MAX = 0x1FFF, MULAW_BIAS = 33;
  muLawByte = ~muLawByte & 0xff;
  const sign = (muLawByte & 0x80) ? -1 : 1;
  const exponent = (muLawByte & 0x70) >> 4;
  const mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << (exponent + 2);
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  return sign * sample;
}
function muLawToPCM16(muBuf) {
  const out = new Int16Array(muBuf.length);
  for (let i = 0; i < muBuf.length; i++) out[i] = mulawDecodeSample(muBuf[i]);
  return out;
}
function upsample2xInt16(int16) {
  const out = new Int16Array(int16.length * 2);
  for (let i = 0; i < int16.length; i++) {
    out[2 * i] = int16[i];
    out[2 * i + 1] = int16[i];
  }
  return out;
}

// ---- Language detection (improved + lock) ----
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
  if (lc.startsWith("or") || lc.startsWith("od")) return "od-IN";
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
  if (francLang === "pan") return "pa-IN";
  return "en-IN";
}
const romanGujaratiRe = /\b(kem|cho|maja|majama|tame|tamne|shu|su|mane|hu|maru|bhai|barabar|krupaya|dhanyavaad)\b/i;
const romanHindiRe = /\b(aap|aapka|kaise|naam|namaste|shukriya|haan|nahi|kya|kyu|kyun|theek|thik|bahut|kripya|dhanyavad)\b/i;

let lastConfirmedLang = "en-IN";

function resolveFinalLang(sttLangCode, transcript) {
  const scriptGu = /[\u0A80-\u0AFF]/.test(transcript);
  const scriptHi = /[\u0900-\u097F]/.test(transcript);
  let lang = normalizeLangCode(sttLangCode);

  if (scriptGu) lang = "gu-IN";
  if (scriptHi) lang = "hi-IN";
  if (lang === "en-IN") {
    if (romanGujaratiRe.test(transcript)) lang = "gu-IN";
    if (romanHindiRe.test(transcript)) lang = "hi-IN";
  }
  if (!lang || lang === "unknown") lang = detectLanguageLocal(transcript);

  // 🔒 Apply language lock strictness
  if (LANG_LOCK_STRICTNESS === 0) {
    lastConfirmedLang = lang;
  } else if (LANG_LOCK_STRICTNESS === 1) {
    lastConfirmedLang = lang;
  } else if (LANG_LOCK_STRICTNESS >= 2) {
    if (lang === normalizeLangCode(sttLangCode)) {
      lastConfirmedLang = lang;
    } // else stick with old
  }
  return lastConfirmedLang;
}

// --- DeepSeek + TTS ---
// (keep your existing DeepSeek + TTS code unchanged, just ensure they use finalLang = resolveFinalLang)
// ---- DeepSeek chat (short replies, same language) ----
async function callDeepSeek(userText, langCode = "en-IN") {
if (!DEEPSEEK_KEY) {
return (langCode === "gu-IN") ? "માફ કરશો, ફરી કહેવું." : "Sorry, please say that again.";
}
const messages = [
{ role: "system", content: `You are an AI phone assistant. The caller speaks in ${langCode}. Reply ONLY in ${langCode}. Keep it short (1 sentence, <20 words).` },
{ role: "user", content: userText }
];
const res = await fetchFn("https://api.deepseek.com/v1/chat/completions", {
method: "POST",
headers: {
"Authorization": `Bearer ${DEEPSEEK_KEY}`,
"Content-Type": "application/json"
},
body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, temperature: 0.25, max_tokens: 80 })
});
if (!res.ok) {
const txt = await res.text().catch(() => "");
console.warn("DeepSeek error:", res.status, txt);
return (langCode === "gu-IN") ? "માફ કરશો, ફરી પૂછો." : "Sorry, please say that again.";
}
const json = await res.json().catch(() => ({}));
const reply = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "";
return (reply || "Sorry, please ask again.")
.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
.replace(/[\uD800-\uDFFF]/g, "");
}

// ---- TTS: generate MP3 and return public URL (robust) ----
async function generateTTSFile(callSid, text, opts = {}) {
// create client/socket per TTS request
const client = new SarvamAIClient({ apiSubscriptionKey: SARVAM_KEY });
// prefer env-provided model
const socket = await client.textToSpeechStreaming.connect({ model: SARVAM_TTS_MODEL || "bulbul:v2" });
await socket.waitForOpen();

// configure connection (some SDK wrappers use configureConnection, some use configure)
const cfg = {
type: "config",
data: {
speaker: opts.speaker || SARVAM_TTS_VOICE || "anushka",
target_language_code: opts.lang || "en-IN",
pitch: opts.pitch ?? 0.9,
pace: opts.pace ?? 1.0,
min_buffer_size: opts.min_buffer_size ?? 10,
max_chunk_length: opts.max_chunk_length ?? 250,
output_audio_codec: opts.output_audio_codec || "mp3",
output_audio_bitrate: opts.output_audio_bitrate || "128k"
}
};
try {
if (socket.configureConnection) socket.configureConnection(cfg);
else if (socket.configure) await socket.configure(cfg.data);
} catch (e) {
// non-fatal
console.warn("TTS configure warning:", e?.message || e);
}

const fname = `tts_${callSid}_${Date.now()}.mp3`;
const outPath = path.join(PUBLIC_DIR, fname);
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
const outStream = fs.createWriteStream(outPath, { flags: "a" });

return new Promise(async (resolve, reject) => {
let gotAnyAudio = false;

const onMessage = (msg) => {
try {
if (msg?.type === "audio" && msg?.data?.audio) {
const buf = Buffer.from(msg.data.audio, "base64");
gotAnyAudio = true;
outStream.write(buf);
}
} catch (e) {
console.warn("TTS chunk write error:", e);
}
};

// attach listeners
socket.on("message", onMessage);

socket.on("error", (err) => {
console.error("TTS socket error:", err);
try { socket.removeListener?.("message", onMessage); } catch {}
try { outStream.end(); } catch {}
reject(err);
});

socket.on("close", async () => {
try { socket.removeListener?.("message", onMessage); } catch {}
try { outStream.end(); } catch {}
await sleep(50); // ensure fs flushed
const statOk = fs.existsSync(outPath) && fs.statSync(outPath).size > 0 && gotAnyAudio;
if (!statOk) {
reject(new Error("TTS file is empty (no audio chunks received)"));
return;
}
const publicUrl = `${NGROK_URL.replace(/\/+$/, "")}/tts/${encodeURIComponent(fname)}`;
resolve(publicUrl);
});

// send text for conversion
try {
if (socket.convert) socket.convert(text);
else if (socket.sendJson) socket.sendJson({ type: "convert", data: { text } });
} catch (e) {
console.warn("TTS convert call failed:", e);
}

// try flush if available
try { if (socket.flush) await socket.flush(); } catch (_) {}

// fallback close after short grace period (allow streaming to finish)
setTimeout(() => {
try { if (socket?.close) socket.close(); } catch (e) { /* ignore */ }
}, opts.closeAfterMs ?? 1800);
});
}

// ---- verify URL is publicly reachable (HEAD + content-type) ----
async function verifyUrlIsAudio(url, attempts = 3, delayMs = 300) {
for (let i = 0; i < attempts; ++i) {
try {
const res = await fetchFn(url, { method: "HEAD" });
if (res && res.ok) {
const ct = (res.headers.get("content-type") || "").toLowerCase();
if (ct.includes("audio") || ct.includes("mpeg") || ct.includes("wav") || ct.includes("audio/")) {
return true;
} else {
console.warn("verifyUrlIsAudio: content-type not audio:", ct);
return false;
}
} else {
console.warn("verifyUrlIsAudio attempt", i, "status", res?.status);
}
} catch (e) {
console.warn("verifyUrlIsAudio error:", e?.message || e);
}
await sleep(delayMs);
}
return false;
}

// ---------------- Express app ----------------
const app = express();
app.use(express.urlencoded({ extended: true }));

// static files and set Content-Type via mime
app.use(express.static(PUBLIC_DIR, {
setHeaders: (res, filePath) => {
const type = mime.lookup(filePath) || "application/octet-stream";
res.setHeader("Content-Type", type);
}
}));

// Explicit, robust file serving endpoint: supports HEAD + Range
app.get("/tts/:file", (req, res) => {
try {
const raw = req.params.file;
const filename = decodeURIComponent(raw);
const filePath = path.join(PUBLIC_DIR, filename);
if (!fs.existsSync(filePath)) {
return res.status(404).send("Not found");
}
const stat = fs.statSync(filePath);
const total = stat.size;
const contentType = mime.lookup(filePath) || "application/octet-stream";
res.setHeader("Content-Type", contentType);
res.setHeader("Accept-Ranges", "bytes");

const range = req.headers.range;
if (!range) {
res.setHeader("Content-Length", total);
if (req.method === "HEAD") return res.status(200).end();
const stream = fs.createReadStream(filePath);
stream.pipe(res);
stream.on("error", (err) => {
console.error("stream error", err);
try { res.destroy(err); } catch {}
});
} else {
const parts = range.replace(/bytes=/, "").split("-");
const start = parseInt(parts[0], 10);
const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
res.setHeader("Content-Range", `bytes */${total}`);
return res.status(416).end();
}
res.status(206);
res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
res.setHeader("Content-Length", (end - start) + 1);
const stream = fs.createReadStream(filePath, { start, end });
stream.pipe(res);
stream.on("error", (err) => {
console.error("range stream error", err);
try { res.destroy(err); } catch {}
});
}
} catch (e) {
console.error("tts route error", e);
res.status(500).send("Server error");
}
});

// /answer
app.all("/answer", (req, res) => {
  const streamUrl = buildStreamUrl();
  console.log("TwiML /answer returning stream URL:", streamUrl);

  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({ name: "media", url: streamUrl, track: "inbound_track" });

  // Only say greeting if no ?redirect=1
  if (!req.query.redirect) {
    twiml.say("AI assistant connected.");
  }

  // Keep call open
  twiml.pause({ length: 600 });

  res.type("text/xml").send(twiml.toString());
});

// Server & WS handling
const server = app.listen(PORT, () => {
console.log(`🚀 HTTP server listening on :${PORT}`);
try { console.log("Using stream URL:", buildStreamUrl()); } catch (_) {}
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
if (req.url && req.url.startsWith("/media")) {
wss.handleUpgrade(req, socket, head, (ws) => {
wss.emit("connection", ws, req);
});
} else {
socket.destroy();
}
});

// Per-call handler
wss.on("connection", async (twilioWs) => {
console.log("🔌 Twilio media socket connected");
const sarvam = makeSarvamClient();

let callSid = null;
let stt = null;
let sttOpen = false;
let replying = false;

// create STT socket using env-driven model
try {
stt = await sarvam.speechToTextStreaming.connect({
model: SARVAM_STT_MODEL,
"language-code": "unknown", // prefer auto-detect
debug: false,
});
} catch (e) {
console.error("❌ Failed to connect STT:", e);
twilioWs.close();
return;
}

stt.on("open", () => { console.log("✅ STT socket open"); sttOpen = true; });
stt.on("close", () => { console.log("🔒 STT closed"); sttOpen = false; });
stt.on("error", (e) => console.error("⚠ STT error:", e));

// STT message handler
stt.on("message", async (msg) => {
try {
const transcript = (msg?.data?.transcript) || (msg?.transcript) || (msg?.text) || "";
if (!transcript || !transcript.trim()) return;
const clean = transcript.trim();
console.log("📝 Transcript:", clean);

// Determine final language: use Sarvam's language_code then resolve with heuristics
const sarvamLang = msg?.data?.language_code || "unknown";
const finalLang = resolveFinalLang(sarvamLang, clean);
console.log("🧭 Sarvam lang:", sarvamLang, "→ Final lang:", finalLang);

if (!callSid) {
console.warn("No callSid yet; skipping reply");
return;
}
if (replying) return;

replying = true;
try {
// 1) LLM reply in finalLang
const dsReply = await callDeepSeek(clean, finalLang);
console.log("🤖 DeepSeek:", dsReply);

// 2) TTS: use finalLang
const ttsUrl = await generateTTSFile(callSid, dsReply, { lang: finalLang });
console.log("🔊 TTS ready:", ttsUrl);

// 3) Verify audio HEAD (content-type + reachable)
const ok = await verifyUrlIsAudio(ttsUrl, 4, 300);
if (!ok) {
console.error("TTS URL not reachable or not audio. Aborting play:", ttsUrl);
} else {
const playTwiml = `<Response>
  <Play>${ttsUrl}</Play>
  <Redirect method="POST">${buildAnswerUrl()}?redirect=1</Redirect>
</Response>`;
try {
await twilioClient.calls(callSid).update({ twiml: playTwiml });
console.log("📤 Played TTS on call");
} catch (err) {
console.error("Failed to redirect/play on Twilio call:", err?.message || err);
}
}
} catch (e) {
console.error("Reply error:", e);
} finally {
replying = false;
}
} catch (outerErr) {
console.error("STT message handler error:", outerErr);
}
});

// Twilio media websocket handler
twilioWs.on("message", (raw) => {
let evt;
try { evt = JSON.parse(raw.toString()); } catch { return; }

if (evt.event === "start") {
callSid = evt.start?.callSid;
console.log("RWS> start", callSid);
return;
}

if (evt.event === "media" && sttOpen) {
// inbound only guard (track name may be inbound_track or inbound)
const track = evt.media?.track;
if (track && !track.toLowerCase().includes("inbound")) return;

const mu = Buffer.from(evt.media?.payload || "", "base64");
const pcm8 = muLawToPCM16(mu);
const pcm16 = upsample2xInt16(pcm8);
const audioBase64 = Buffer.from(pcm16.buffer).toString("base64");
try {
stt.transcribe({
audio: audioBase64,
sample_rate: 16000,
input_audio_codec: "pcm_s16le"
});
} catch (e) {
console.error("Error sending audio to STT:", e);
}
return;
}

if (evt.event === "stop") {
console.log("RWS> stop");
try { stt.sendJson?.({ event: "end" }); } catch {}
try { stt.close(); } catch {}
try { twilioWs.close(); } catch {}
}
});

twilioWs.on("close", () => {
console.log("🔌 Twilio socket closed");
try { stt.close(); } catch {}
});

twilioWs.on("error", (e) => {
console.error("Twilio WS error:", e);
try { stt.close(); } catch {}
});
});
