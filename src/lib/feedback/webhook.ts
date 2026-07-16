import "server-only";

// Best-effort notification of a new feedback submission to an external channel
// (e.g. a Slack/Teams incoming webhook). FEEDBACK_WEBHOOK_URL is optional and
// unset by default, so this is a silent no-op until a practice/agency wants it.
//
// Deliberately NOT awaited by the caller (see route.ts) and this itself never
// throws: the feedback row is already saved by the time this runs, so a slow or
// unreachable webhook endpoint must never add latency to, or fail, the
// practice-facing "Sent to the team" confirmation.

interface FeedbackForWebhook {
  severity: string;
  pagePath: string;
  note: string;
  userEmail: string | null;
  role: string | null;
}

function buildSummary(item: FeedbackForWebhook, clientName: string): string {
  const who = item.userEmail ? `${item.userEmail}${item.role ? ` (${item.role})` : ""}` : "an unidentified user";
  return [
    `[${clientName}] New ${item.severity} report on ${item.pagePath}`,
    `From: ${who}`,
    item.note,
  ].join("\n");
}

/** Fire-and-forget: swallows every error, and does nothing when unset. */
export function notifyFeedbackWebhook(item: FeedbackForWebhook, clientName: string): void {
  const url = (process.env.FEEDBACK_WEBHOOK_URL ?? "").trim();
  if (!url) return;
  try {
    fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: buildSummary(item, clientName),
    }).catch(() => {
      // Best-effort only.
    });
  } catch {
    // A synchronous throw from fetch() itself (bad URL etc.) must not propagate.
  }
}
