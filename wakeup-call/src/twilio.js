const API_BASE = "https://api.twilio.com/2010-04-01";

// Call states that mean the attempt is finished, one way or the other.
const FINAL_STATUSES = new Set([
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);

function authHeader(config) {
  const token = Buffer.from(`${config.accountSid}:${config.authToken}`).toString(
    "base64",
  );
  return { Authorization: `Basic ${token}` };
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildTwiml(config) {
  const say = escapeXml(config.message);
  return (
    `<Response>` +
    `<Pause length="1"/>` +
    `<Say voice="Polly.Joanna" loop="${config.sayLoop}">${say}</Say>` +
    `</Response>`
  );
}

export async function placeCall(config) {
  const body = new URLSearchParams({
    To: config.to,
    From: config.from,
    Twiml: buildTwiml(config),
    // Ring for up to 40 seconds before Twilio gives up on the attempt.
    Timeout: "40",
  });
  const res = await fetch(
    `${API_BASE}/Accounts/${config.accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        ...authHeader(config),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Twilio rejected the call (HTTP ${res.status}): ${data.message ?? "unknown error"}`,
    );
  }
  return data.sid;
}

async function getCallStatus(config, callSid) {
  const res = await fetch(
    `${API_BASE}/Accounts/${config.accountSid}/Calls/${callSid}.json`,
    { headers: authHeader(config) },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Could not fetch call status (HTTP ${res.status}): ${data.message ?? "unknown error"}`,
    );
  }
  return data.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until the call reaches a final state (or ~3 minutes pass).
export async function waitForOutcome(config, callSid) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let status = "queued";
  while (Date.now() < deadline) {
    await sleep(10_000);
    status = await getCallStatus(config, callSid);
    if (FINAL_STATUSES.has(status)) return status;
  }
  return status;
}

export function wasAnswered(status) {
  return status === "completed";
}
