// Arkansas Local Roofing — AI Receptionist Lead Alerts
// Vercel Serverless Function — /api/lead
//
// Flow: caller → Alex (Telnyx AI assistant) → call ends → Telnyx runs the
// "Arkansas Roofing Lead Capture" insight → webhook `call.conversation_insights.generated`
// hits this function → we look up the caller's number → alert Chris by EMAIL and SMS.
//
// Env vars (Vercel → Settings → Environment Variables):
//   TELNYX_API_KEY   Telnyx API key (SMS + caller lookup)
//   FROM_NUMBER      +15012329111  (SMS only delivers once 10DLC is approved)
//   CHRIS_NUMBER     +15013525737
//   SMTP_PASS        password for the sending mailbox (REQUIRED for email)
//   SMTP_USER        default daniel@thewatsonfactor.dev
//   SMTP_HOST        default mail.privateemail.com (Namecheap Private Email)
//   SMTP_PORT        default 465
//   ALERT_EMAIL      default ARlocalroofing@gmail.com (comma-separate for more)
//   ALLOWED_CONNECTION_ID (optional) ignore events from other Telnyx apps
//   EMAIL_DRY_RUN    (optional, "1") log the email instead of sending
//   ALERT_ON_INSIGHT_WEBHOOK (optional, "1") alert on direct insight webhooks instead

import nodemailer from "nodemailer";

const TELNYX = "https://api.telnyx.com/v2";

// Insight polling can take ~40s; allow the function time to finish.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Arkansas Local Roofing — Lead alerts active ✅");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = req.body || {};
  const eventType =
    body?.data?.event_type || body?.event_type || (body?.CallStatus ? `texml.${body.CallStatus}` : "unknown");
  console.log("Webhook received:", eventType, JSON.stringify(body).slice(0, 1500));

  // PRIMARY TRIGGER: the TeXML "conversation_ended" callback (form-encoded, always delivered).
  // It carries the ConversationId; we then pull the lead-capture insight from the Telnyx API.
  // (The insight-group webhook proved unreliable for TeXML calls, so it is NOT used to alert —
  //  set ALERT_ON_INSIGHT_WEBHOOK=1 only if you disable this path, or leads will double-alert.)
  let insight = null;
  if (body.CallStatus === "conversation_ended" && body.ConversationId) {
    insight = await insightFromConversation(body.ConversationId, body.Messages);
  } else if (process.env.ALERT_ON_INSIGHT_WEBHOOK === "1") {
    insight = extractInsight(body);
  }
  if (!insight) {
    // Other call-status callbacks (completed, recording, etc.): log only.
    return res.status(200).json({ ok: true, action: "ignored", eventType });
  }

  const allowed = process.env.ALLOWED_CONNECTION_ID;
  const connId = insight.connectionId || body.ConnectionId;
  if (allowed && connId && String(connId) !== String(allowed)) {
    console.log("Ignoring event from other connection:", connId);
    return res.status(200).json({ ok: true, action: "ignored-other-connection" });
  }

  const callerNumber = insight.callerNumber || (await lookupCaller(insight)) || "Unknown";
  const lead = parseLead(insight.text);
  const header = leadHeader(insight.text, lead);

  // Email and SMS run independently — one failing never blocks the other.
  const [email, sms] = await Promise.allSettled([
    sendEmail(header, callerNumber, lead, insight.text),
    sendSMS(process.env.CHRIS_NUMBER, process.env.FROM_NUMBER, buildSms(header, callerNumber, insight.text)),
  ]);

  const result = {
    ok: email.status === "fulfilled" || sms.status === "fulfilled",
    caller: callerNumber,
    email: email.status === "fulfilled" ? email.value : `failed: ${email.reason?.message || email.reason}`,
    sms: sms.status === "fulfilled" ? sms.value?.data?.id || "queued" : `failed: ${sms.reason?.message || sms.reason}`,
  };
  console.log("Alert result:", JSON.stringify(result));
  // Always 200 so Telnyx doesn't retry and double-alert.
  return res.status(200).json(result);
}

// ─── Pull the lead insight for a finished conversation ────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insightFromConversation(conversationId, messagesJson) {
  const auth = { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } };
  const id = encodeURIComponent(conversationId);

  // Caller number from the conversation record
  let callerNumber = null;
  try {
    const r = await fetch(`${TELNYX}/ai/conversations?id=eq.${id}&limit=1`, auth);
    if (r.ok) callerNumber = (await r.json())?.data?.[0]?.metadata?.from || null;
  } catch (e) {
    console.error("Conversation lookup failed:", e?.message || e);
  }

  // Insights finish a few seconds after the call ends — poll for up to ~40s.
  for (let i = 0; i < 14; i++) {
    try {
      const r = await fetch(`${TELNYX}/ai/conversations/${id}/conversations-insights`, auth);
      if (r.ok) {
        const done = ((await r.json())?.data || []).filter((d) => d.status === "completed");
        const text = done
          .flatMap((d) => d.conversation_insights || [])
          .map((x) => (x.result || "").trim())
          .filter(Boolean)
          .join("\n\n");
        if (text) return { text, callerNumber };
      }
    } catch (e) {
      console.error("Insight fetch failed:", e?.message || e);
    }
    await sleep(3000);
  }

  // Fallback: no insight yet — still alert Chris with the tail of the transcript.
  let transcript = "";
  try {
    transcript = JSON.parse(messagesJson || "[]")
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "Caller" : "Alex"}: ${m.content}`)
      .join("\n")
      .slice(-900);
  } catch {}
  console.log("No insight after polling; sending transcript fallback");
  return {
    text: `Notes: Lead summary was not ready — call transcript excerpt below.\n\n${transcript || "(no transcript)"}`,
    callerNumber,
  };
}

// ─── Parse a direct insight webhook (only used with ALERT_ON_INSIGHT_WEBHOOK=1) ─
function extractInsight(body) {
  const data = body?.data || {};
  const p = data?.payload || {};

  // Telnyx format: call.conversation_insights.generated
  if (Array.isArray(p.results) && p.results.length) {
    return {
      text: p.results.map((r) => (r.result || "").trim()).filter(Boolean).join("\n\n"),
      callControlId: p.call_control_id,
      callLegId: p.call_leg_id,
      connectionId: p.connection_id,
      callerNumber: p.from || p.caller_id || null,
    };
  }

  // Alternate shape: { data: { insights: [...], conversation: {...} } }
  const insights = data.insights || body.insights;
  if (Array.isArray(insights) && insights.length) {
    return {
      text: insights.map((i) => (i.result || i.content || "").trim()).filter(Boolean).join("\n\n"),
      callerNumber: data?.conversation?.from || data?.conversation?.metadata?.from || null,
      callControlId: data?.conversation?.metadata?.call_control_id,
    };
  }
  return null;
}

// "Name: X\nAddress: Y ..." → { Name: "X", Address: "Y", ... }
function parseLead(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*[-*]?\s*([A-Za-z ]{3,20}):\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function leadHeader(text, lead) {
  const noInfo = /not given/i.test(lead.Name || "") && /not given/i.test(lead.Address || "");
  // "Non-urgent" contains the word "urgent" — only match when Urgency STARTS with urgent.
  const urgent = lead.Urgency ? /^\s*urgent/i.test(lead.Urgency) : /Urgency:\s*urgent/i.test(text || "");
  if (urgent) return "🚨 URGENT LEAD";
  if (noInfo) return "📞 MISSED / SHORT CALL";
  return "🏠 NEW LEAD";
}

// ─── Caller number from the Telnyx AI conversation record ─────────────────────
async function lookupCaller({ callControlId, callLegId }) {
  const filters = [];
  if (callControlId) filters.push(`metadata->call_control_id=eq.${encodeURIComponent(callControlId)}`);
  if (callLegId) filters.push(`metadata->call_leg_id=eq.${encodeURIComponent(callLegId)}`);
  for (const f of filters) {
    try {
      const r = await fetch(`${TELNYX}/ai/conversations?${f}&limit=1`, {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
      });
      if (!r.ok) continue;
      const from = (await r.json())?.data?.[0]?.metadata?.from;
      if (from) return from;
    } catch (e) {
      console.error("Caller lookup failed:", e?.message || e);
    }
  }
  return null;
}

function formatPhone(n) {
  const d = String(n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n || "Unknown";
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ─── Email (Namecheap Private Email SMTP) ─────────────────────────────────────
async function sendEmail(header, callerNumber, lead, rawText) {
  const user = process.env.SMTP_USER || "daniel@thewatsonfactor.dev";
  const to = process.env.ALERT_EMAIL || "ARlocalroofing@gmail.com";
  const dryRun = process.env.EMAIL_DRY_RUN === "1";
  if (!process.env.SMTP_PASS && !dryRun) throw new Error("SMTP_PASS not set in Vercel");

  const name = lead.Name && !/not given/i.test(lead.Name) ? lead.Name : "Unknown caller";
  const job = lead["Job Type"] && !/not given/i.test(lead["Job Type"]) ? ` — ${lead["Job Type"]}` : "";
  const subject = `${header}: ${name}${job}`;
  const tel = String(callerNumber).replace(/[^\d+]/g, "");

  const rows = ["Name", "Address", "Job Type", "Urgency", "Callback Number", "Insurance Claim", "Notes"]
    .filter((k) => lead[k])
    .map(
      (k) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 0;font-weight:600">${esc(lead[k])}</td></tr>`
    )
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;color:#111">
  <h2 style="margin:0 0 4px">${esc(header)}</h2>
  <p style="margin:0 0 16px;color:#555">Answered by Alex, your AI receptionist</p>
  <p style="margin:0 0 16px"><a href="tel:${esc(tel)}" style="display:inline-block;background:#c0392b;color:#fff;
     padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">📞 Call back ${esc(formatPhone(callerNumber))}</a></p>
  ${rows ? `<table style="border-collapse:collapse;font-size:15px">${rows}</table>` : `<pre style="white-space:pre-wrap">${esc(rawText)}</pre>`}
  <p style="margin:24px 0 0;font-size:12px;color:#888">Arkansas Local Roofing &amp; Construction · AI answering service by The Watson Factor</p>
</div>`;
  const text = `${header}\nCaller ID: ${formatPhone(callerNumber)}\n\n${rawText}\n\n— Alex, Arkansas Local Roofing AI`;

  const transport = dryRun
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: process.env.SMTP_HOST || "mail.privateemail.com",
        port: Number(process.env.SMTP_PORT || 465),
        secure: Number(process.env.SMTP_PORT || 465) === 465,
        auth: { user, pass: process.env.SMTP_PASS },
      });

  const info = await transport.sendMail({
    from: `"Alex — AI Receptionist" <${user}>`,
    to,
    replyTo: user,
    subject,
    text,
    html,
  });
  if (dryRun) console.log("EMAIL DRY RUN:", info.message);
  return `sent to ${to} (${info.messageId || "ok"})`;
}

// ─── SMS via Telnyx (starts delivering once 10DLC is approved) ────────────────
function buildSms(header, callerNumber, text) {
  const clean = (text || "No summary generated.").trim().slice(0, 1200);
  return `${header}\nCaller ID: ${formatPhone(callerNumber)}\n\n${clean}\n\n— Alex, Arkansas Local Roofing AI`;
}

async function sendSMS(to, from, text) {
  if (!to || !from || !process.env.TELNYX_API_KEY) {
    throw new Error("Missing env var: CHRIS_NUMBER, FROM_NUMBER, or TELNYX_API_KEY");
  }
  const r = await fetch(`${TELNYX}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text }),
  });
  if (!r.ok) throw new Error(`Telnyx SMS failed (${r.status}): ${await r.text()}`);
  return r.json();
}
