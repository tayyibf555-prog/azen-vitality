import { sendMessage } from "@/lib/messaging/send";
import { consumeBudget } from "@/lib/rate-budget";
import { ensureNeedsHuman } from "./repository";

// Staff handover alert: when the agent stands down mid-conversation (escalation,
// safety filter, error, throttle), make sure a human finds out.
//
// TWO CHANNELS, NOT ONE. This used to be an SMS and nothing else, which meant that
// with STAFF_ALERT_PHONE unset — its state in production today — a patient could
// ask for a human and the entire notification was a `return`. The dashboard's
// "Needs a human" list held the truth, but nothing put it in front of anyone.
//
//   1. THE RECORD (always). The conversation is marked needs_human, which is what
//      the Task Queue's escalation tasks are computed from, so the handover lands
//      on the worklist staff actually work. Free, durable, and it does not depend
//      on any configuration existing.
//   2. THE PUSH (when configured). An SMS to STAFF_ALERT_PHONE, budget-capped so a
//      pathological loop cannot flood the staff phone. Unset => no text, and that
//      is now a downgrade in urgency rather than silence.
//
// Every call site already marks the conversation itself, so (1) is normally a
// no-op that reports "already". It is here so the guarantee belongs to the alert
// rather than to four separate callers remembering: a future handover path that
// forgets the status write still surfaces on the queue.
//
// - Fires only at the MOMENT of handover (the webhook does not re-run the agent
//   on an already-handed-over thread, so repeat patient messages do not re-ping).
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

/** The configured staff alert number, or null when the push channel is dormant. */
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

/**
 * What actually happened, so a caller (and a test) can tell the paths apart.
 *
 * `queued` is the guarantee: true means the escalation is on the Task Queue, by
 * whichever of the two routes got there. It is what "never silent" means.
 */
export interface HandoverAlertOutcome {
  /** The durable record: 'set' by us, 'already' present, 'failed', or 'skipped' with no ref. */
  task: "set" | "already" | "failed" | "skipped";
  /** The optional push: sent, or the reason it was not. */
  sms: "sent" | "no_phone" | "capped" | "failed";
  /** Whether a human will find this on the Task Queue. */
  queued: boolean;
}

export async function alertStaffHandover(input: {
  patientName: string;
  reason: HandoverReason;
  /** The conversation being handed over. Without it there is no durable record to ensure. */
  conversationId?: string | null;
}): Promise<HandoverAlertOutcome> {
  // (1) THE RECORD, first and unconditionally. It runs before the SMS so that a
  // provider outage, an exhausted budget or a missing number can never cost us the
  // one notification that does not depend on configuration.
  let task: HandoverAlertOutcome["task"] = "skipped";
  if (input.conversationId) {
    try {
      task = await ensureNeedsHuman(input.conversationId);
    } catch (err) {
      task = "failed";
      console.error(
        `[agent] could not record the handover for conversation ${input.conversationId}`,
        err,
      );
    }
  }
  // 'already' is the normal, healthy answer: the caller marked it a moment ago.
  const queued = task === "set" || task === "already";

  // (2) THE PUSH.
  const to = staffAlertPhone();
  if (!to) {
    if (!queued) {
      // Both routes are out: nobody is going to hear about this one. Say so.
      console.error(
        `[agent] handover for "${input.patientName}" (${input.reason}) reached NOBODY: no STAFF_ALERT_PHONE and no durable record`,
      );
    }
    return { task, sms: "no_phone", queued };
  }
  try {
    if (!(await consumeBudget("staff-alert", MAX_ALERTS_PER_HOUR, 3600))) {
      console.error("[agent] staff handover alert dropped: hourly cap reached");
      return { task, sms: "capped", queued };
    }
    await sendMessage({
      channel: "sms",
      to,
      body: buildHandoverAlert(input.patientName, input.reason),
    });
    return { task, sms: "sent", queued };
  } catch (err) {
    // The patient-side handover already happened; a failed ping only means staff
    // find the thread via the Task Queue instead.
    console.error("[agent] staff handover alert failed", err);
    return { task, sms: "failed", queued };
  }
}
