// Arkansas Local Roofing — Telnyx Lead SMS Notifier
// Vercel Serverless Function — /api/lead
//
// Flow: caller → Alex (Telnyx AI assistant) → call ends → Telnyx runs the
// "Arkansas Roofing Lead Capture" insight → webhook `call.conversation_insights.generated`
// hits this function → we look up the caller's number → text the lead to Chris.
//
// Env vars (Vercel → Settings → Environment Variables):
//   TELNYX_API_KEY   Telnyx API key (used for SMS + caller lookup)
//   FROM_NUMBER      +15012329111  (must be 10DLC / toll-free registered to deliver)
//   CHRIS_NUMBER     +15013525737
//   ALLOWED_CONNECTION_ID (optional) 3054032437311964478 — ignore events from other apps

const TELNYX = "https://api.telnyx.com/v2";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Arkansas Local Roofing — Lead SMS active ✅");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = req.body || {};
  const eventType = body?.data?.event_type || body?.event_type || (body?.CallStatus ? `texml.${body.CallStatus}` : "unknown");
  console.log("Webhook received:", eventType, JSON.stringify(body).slice(0, 1500));

  try {
    // ── 1. AI insight results (the only event that texts Chris) ──────────────
    const insight = extractInsight(body);
    if (!insight) {
      // TeXML status callbacks (initiated/ringing/answered/completed) and anything
      // else: log only. Texting on these caused 4 duplicate texts per call.
      return res.status(200).json({ ok: true, action: "ignored", eventType });
    }

    const allowed = process.env.ALLOWED_CONNECTION_ID;
    if (allowed && insight.connectionId && String(insight.connectionId) !== String(allowed)) {
      console.log("Ignoring insight from other connection:", insight.connectionId);
      return res.status(200).json({ ok: true, action: "ignored-other-connection" });
    }

    const callerNumber = insight.callerNumber || (await lookupCaller(insight)) || "Unknown";
    const smsText = buildSms(callerNumber, insight.text);

    const sent = await sendSMS(process.env.CHRIS_NUMBER, process.env.FROM_NUMBER, smsText);
    console.log("SMS queued to Chris:", sent?.data?.id, "caller:", callerNumber);
    return res.status(200).json({ ok: true, action: "sms-sent", messageId: sent?.data?.id });
  } catch (err) {
    // Still 200 so Telnyx doesn't hammer retries; the error is in Vercel logs.
    console.error("Lead handler error:", err?.message || err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}

// ─── Parse the insight webhook ────────────────────────────────────────────────
function extractInsight(body) {
  const data = body?.data || {};
  const p = data?.payload || {};

  // Current Telnyx format: call.conversation_insights.generated
  // { data: { event_type, payload: { call_control_id, connection_id, results: [{ insight_id, result }] } } }
  if (Array.isArray(p.results) && p.results.length) {
    return {
      text: p.results.map((r) => (r.result || "").trim()).filter(Boolean).join("\n\n"),
      callControlId: p.call_control_id,
      callLegId: p.call_leg_id,
      connectionId: p.connection_id,
      callerNumber: p.from || p.caller_id || null,
    };
  }

  // Older/alternate shape: { data: { insights: [...], conversation: {...} } }
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

// ─── Find the caller's number from the Telnyx AI conversation record ─────────
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
      const j = await r.json();
      const from = j?.data?.[0]?.metadata?.from;
      if (from) return from;
    } catch (e) {
      console.error("Caller lookup failed:", e?.message || e);
    }
  }
  return null;
}

// ─── SMS body ─────────────────────────────────────────────────────────────────
function buildSms(callerNumber, text) {
  const clean = (text || "No summary generated.").trim().slice(0, 1200);
  const noInfo = /Name:\s*Not given/i.test(clean) && /Address:\s*Not given/i.test(clean);
  const header = /URGENT/i.test(clean) ? "🚨 URGENT ROOFING LEAD" : noInfo ? "📞 MISSED / SHORT CALL" : "🏠 NEW ROOFING LEAD";
  return `${header}\nCaller ID: ${formatPhone(callerNumber)}\n\n${clean}\n\n— Alex, Arkansas Local Roofing AI`;
}

function formatPhone(n) {
  const d = String(n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n || "Unknown";
}

// ─── Telnyx SMS API ────────────────────────────────────────────────────────────
async function sendSMS(to, from, text) {
  if (!to || !from || !process.env.TELNYX_API_KEY) {
    throw new Error("Missing env var: CHRIS_NUMBER, FROM_NUMBER, or TELNYX_API_KEY");
  }
  const r = await fetch(`${TELNYX}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, text }),
  });
  if (!r.ok) throw new Error(`Telnyx SMS failed (${r.status}): ${await r.text()}`);
  return r.json();
}
