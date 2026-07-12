import { sendMessage } from "@/lib/messaging/send";
import { consumeBudget } from "@/lib/rate-budget";

// Staff handover alert: when the agent stands down mid-conversation (escalation,
// safety filter, error, throttle), text the practice's alert number so someone
// picks the thread up without having to watch the dashboard.
//
// - Destination comes from STAFF_ALERT_PHONE (E.164). Unset => silent no-op, so
//   the feature ships dormant until the practice provides a number.
// - Fires only at the MOMENT of handover (the webhook does not re-run the agent
//   on an already-handed-over thread, so repeat patient messages do not re-ping).
// - Budget-capped so a pathological loop can never flood the staff phone; over
//   the cap the handover still happens, only the ping is dropped (the dashboard
//   "Needs a human" list remains the source of truth).
// - Best-effort by contract: an alert failure must NEVER affect the patient flow.
// - Not gated by the module kill switches on purpose: it can only be reached
//   from agent paths that are themselves gated, and it messages STAFF, not a
//   patient.

export type HandoverReason = "escalated" | "guardrail" | "agent_error" | "no_reply" | "throttled";

const REASON_LINE: Record<HandoverReason, string> = {
  escalated: "the assistant handed the conversation over",
  guardrail: "a reply was held back by the safety filter",
  agent_error: "the assistant hit an error",
  no_reply: "the assistant could not produce a reply",
  throttled: "message volume from that number was capped",
};

const MAX_ALERTS_PER_HOUR = Number(process.env.STAFF_ALERT_HOURLY_CAP ?? "12");

/** The configured staff alert number, or null when the feature is dormant. */
export function staffAlertPhone(): string | null {
  const to = (process.env.STAFF_ALERT_PHONE ?? "").trim();
  return to.length > 0 ? to : null;
}

export function buildHandoverAlert(patientName: string, reason: HandoverReason): string {
  const lines = [
    `Vitality assistant: a patient conversation needs a human. ${patientName}, ${REASON_LINE[reason]}.`,
    "Open Conversations in the dashboard to reply.",
  ];
  return lines.join(" ");
}

export async function alertStaffHandover(input: {
  patientName: string;
  reason: HandoverReason;
}): Promise<void> {
  const to = staffAlertPhone();
  if (!to) return;
  try {
    if (!(await consumeBudget("staff-alert", MAX_ALERTS_PER_HOUR, 3600))) {
      console.error("[agent] staff handover alert dropped: hourly cap reached");
      return;
    }
    await sendMessage({
      channel: "sms",
      to,
      body: buildHandoverAlert(input.patientName, input.reason),
    });
  } catch (err) {
    // The patient-side handover already happened; a failed ping only means staff
    // find the thread via the dashboard instead.
    console.error("[agent] staff handover alert failed", err);
  }
}
