import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { draftRecall } from "@/lib/recall/draft";
import { RecallDraftTooLongError } from "@/lib/recall/sms-budget";
import { stepDef, advanceAfter, RECALL_CADENCE } from "@/lib/recall/cadence";
import { shouldGraduate } from "@/lib/recall/normalise";
import { londonOverdueDays } from "@/lib/time/london";
import {
  listDueCadences,
  getTarget,
  listTouches,
  incrementPriorAttempts,
  updateCadence,
  setTargetStatus,
  markGraduated,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  countContactedToday,
} from "@/lib/recall/repository";
import type { RecallTarget } from "@/lib/recall/types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import { liveSwitch } from "@/lib/systems/live-switch";
import {
  loadExcludedTargetKeys,
  excludedTargetKey,
  isExclusionsUnavailable,
} from "@/lib/patient-status/repository";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function graceDays(): number {
  return Number(process.env.RECALL_GRACE_DAYS ?? 60);
}

// Conservative default for a 51k-patient base: enabling recall can never blast the
// whole due cohort in a day. The owner can raise it later; no UI in this task.
const RECALL_DEFAULT_DAILY_CONTACT_LIMIT = 25;

/**
 * The daily automated-contact cap (env RECALL_DAILY_CONTACT_LIMIT). Hardened like
 * reactivation's fail-safe: an empty, non-numeric or negative value reverts to the
 * default LOUDLY (console.error) so a misconfiguration is caught, never silently
 * "unlimited". 0 is a valid "paused" value that queues nothing. Unset simply uses
 * the default (the normal, non-configured case, no noise).
 */
function dailyContactLimit(): number {
  const raw = process.env.RECALL_DAILY_CONTACT_LIMIT;
  if (raw === undefined) return RECALL_DEFAULT_DAILY_CONTACT_LIMIT;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  // Number("") is 0, so the empty check must precede the numeric check.
  if (trimmed === "" || !Number.isFinite(n) || n < 0) {
    console.error(
      `[recall] RECALL_DAILY_CONTACT_LIMIT="${raw}" is invalid; using default ${RECALL_DEFAULT_DAILY_CONTACT_LIMIT}`,
    );
    return RECALL_DEFAULT_DAILY_CONTACT_LIMIT;
  }
  return Math.floor(n);
}

function channelConsented(t: RecallTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: RecallTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

async function settleExhausted(target: RecallTarget, now: Date): Promise<void> {
  // Whole London days, matching classification (normalise.londonOverdueDays), so the
  // grace boundary is decided by ONE day definition everywhere (not fractional UTC).
  const overdueNow = londonOverdueDays(target.dueAt, now);
  if (shouldGraduate(overdueNow, graceDays())) {
    await markGraduated(target.id);
  } else {
    await setTargetStatus(target.id, "exhausted");
  }
}

async function handleWithDentallyPriority(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // FAIL-CLOSED WHEN LIVE (ruling W1-B/1, 3 Sep 2026). This used to be
  // isSystemEnabled, which resolves a toggle-read ERROR to "enabled" for a
  // default-ON system and then let the whole batch draft. isSystemEnabledForSend
  // keeps that behaviour while MESSAGING_DRY_RUN is on, so development against a
  // partial database still works, and fails CLOSED once messaging is live: a
  // switch we cannot read is treated as off. A skipped tick is a delay; a batch
  // sent against an unknown switch is an incident.
  if (!(await isSystemEnabledForSend("vitality", "recall"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // Never overlap with another recall sweep: two runs would both see the same
  // due cadences and draft+queue duplicates. The lease must OUTLIVE maxDuration
  // (300s): a shorter lease would expire while a slow run was still working,
  // letting the next tick double-queue. A crashed run still self-heals: the
  // lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("sweep-recall", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
  const now = new Date();
  const due = await listDueCadences(now.toISOString());

  // Platform admin status: patients marked inactive / do_not_contact are excluded from
  // recall. Loaded ONCE per sweep (spans sites) and checked per target before drafting,
  // so no Anthropic draft is spent and no touch is queued. The cadence is left 'due'
  // (not exhausted), so clearing the override lets recall resume naturally.
  // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED (ruling W1-B/2, 3 Sep 2026).
  // loadExcludedTargetKeys throws once messaging is LIVE and it cannot read the
  // override table, so a patient a human marked inactive can never be drafted
  // because of a database blip. It still returns an empty set under dry-run.
  let excludedKeys: Set<string>;
  try {
    excludedKeys = await loadExcludedTargetKeys();
  } catch (err) {
    if (!isExclusionsUnavailable(err)) throw err;
    console.error("[recall] exclusion list unreadable while messaging is live; skipping this tick", err);
    return Response.json({ ok: true, skipped: "exclusions unavailable" });
  }

  // Daily automated-contact cap: at most this many recall messages are queued per
  // Europe/London day, so enabling recall against the 51k-patient base can never
  // blast the whole due cohort in a day. Every queued recall message counts toward
  // the total, so a manual/coordinator send tightens the automated budget rather
  // than bypassing it. Capped cadences stay due and continue tomorrow. Mirrors the
  // reactivation sweep's cap.
  const dailyLimit = dailyContactLimit();
  const usedToday = await countContactedToday(now);

  let drafted = 0;
  let queued = 0;
  let exhausted = 0;
  let graduated = 0;
  let paused = 0;
  let capped = 0;
  let suppressed = 0;
  // ONE MESSAGE THAT WILL NOT FIT IS ONE MESSAGE, NOT THE TICK.
  //
  // draftRecall makes one repair turn and then THROWS RecallDraftTooLongError
  // rather than truncating (src/lib/recall/sms-budget.ts: a half-sentence about a
  // dental appointment is worse than no message). Refusing is right. Letting the
  // refusal escape was not: the throw sat bare inside this loop, the only
  // enclosing try is the `finally { releaseCronLock }`, and runWithDentallyPriority
  // forwards — so the handler 500'd, every remaining due cadence in the batch was
  // dropped, and none of the counters below were ever returned. A practice whose
  // drafts systematically over-run (long USPs are the ordinary cause: they are
  // injected into the prompt at draft.ts) would have had recall stop dead, tick
  // after tick, with the switch showing ON and nothing but a 500 in the cron log.
  //
  // So it is counted and stepped over, the shape the no-show sweep already uses
  // for a per-row failure. The cadence is untouched (the throw precedes
  // insertTouch), so the same target is simply drafted again next tick — and
  // `refused` on the response is what makes a systematic over-run visible instead
  // of invisible. Narrow on purpose: any OTHER error still aborts the tick.
  let refused = 0;

  // The switch is re-read every ten rows for the rest of this run (ruling
  // W1-B/5): a long sweep must not keep drafting after the owner has switched
  // the system off. See src/lib/systems/live-switch.ts.
  const gate = liveSwitch("vitality", "recall");

  for (const cadence of due) {
    if (!(await gate.stillOn())) break;
    const target = await getTarget(cadence.targetId);
    if (!target) continue;

    // Platform admin status excludes this patient from all outreach: skip without
    // drafting/queueing, leaving the cadence due so it resumes if the override is lifted.
    if (excludedKeys.has(excludedTargetKey(target.siteId, target.dentallyPatientId))) {
      suppressed += 1;
      continue;
    }

    // Skip if an outbound touch is already pending (approved-but-unsent etc.):
    // the manual approve→send flow enqueues at approve and only advances the
    // cadence at send, so a coordinator who approves without sending leaves the
    // cadence 'due'; without this guard the next sweep would draft a SECOND
    // message for the same step and the drain would send both. Mirrors the
    // coordinator sweep predicate exactly.
    const touches = await listTouches(target.id);
    const hasPending = touches.some(
      (t) => t.direction !== "inbound" && t.status !== "sent" && t.status !== "failed",
    );
    if (hasPending) {
      paused += 1;
      continue;
    }

    const step = stepDef(cadence.currentStep + 1, RECALL_CADENCE);
    if (!step) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      await settleExhausted(target, now);
      // Count using the freshly computed overdue, matching what settleExhausted decided.
      const overdueNow = londonOverdueDays(target.dueAt, now);
      if (overdueNow > graceDays()) graduated += 1;
      else exhausted += 1;
      continue;
    }

    // No consent for this step's channel: end the cadence and settle the target
    // rather than pausing forever, so the patient is not stuck in limbo and
    // reactivation can adopt them if past grace.
    if (!channelConsented(target, step.channel)) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      await settleExhausted(target, now);
      paused += 1;
      continue;
    }

    // Enforce the daily cap BEFORE drafting (a capped draft would count as a
    // pending touch and freeze the cadence at the hasPending guard above; it would
    // also cost an Anthropic call for nothing). Once the day's budget is spent the
    // cadence simply stays due, so tomorrow's sweep continues where today stopped.
    // Recall auto-sends every step, so this gate covers all its automated sends.
    if (usedToday + queued >= dailyLimit) {
      capped += 1;
      continue;
    }

    // Recall auto-sends: draft, approve, queue, send (stub), advance.
    let body: string;
    try {
      ({ body } = await draftRecall(target, step.channel, step));
    } catch (err) {
      if (!(err instanceof RecallDraftTooLongError)) throw err;
      refused += 1;
      console.error(
        `[recall] cadence ${cadence.id} (target ${target.id}) drafted a ${err.units}-unit ${err.channel} ` +
          `body against a ${err.limit} ceiling; refused rather than truncated, moving to the next patient`,
        err,
      );
      continue;
    }
    const touch = await insertTouch({
      targetId: target.id,
      cadenceId: cadence.id,
      siteId: target.siteId,
      step: step.step,
      channel: step.channel,
      body,
      draftedBy: "claude",
      status: "draft",
    });
    drafted += 1;

    await approveTouch(touch.id, "auto");

    // Advance the cadence BEFORE enqueuing. If the run is killed between here and the
    // enqueue, the cadence has already moved past this step, so the next sweep sends the
    // NEXT step rather than re-drafting and re-sending this one (a skipped message beats
    // a double-send). incrementPriorAttempts + advanceAfter are the step's bookkeeping.
    await incrementPriorAttempts(target.id);
    const adv = advanceAfter(step.step, now, RECALL_CADENCE);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
    });

    // Leave the outbox row 'queued' so the shared drain delivers it via Twilio and
    // writes to_address (the only thing inbound reply correlation matches on). Marking
    // it sent here would stub the send and orphan replies.
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel: step.channel,
      toRef: patientToRef(target),
      body,
    });
    if (adv.status === "exhausted") await settleExhausted(target, now);
    queued += 1;
  }

  return Response.json({
    ok: true,
    swept: due.length,
    drafted,
    queued,
    paused,
    exhausted,
    graduated,
    capped,
    suppressed,
    refused,
    dailyLimit,
    usedToday,
  });
  } finally {
    await releaseCronLock("sweep-recall");
  }
}

// EVERY Dentally read inside this handler is BACKGROUND work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): it is starved first, at 60%
// consumption, so a bulk sweep can never be the reason a practice manager's screen or
// a patient's booking calendar goes blank. A refusal aborts this run; the next tick
// retries. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
