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

  // Log raw payload to Vercel console for debugging
  console.log("Telnyx webhook received:", JSON.stringify(req.body).slice(0, 500));

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
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({ from, to, text })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telnyx SMS failed (${response.status}): ${err}`);
  }
  return response.json();
}

// ─── Parse Telnyx Insights Webhook Payload ──────────────────────────────
// Handles three formats:
//   1. Telnyx AI Insights webhook (primary — fires after call ends with AI summary)
//   2. Telnyx TeXML status_callback (fires on call state changes)
//   3. Legacy / generic fallback
function parseLeadSummary(payload) {
  try {
    // ── Format 1: Telnyx AI Insights webhook ─────────────────────────────
    // { event_type: "ai.insight.created", data: { insights: [...], conversation: {...} } }
    const insightData = payload?.data || payload;
    const insights = insightData?.insights;

    if (Array.isArray(insights) && insights.length > 0) {
      // Caller number from conversation metadata
      const callerNumber =
        insightData?.conversation?.from ||
        insightData?.conversation?.caller_id ||
        insightData?.from ||
        payload?.from ||
        "Unknown";

      // Find the Summary insight (what the AI generated)
      const summaryInsight = insights.find(
        (i) =>
          (i.name || "").toLowerCase().includes("summary") ||
          (i.type || "").toLowerCase().includes("summary")
      );

      if (summaryInsight) {
        const rawResult = summaryInsight.result || summaryInsight.content || "";
        // The AI writes a structured block: Name: / Address: / Job Type: / etc.
        const structuredMatch = rawResult.match(/Name:[\s\S]*?(?=\n\n|\n---|\n===|$)/);
        const summary = structuredMatch
          ? structuredMatch[0].trim()
          : rawResult.slice(-800).trim() || "No summary extracted.";
        return { callerNumber, summary };
      }

      // Fallback: all insight results
      const allResults = insights
        .map((i) => `[${i.name || i.type || "Insight"}]: ${i.result || i.content || ""}`)
        .join("\n");
      return {
        callerNumber,
        summary: allResults || "Call completed — no summary in insights."
      };
    }

    // ── Format 2: Telnyx TeXML status_callback ────────────────────────────
    // { CallStatus: "completed", From: "+1...", CallDuration: "45", ... }
    if (payload?.CallStatus || payload?.From) {
      const callerNumber = payload.From || "Unknown";
      const status = payload.CallStatus || "completed";
      const duration = payload.CallDuration ? `${payload.CallDuration}s` : "unknown";
      return {
        callerNumber,
        summary: `Call ${status} (${duration}). AI summary will follow separately once insights process.`
      };
    }

    // ── Format 3: Legacy / generic fallback ──────────────────────────────
    const callerNumber =
      payload?.data?.payload?.from ||
      payload?.data?.payload?.caller_id ||
      payload?.from ||
      "Unknown";
    const transcript =
      payload?.data?.payload?.conversation_transcript ||
      payload?.data?.payload?.transcript ||
      "";
    const summaryMatch = transcript.match(/Name:[\s\S]*?(?=\n\n|$)/);
    const summary = summaryMatch
      ? summaryMatch[0].trim()
      : transcript.slice(-500) || JSON.stringify(payload).slice(0, 500);
    return { callerNumber, summary };

  } catch (err) {
    console.error("parseLeadSummary error:", err);
    return {
      callerNumber: "Unknown",
      summary: "Could not parse call data. Check Vercel logs for raw payload."
    };
  }
}
