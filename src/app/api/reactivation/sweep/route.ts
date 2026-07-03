import { draftReactivation } from "@/lib/reactivation/draft";
import { stepDef, advanceAfter } from "@/lib/reactivation/cadence";
import {
  listDueCadences,
  getTarget,
  listTouches,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  incrementPriorAttempts,
  updateCadence,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import type { ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function autoSendThreshold(): number {
  return Number(process.env.REACTIVATION_AUTO_SEND_THRESHOLD ?? 250);
}

function channelConsented(t: ReactivationTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: ReactivationTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Never overlap with another reactivation sweep: two runs would both see the
  // same due cadences and draft+queue duplicates. The lease must OUTLIVE
  // maxDuration (300s): a shorter lease would expire while a slow run was still
  // working, letting the next tick double-queue. A crashed run still self-heals:
  // the lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("sweep-reactivation", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
  const now = new Date();
  const due = await listDueCadences(now.toISOString());

  let drafted = 0;
  let queued = 0;
  let awaitingApproval = 0;
  let exhausted = 0;
  let paused = 0;

  for (const cadence of due) {
    const target = await getTarget(cadence.targetId);
    if (!target) continue;

    // Skip if an outbound touch is already pending (approved-but-unsent etc.):
    // the manual approve→send flow enqueues at approve and only advances the
    // cadence at send, so an approval without a send leaves the cadence 'due';
    // without this guard the next sweep would draft a SECOND message for the
    // same step and the drain would send both. Mirrors the coordinator sweep.
    const touches = await listTouches(target.id);
    const hasPending = touches.some(
      (t) => t.direction !== "inbound" && t.status !== "sent" && t.status !== "failed",
    );
    if (hasPending) {
      paused += 1;
      continue;
    }

    const step = stepDef(cadence.currentStep + 1);
    if (!step) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      await setTargetStatus(target.id, "exhausted");
      exhausted += 1;
      continue;
    }

    // Respect consent, but do NOT pause forever on an un-consented step: a patient
    // consented on a different channel (e.g. SMS-only) would otherwise stall permanently
    // at an email step. SKIP the step and advance the cadence; if that exhausts it (no
    // remaining step has a consented channel), settle it.
    if (!channelConsented(target, step.channel)) {
      const adv = advanceAfter(step.step, now);
      await updateCadence(cadence.id, {
        currentStep: adv.currentStep,
        status: adv.status,
        nextDueAt: adv.nextDueAt,
        endedAt: adv.endedAt,
      });
      if (adv.status === "exhausted") {
        await setTargetStatus(target.id, "exhausted");
        exhausted += 1;
      } else {
        paused += 1; // counted as a skip for this tick; the next step is tried next run
      }
      continue;
    }

    const { body } = await draftReactivation(target, step.channel, step);
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

    if (target.recoverableValue < autoSendThreshold()) {
      // Low value: auto approve + queue. Do NOT markTouchSent here; leaving the
      // outbox row 'queued' lets the shared drain deliver it and write to_address
      // (the only thing inbound reply correlation matches on). Stubbing it here
      // would orphan replies and skip the real send. Mirrors the coordinator sweep.
      await approveTouch(touch.id, "auto");
      // Advance the cadence BEFORE enqueuing, so a kill between here and the enqueue
      // skips a message rather than re-sending this step next tick.
      await incrementPriorAttempts(target.id);
      const adv = advanceAfter(step.step, now);
      await updateCadence(cadence.id, {
        currentStep: adv.currentStep,
        status: adv.status,
        nextDueAt: adv.nextDueAt,
        endedAt: adv.endedAt,
      });
      // Leave the outbox row 'queued' so the shared drain delivers it and writes
      // to_address (inbound reply correlation matches on it).
      await enqueueOutbox({
        touchId: touch.id,
        siteId: target.siteId,
        channel: step.channel,
        toRef: patientToRef(target),
        body,
      });
      if (adv.status === "exhausted") await setTargetStatus(target.id, "exhausted");
      queued += 1;
    } else {
      // High value: hold for coordinator approval.
      await updateCadence(cadence.id, { status: "awaiting_approval" });
      awaitingApproval += 1;
    }
  }

  return Response.json({
    ok: true,
    swept: due.length,
    drafted,
    queued,
    awaitingApproval,
    paused,
    exhausted,
  });
  } finally {
    await releaseCronLock("sweep-reactivation");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
