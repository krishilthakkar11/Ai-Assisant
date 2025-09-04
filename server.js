// server.js
import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { SarvamAIClient } from "sarvamai"; // sarvam SDK
dotenv.config();

const PORT = process.env.PORT || 3000;
const NGROK_URL = process.env.NGROK_URL; // e.g. "https://abc-123.ngrok.io"
const STREAM_URL_OVERRIDE = process.env.STREAM_URL; // optional override (must be wss://...)

// helper to build stream URL, enforce wss://
function buildStreamUrl() {
if (STREAM_URL_OVERRIDE) {
return STREAM_URL_OVERRIDE; // assume user gave proper wss:// URL
}
if (!NGROK_URL) {
throw new Error("NGROK_URL or STREAM_URL must be set in .env");
}
if (!/^https?:\/\//i.test(NGROK_URL)) {
throw new Error("NGROK_URL must start with http:// or https://");
}
return NGROK_URL.replace(/^http/i, "ws") + "/media"; // https -> wss
}

const app = express();
// Twilio will request /answer (GET or POST), and then open a WebSocket to the `url` we return.
app.use(express.urlencoded({ extended: true }));

// Accept GET/POST so you can test /answer in a browser easily
app.all("/answer", (req, res) => {
try {
const streamUrl = buildStreamUrl();
console.log("TwiML /answer returning stream URL:", streamUrl);
const twiml = new twilio.twiml.VoiceResponse();
const start = twiml.start();
start.stream({ name: "media", url: streamUrl });
twiml.say("AI assistant connected. You can speak after the beep. Press star to end.");
twiml.pause({ length: 60 });
res.type("text/xml").send(twiml.toString());
} catch (err) {
console.error("Error building stream URL:", err.message);
res.status(500).send("Server misconfiguration: " + err.message);
}
});

// create HTTP server & attach WS upgrade handling
const server = app.listen(PORT, () => {
console.log(`🚀 HTTP server listening on :${PORT}`);
try { console.log("Using stream URL:", buildStreamUrl()); } catch(_) {}
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
// only accept ws upgrades on /media
if (req.url && req.url.startsWith("/media")) {
wss.handleUpgrade(req, socket, head, (ws) => {
wss.emit("connection", ws, req);
});
} else {
socket.destroy();
}
});

// Sarvam client factory
function makeSarvamClient() {
const key = process.env.SARVAM_API_KEY;
if (!key) throw new Error("SARVAM_API_KEY missing in .env");
return new SarvamAIClient({ apiSubscriptionKey: key });
}

// --- WebSocket connection per Twilio media stream ---
wss.on("connection", async (twilioWs) => {
console.log("🔌 Twilio media socket connected");

const sarvam = makeSarvamClient();
let stt;
let sttOpen = false;
const buffer = [];

// create STT socket (one per call)
try {
stt = await sarvam.speechToTextStreaming.connect({
model: "saarika:v2.5",
"language-code": "en-IN",
debug: false,
});
} catch (e) {
console.error("Failed to connect Sarvam STT socket:", e);
twilioWs.close();
return;
}

// wait for stt to be open and then flush buffer
stt.on("open", () => {
console.log("✅ Sarvam STT socket open");
sttOpen = true;
// flush any buffered media frames
while (buffer.length) {
const evt = buffer.shift();
try { handleMediaEvent(evt); } catch (e) { console.warn("flush error", e); }
}
});

stt.on("message", (msg) => {
// msg is already JSON parsed by SDK wrapper
console.log("📩 Sarvam:", msg);
if (msg?.type === "data") {
console.log("📝 Transcript:", msg.data?.transcript);
}
});
stt.on("error", (e) => console.error("⚠ Sarvam error:", e));
stt.on("close", () => console.log("🔒 Sarvam STT closed"));

// twilio messages
twilioWs.on("message", async (raw) => {
let evt;
try { evt = JSON.parse(raw.toString()); } catch (e) { return; }

if (evt.event === "media") {
if (!sttOpen) {
buffer.push(evt);
} else {
handleMediaEvent(evt);
}
} else if (evt.event === "start") {
console.log("RWS> start", evt.start?.callSid || "");
} else if (evt.event === "stop") {
console.log("RWS> stop");
try { stt.sendJson({ event: "end" }); } catch {}
try { stt.close(); } catch {}
try { twilioWs.close(); } catch {}
}
});

twilioWs.on("close", () => {
console.log("🔌 Twilio socket closed");
try { stt.sendJson({ event: "end" }); } catch {}
try { stt.close(); } catch {}
});

// ---- helpers ----
function handleMediaEvent(evt) {
const payloadB64 = evt?.media?.payload;
if (!payloadB64) return;
const mu = Buffer.from(payloadB64, "base64"); // µ-law bytes
const pcm8 = muLawToPCM16(mu); // Int16Array
const pcm16 = upsample2xInt16(pcm8); // Int16Array @ 16k (simple duplication)
const audioBase64 = Buffer.from(pcm16.buffer).toString("base64");

try {
stt.transcribe({
  audio: audioBase64,
  sample_rate: 16000,
  input_audio_codec: "pcm_s16le",
});
} catch (err) {
console.error("Error calling stt.transcribe:", err && err.message ? err.message : err);
}
}

// mu-law -> PCM16 (Int16Array)
function muLawToPCM16(muBuf) {
const out = new Int16Array(muBuf.length);
for (let i = 0; i < muBuf.length; i++) out[i] = mulawDecodeSample(muBuf[i]);
return out;
}
function mulawDecodeSample(muLawByte) {
const MULAW_MAX = 0x1FFF;
const MULAW_BIAS = 33;
muLawByte = ~muLawByte;
const sign = (muLawByte & 0x80) ? -1 : 1;
const exponent = (muLawByte & 0x70) >> 4;
const mantissa = muLawByte & 0x0F;
const sample = ((mantissa << 3) + MULAW_BIAS) << (exponent + 2);
return sign * (sample > MULAW_MAX ? MULAW_MAX : sample);
}
// simple upsampler (8k -> 16k) by duplicate — easy, low-complexity
function upsample2xInt16(int16) {
const out = new Int16Array(int16.length * 2);
for (let i = 0; i < int16.length; i++) {
out[2 * i] = int16[i];
out[2 * i + 1] = int16[i];
}
return out;
}
});