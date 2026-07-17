import "server-only";
import { getConversation, appendMessage } from "@/lib/agent/repository";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { wasContactedToday, recordContacted } from "@/lib/messaging/frequency";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { londonDayKey } from "@/lib/time/london";
import { getClient, getSite } from "@/lib/mock/clients";
import { draftNurtureTouch, nurtureFallback } from "./draft";
import { insertAttempt, listNurtureDue, setNurtureSchedule, markNurtureDone } from "./repository";
import { setLeadStage } from "./repository";
import {
  NURTURE_AGE_LIMIT_DAYS,
  NURTURE_INTERVALS_DAYS,
  NURTURE_MAX_TOUCHES,
  NURTURE_PER_TICK_CAP,
  NURTURE_SCAN_LIMIT,
  daysBefore,
  nurtureNextAt,
} from "./nurture-cadence";
import type { SpeedToLeadLead } from "./types";

// Lead nurture sweep - the warm-up half of speed-to-lead.
//
// A lead that was contacted but has gone quiet for 3 days gets a gentle 3-touch
// nurture (days 3, 10, 21). Each touch is a short warm SMS drafted with Claude
// (Sonnet + NO_THINKING) with a deterministic, guardrail-safe fallback, and is sent
// through the SAME gated path contactLead uses:
//   - the speed-to-lead kill switch (checked by the sweep route BEFORE this runs,
//     fail-closed once messaging is live),
//   - consent on the channel,
//   - opt-out suppression (by address and, for a known patient, by patient ref),
//   - the cross-module daily cap (at most one outreach message per recipient per
//     London day, stamped after a real send).
//
// A reply at ANY point exits nurture. NOTE: the inbound webhook does NOT itself flip
// a speed-to-lead lead's stage on reply (it threads the reply into the agent
// conversation and stamps last_inbound_at, but leaves the lead 'contacted'). So this
// pass detects the reply via the lead's conversation and performs the exit here,
// moving the lead to 'qualifying' (engaged, in conversation) - which also removes it
// from the 'contacted'-only nurture selection.

export interface NurtureResult {
  due: number;
  sent: number;
  exited: number; // replied -> left nurture
  retired: number; // un-nurturable (no phone/consent) or suppressed -> retired from nurture
  capped: number; // yielded to the cross-module daily cap this tick
  failed: number; // send failed -> left scheduled to retry
  completed: number; // full 3-touch nurture finished
}

/** Whether the patient has replied since we contacted them (via the threaded conversation). */
async function hasReplied(lead: SpeedToLeadLead): Promise<boolean> {
  if (!lead.conversationId) return false;
  try {
    const conv = await getConversation(lead.conversationId);
    // contactLead only ever sends OUTBOUND on first contact (never stamps inbound),
    // so a non-null last_inbound_at means the patient has actually replied.
    return Boolean(conv?.lastInboundAt);
  } catch {
    // Best-effort: if we cannot read the conversation, do not send (safer to skip a
    // nurture than to nudge someone who may have replied). Treat as replied-exit.
    return true;
  }
}

/** The nurture SMS body: the model's draft when clean, else the safe fallback. */
async function nurtureBody(
  lead: SpeedToLeadLead,
  touch: number,
  client: ReturnType<typeof getClient>,
): Promise<string> {
  try {
    const drafted = await draftNurtureTouch(lead, touch, client);
    const guard = checkAgentReply(drafted.body, { includePrice: false });
    if (guard.ok && drafted.body.trim()) return drafted.body.trim();
    // Guardrail tripped (or empty): fall back to the deterministic safe copy rather
    // than sending forbidden wording or nothing.
    console.warn(
      `[nurture] lead ${lead.id}: draft failed the guardrail or was empty; using deterministic fallback`,
    );
  } catch (err) {
    console.warn(`[nurture] lead ${lead.id}: draft threw; using deterministic fallback`, err);
  }
  return nurtureFallback(lead, touch, client);
}

/**
 * One nurture pass. Sends up to NURTURE_PER_TICK_CAP nudges to due leads, advancing
 * each along the cadence (or completing it after touch 3). Every branch is defensive
 * so one bad lead cannot break the pass. Returns per-outcome counts.
 */
export async function nurtureSweep(now: Date): Promise<NurtureResult> {
  const nowIso = now.toISOString();
  const result: NurtureResult = { due: 0, sent: 0, exited: 0, retired: 0, capped: 0, failed: 0, completed: 0 };

  const due = await listNurtureDue({
    nowIso,
    // Entry: first contact at least the first interval (3d) ago.
    entryCutoffIso: daysBefore(now, NURTURE_INTERVALS_DAYS[0]),
    // Age guard: never nurture a lead older than the limit.
    ageCutoffIso: daysBefore(now, NURTURE_AGE_LIMIT_DAYS),
    limit: NURTURE_SCAN_LIMIT,
  });
  result.due = due.length;

  const today = londonDayKey(now);
  const base = process.env.PUBLIC_BASE_URL ?? "";
  const statusCallbackUrl = base.startsWith("https://") ? `${base}/api/webhooks/twilio/status` : undefined;

  for (const lead of due) {
    if (result.sent >= NURTURE_PER_TICK_CAP) break; // per-tick send cap

    // A reply at any point exits nurture: move the engaged lead to 'qualifying' and
    // clear its schedule so it is never selected again.
    if (await hasReplied(lead)) {
      try {
        await setLeadStage(lead.id, "qualifying");
        await setNurtureSchedule(lead.id, lead.nurtureStep, null);
      } catch {
        /* best effort */
      }
      result.exited += 1;
      continue;
    }

    // Nurture is an SMS. It needs a phone and SMS consent; a lead with neither can
    // never be nurtured, so retire it from the cadence (step to max, no schedule) so
    // it is not re-selected every tick. No stage change: it stays 'contacted'.
    const to = lead.phone;
    if (!to || lead.consent.sms !== true) {
      try {
        await setNurtureSchedule(lead.id, NURTURE_MAX_TOUCHES, null);
      } catch {
        /* best effort */
      }
      result.retired += 1;
      continue;
    }

    // Opt-out: a STOP (by address, or by patient ref for a known patient) is terminal
    // for nurture too. Retire from the cadence.
    const suppressed =
      (await isSuppressed(lead.siteId, "sms", to)) ||
      (lead.dentallyPatientId ? await isSuppressed(lead.siteId, "sms", `patient:${lead.dentallyPatientId}`) : false);
    if (suppressed) {
      try {
        await setNurtureSchedule(lead.id, NURTURE_MAX_TOUCHES, null);
      } catch {
        /* best effort */
      }
      result.retired += 1;
      continue;
    }

    // Cross-module daily cap: this recipient has already had a message today, so
    // yield. Do NOT advance the schedule - the touch stays due and the next tick
    // (after London midnight frees the cap) will send it.
    if (await wasContactedToday(lead.siteId, to, today)) {
      result.capped += 1;
      continue;
    }

    const touch = lead.nurtureStep + 1; // 1-based touch number
    const client = getClient(getSite(lead.siteId)?.clientId ?? "");
    const body = await nurtureBody(lead, touch, client);

    // Narrow the retryable window to the SEND itself. A send failure leaves the lead
    // scheduled (retry next tick); anything after a successful send must advance the
    // cadence so we never re-nudge a lead we already messaged.
    let providerMessageId: string | null = null;
    let provider: string | null = null;
    try {
      const res = await sendMessage({ channel: "sms", to, body, statusCallbackUrl });
      providerMessageId = res.providerMessageId;
      provider = res.provider;
    } catch {
      try {
        await insertAttempt({ leadId: lead.id, channel: "sms", toAddress: to, body, status: "failed" });
      } catch {
        /* best effort */
      }
      result.failed += 1;
      continue;
    }

    result.sent += 1;
    // Post-send bookkeeping (best-effort; a failure here must not re-send).
    try {
      await appendConversation(lead, body);
      await insertAttempt({ leadId: lead.id, channel: "sms", toAddress: to, body, status: "sent", provider, providerMessageId });
      await recordContacted(lead.siteId, to, today, "nurture");
    } catch (err) {
      console.error(`[nurture] lead ${lead.id}: post-send bookkeeping failed; advancing cadence anyway`, err);
    }

    // Advance the cadence: complete after the final touch, else schedule the next.
    const newStep = lead.nurtureStep + 1;
    try {
      if (newStep >= NURTURE_MAX_TOUCHES) {
        await markNurtureDone(lead.id);
        result.completed += 1;
      } else {
        await setNurtureSchedule(lead.id, newStep, nurtureNextAt(newStep, nowIso));
      }
    } catch (err) {
      console.error(`[nurture] lead ${lead.id}: SENT but cadence advance failed; will not re-send (guarded by step/next)`, err);
    }
  }

  return result;
}

/** Log the nurture message on the lead's threaded conversation, best-effort. */
async function appendConversation(lead: SpeedToLeadLead, body: string): Promise<void> {
  if (!lead.conversationId) return;
  await appendMessage({ conversationId: lead.conversationId, role: "agent", body });
}
