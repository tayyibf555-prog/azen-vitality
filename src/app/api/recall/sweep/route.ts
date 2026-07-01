import { draftRecall } from "@/lib/recall/draft";
import { stepDef, advanceAfter, RECALL_CADENCE } from "@/lib/recall/cadence";
import { shouldGraduate } from "@/lib/recall/normalise";
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
} from "@/lib/recall/repository";
import type { RecallTarget } from "@/lib/recall/types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

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

function channelConsented(t: RecallTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: RecallTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

async function settleExhausted(target: RecallTarget, now: Date): Promise<void> {
  const overdueNow = (now.getTime() - new Date(target.dueAt).getTime()) / DAY;
  if (shouldGraduate(overdueNow, graceDays())) {
    await markGraduated(target.id);
  } else {
    await setTargetStatus(target.id, "exhausted");
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

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

  let drafted = 0;
  let queued = 0;
  let exhausted = 0;
  let graduated = 0;
  let paused = 0;

  for (const cadence of due) {
    const target = await getTarget(cadence.targetId);
    if (!target) continue;

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
      const overdueNow = (now.getTime() - new Date(target.dueAt).getTime()) / DAY;
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

    // Recall auto-sends: draft, approve, queue, send (stub), advance.
    const { body } = await draftRecall(target, step.channel, step);
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
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel: step.channel,
      toRef: patientToRef(target),
      body,
    });
    // Do NOT markTouchSent here. Leaving the outbox row 'queued' lets the shared
    // drain deliver it via Twilio and write to_address (the only thing inbound
    // reply correlation matches on). Marking it sent here would stub the send and
    // orphan replies. Mirrors the coordinator auto-send path.
    await incrementPriorAttempts(target.id);

    const adv = advanceAfter(step.step, now, RECALL_CADENCE);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
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
  });
  } finally {
    await releaseCronLock("sweep-recall");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
