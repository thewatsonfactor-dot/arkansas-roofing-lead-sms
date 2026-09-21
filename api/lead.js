// Arkansas Local Roofing — Telnyx Lead SMS Notifier
// Vercel Serverless Function — /api/lead
// Receives Telnyx AI Insights webhook -> texts lead summary to Chris via Telnyx SMS

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Arkansas Local Roofing - Lead SMS active");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }
  const { callerNumber, summary } = parseLeadSummary(req.body);
  const smsText = "NEW ROOFING LEAD\nCaller: " + callerNumber + "\n\n" + summary + "\n\n- Arkansas Local Roofing AI";
  try {
    await sendSMS(process.env.CHRIS_NUMBER, process.env.FROM_NUMBER, smsText);
    console.log("SMS sent to Chris for caller:", callerNumber);
  } catch (err) {
    console.error("SMS error:", err);
  }
  return res.status(200).end();
}

async function sendSMS(to, from, text) {
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.TELNYX_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to, text })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error("Telnyx SMS failed: " + err);
  }
  return response.json();
}

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
    const summaryMatch = transcript.match(/Name:[\s\S]*?(?=\n\n|$)/);
    const summary = summaryMatch
      ? summaryMatch[0].trim()
      : transcript.slice(-500) || "No transcript available.";
    return { callerNumber, summary };
  } catch {
    return { callerNumber: "Unknown", summary: "Could not parse call transcript." };
  }
}
