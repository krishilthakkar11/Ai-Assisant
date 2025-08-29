import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const accountSid  = process.env.TWILIO_SID;
const authToken   = process.env.TWILIO_AUTH;
const fromNumber  = process.env.TWILIO_NUMBER; // Twilio number (E.164 format)
const toNumber    = process.env.MY_PHONE;      // Your phone number (E.164)
const ngrok       = (process.env.NGROK_URL || "").replace(/\/+$/, ""); // remove trailing slash
const answerUrl   = `${ngrok}/answer`;  // Twilio will call this

const client = twilio(accountSid, authToken);

(async () => {
  try {
    console.log("Dialing with TwiML URL:", answerUrl);
    const call = await client.calls.create({
      to: toNumber,
      from: fromNumber,
      url: answerUrl,   // points to Sarvam /answer endpoint
      method: "GET"
    });
    console.log("📞 Call initiated:", call.sid);
  } catch (err) {
    console.error("❌ Error making call:", err);
  }
})();