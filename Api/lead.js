// Arkansas Local Roofing — Telnyx Lead SMS Notifier
// Vercel Serverless Function — /api/lead
// Receives Telnyx AI Insights webhook → texts lead summary to Chris via Telnyx SMS

export default async function handler(req, res) {
  // Health check
  if (req.method === "GET") {
    return res.status(200).send("Arkansas Local Roofing — Lead SMS active ✅");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  // Parse lead info from Telnyx payload
  const { callerNumber, summary } = parseLeadSummary(req.body);

  // Build SMS text
  const smsText =
`🏠 NEW ROOFING LEAD
Caller: ${callerNumber}

${summary}

— Arkansas Local Roofing AI`;

  // Send SMS via Telnyx, then respond 200 to Telnyx
  try {
    await sendSMS(
      process.env.CHRIS_NUMBER,
      process.env.FROM_NUMBER,
      smsText
    );
    console.log("SMS sent to Chris for caller:", callerNumber);
  } catch (err) {
    console.error("SMS error:", err);
  }

  // Always return 200 so Telnyx doesn't retry
  return res.status(200).end();
}

// ─── Telnyx SMS API ───────────────────────────────────────────────────────────
async function sendSMS(to, from, text) {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({ from, to, text })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telnyx SMS failed: ${err}`);
  }
  return res.json();
}

// ─── Parse Telnyx Insights Webhook Payload ────────────────────────────────────
function parseLeadSummary(payload) {
  try {
    const callerNumber =
      payload?.data?.payload?.from ||
      payload?.data?.payload?.caller_id ||
      "Unknown";

    const transcript =
      payload?.data?.payload?.conversation_transcript ||
      payload?.data?.payload?.transcript ||
      "";

    // Pull the structured summary the AI writes at end of call
    // Matches the OUTPUT FORMAT block in the Telnyx AI system prompt
    const summaryMatch = transcript.match(/Name:[\s\S]*?(?=\n\n|$)/);
    const summary = summaryMatch
      ? summaryMatch[0].trim()
      : transcript.slice(-500) || "No transcript available.";

    return { callerNumber, summary };
  } catch {
    return {
      callerNumber: "Unknown",
      summary: "Could not parse call transcript."
    };
  }
}
