import { draftReactivation } from "@/lib/reactivation/draft";
import { stepDef, advanceAfter } from "@/lib/reactivation/cadence";
import {
  listDueCadences,
  getTarget,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  markTouchSent,
  incrementPriorAttempts,
  updateCadence,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import type { ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";

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

    const step = stepDef(cadence.currentStep + 1);
    if (!step) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      await setTargetStatus(target.id, "exhausted");
      exhausted += 1;
      continue;
    }

    // Respect consent; pause if the step's channel is not consented.
    if (!channelConsented(target, step.channel)) {
      await updateCadence(cadence.id, { status: "paused" });
      paused += 1;
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
      // Low value: auto approve, queue, send (stub), advance.
      await approveTouch(touch.id, "auto");
      await enqueueOutbox({
        touchId: touch.id,
        siteId: target.siteId,
        channel: step.channel,
        toRef: patientToRef(target),
        body,
      });
      await markTouchSent(touch.id);
      await incrementPriorAttempts(target.id);
      const adv = advanceAfter(step.step, now);
      await updateCadence(cadence.id, {
        currentStep: adv.currentStep,
        status: adv.status,
        nextDueAt: adv.nextDueAt,
        endedAt: adv.endedAt,
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
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
