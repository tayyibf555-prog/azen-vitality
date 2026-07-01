import { draftNoshow } from "@/lib/noshow/draft";
import { stepDef, advanceAfter, NOSHOW_CADENCE } from "@/lib/noshow/cadence";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";
import {
  listDueCadences,
  getTarget,
  incrementPriorAttempts,
  updateCadence,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  listExpiredOffers,
  setOfferStatus,
  setWaitlistStatus,
} from "@/lib/noshow/repository";
import type { NoshowTarget } from "@/lib/noshow/types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";

function channelConsented(t: NoshowTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: NoshowTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // Never overlap with another no-show sweep: two runs would both see the same
  // due cadences (and expired offers) and double-send / double-reoffer. The lease
  // must OUTLIVE maxDuration (300s): a shorter lease would expire while a slow run
  // was still working, letting the next tick double-send. A crashed run still
  // self-heals: the lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("sweep-noshow", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
  const now = new Date();

  // A) Send due confirmations / reminders.
  const due = await listDueCadences(now.toISOString());
  let sent = 0;
  let ended = 0;
  for (const cadence of due) {
    const target = await getTarget(cadence.targetId);
    if (!target) continue;

    const appointmentStart = new Date(target.appointmentStartAt);
    // Stop once the patient has resolved (confirmed/cancelled) or the appointment
    // has started: no point reminding any further.
    if (target.status !== "scheduled" || appointmentStart.getTime() <= now.getTime()) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      ended += 1;
      continue;
    }

    const step = stepDef(cadence.currentStep + 1, NOSHOW_CADENCE);
    if (!step) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      ended += 1;
      continue;
    }
    if (!channelConsented(target, step.channel)) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      ended += 1;
      continue;
    }

    const { body } = await draftNoshow(target, step.channel, step);
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
    await approveTouch(touch.id, "auto");
    // Leave the outbox row 'queued' so the shared drain dispatches it via Twilio
    // and records to_address + the provider message id. The drain is what makes
    // a patient's YES/CANCEL reply correlate back to this target; stub-sending
    // here would skip delivery and break the two-way confirmation loop.
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel: step.channel,
      toRef: patientToRef(target),
      body,
    });
    await incrementPriorAttempts(target.id);

    const adv = advanceAfter(step.step, appointmentStart, now, NOSHOW_CADENCE);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
    });
    sent += 1;
  }

  // B) Expire stale waitlist offers and re-offer the freed slot to the next person.
  const expired = await listExpiredOffers(now.toISOString());
  let offersExpired = 0;
  let reoffered = 0;
  for (const offer of expired) {
    await setOfferStatus(offer.id, "expired", now.toISOString());
    await setWaitlistStatus(offer.waitlistId, "waiting");
    offersExpired += 1;
    const next = await offerSlotToNextCandidate(
      {
        appointmentId: offer.freedAppointmentId,
        siteId: offer.siteId,
        startAt: offer.freedStartAt,
        durationMin: offer.durationMin,
        practitioner: offer.practitioner,
      },
      now,
    );
    if (next) reoffered += 1;
  }

  return Response.json({ ok: true, swept: due.length, sent, ended, offersExpired, reoffered });
  } finally {
    await releaseCronLock("sweep-noshow");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
