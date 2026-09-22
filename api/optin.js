// Local Roofing & Construction — SMS lead-alert opt-in recorder
// Vercel Serverless Function — /api/optin
//
// Receives the signed enrollment form from arkansaslocalroofing.com/sms-consent,
// emails a timestamped consent record (with the drawn signature attached) to the
// business + The Watson Factor, and sends the opt-in confirmation text.
// The emailed record is the audit trail carriers can ask for (10DLC).

import nodemailer from "nodemailer";

const ALLOWED_ORIGINS = [
  "https://www.arkansaslocalroofing.com",
  "https://arkansaslocalroofing.com",
];

const CONFIRMATION_TEXT =
  "Local Roofing & Construction: You are enrolled in new-lead alerts from your AI receptionist. " +
  "Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

const CONSENT_LANGUAGE =
  "By checking this box and signing below, I agree to receive automated text messages from " +
  "Local Roofing & Construction at the mobile number above with new-lead notifications from our " +
  "AI answering service (caller name, address, job type, urgency, and callback number). Message " +
  "frequency varies with call volume. Message and data rates may apply. Reply HELP for help or " +
  "STOP to opt out at any time. Consent is not a condition of purchase.";

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function toE164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const name = String(b.name || "").trim().slice(0, 120);
  const phone = toE164(b.phone);
  const signature = String(b.signature || "");

  if (!name) return res.status(400).json({ ok: false, error: "Please enter your full name." });
  if (!phone) return res.status(400).json({ ok: false, error: "Please enter a valid 10-digit mobile number." });
  if (b.agreed !== true) return res.status(400).json({ ok: false, error: "Please check the consent box." });
  if (!signature.startsWith("data:image/png;base64,") || signature.length < 1500)
    return res.status(400).json({ ok: false, error: "Please sign in the signature box." });
  if (signature.length > 600000) return res.status(400).json({ ok: false, error: "Signature image too large." });

  const record = {
    name,
    phone,
    consentLanguage: CONSENT_LANGUAGE,
    confirmationText: CONFIRMATION_TEXT,
    formDate: String(b.date || "").slice(0, 20),
    submittedAtUTC: new Date().toISOString(),
    ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown",
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    pageUrl: String(b.pageUrl || req.headers.referer || "").slice(0, 300),
  };
  console.log("SMS opt-in received:", JSON.stringify(record));

  const [email, sms] = await Promise.allSettled([emailRecord(record, signature), sendConfirmation(phone)]);
  const result = {
    ok: email.status === "fulfilled",
    emailed: email.status === "fulfilled" ? "yes" : `failed: ${email.reason?.message || email.reason}`,
    confirmationText: sms.status === "fulfilled" ? "queued" : `failed: ${sms.reason?.message || sms.reason}`,
  };
  console.log("Opt-in result:", JSON.stringify(result));
  if (!result.ok) return res.status(500).json({ ok: false, error: "Could not record your enrollment. Please try again." });
  return res.status(200).json({ ok: true });
}

async function emailRecord(r, signatureDataUrl) {
  const user = process.env.SMTP_USER || "daniel@thewatsonfactor.dev";
  const to = [process.env.ALERT_EMAIL || "ARlocalroofing@gmail.com", user].join(", ");
  const dryRun = process.env.EMAIL_DRY_RUN === "1";
  if (!process.env.SMTP_PASS && !dryRun) throw new Error("SMTP_PASS not set");

  const text = [
    "SMS LEAD-ALERT CONSENT RECORD — keep for carrier (10DLC) compliance",
    "",
    `Name: ${r.name}`,
    `Mobile number: ${r.phone}`,
    `Consent checkbox: checked`,
    `Date on form: ${r.formDate}`,
    `Submitted (UTC): ${r.submittedAtUTC}`,
    `IP address: ${r.ip}`,
    `Browser: ${r.userAgent}`,
    `Form URL: ${r.pageUrl}`,
    "",
    "Consent language shown:",
    r.consentLanguage,
    "",
    "Confirmation text sent:",
    r.confirmationText,
    "",
    "Signature: attached (signature.png)",
  ].join("\n");

  const transport = dryRun
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: process.env.SMTP_HOST || "mail.privateemail.com",
        port: Number(process.env.SMTP_PORT || 465),
        secure: Number(process.env.SMTP_PORT || 465) === 465,
        auth: { user, pass: process.env.SMTP_PASS },
      });

  await transport.sendMail({
    from: `"Local Roofing & Construction — Consent Records" <${user}>`,
    to,
    subject: `SMS consent record: ${r.name} (${r.phone}) — ${r.submittedAtUTC.slice(0, 10)}`,
    text,
    attachments: [
      { filename: "signature.png", content: signatureDataUrl.split(",")[1], encoding: "base64" },
    ],
  });
  if (dryRun) console.log("EMAIL DRY RUN (consent record):", text);
}

async function sendConfirmation(to) {
  const from = process.env.FROM_NUMBER;
  if (!from || !process.env.TELNYX_API_KEY) throw new Error("FROM_NUMBER or TELNYX_API_KEY missing");
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text: CONFIRMATION_TEXT }),
  });
  if (!r.ok) throw new Error(`Telnyx SMS failed (${r.status}): ${await r.text()}`);
  return r.json();
}
