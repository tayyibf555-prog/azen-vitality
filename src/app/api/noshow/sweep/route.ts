import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { draftNoshow } from "@/lib/noshow/draft";
import { stepDef, advanceAfter, NOSHOW_CADENCE } from "@/lib/noshow/cadence";
import type { NoshowStep } from "@/lib/noshow/cadence";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";
import { noshowSendCap, disposeCadence, orderBySoonestAppointment, applySendCap } from "@/lib/noshow/ramp";
import {
  listDueCadences,
  getTarget,
  incrementPriorAttempts,
  updateCadence,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  listExpiredOffers,
  expireOffer,
  setWaitlistStatus,
} from "@/lib/noshow/repository";
import type { NoshowTarget, NoshowCadence } from "@/lib/noshow/types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import { liveSwitch } from "@/lib/systems/live-switch";
import {
  loadExcludedTargetKeys,
  excludedTargetKey,
  isExclusionsUnavailable,
} from "@/lib/patient-status/repository";

export const dynamic = "force-dynamic";

function channelConsented(t: NoshowTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: NoshowTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

async function handleWithDentallyPriority(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // FAIL-CLOSED WHEN LIVE (ruling W1-B/1, 3 Sep 2026). This used to be
  // isSystemEnabled, which resolves a toggle-read ERROR to "enabled" for a
  // default-ON system and then let the whole batch draft. isSystemEnabledForSend
  // keeps that behaviour while MESSAGING_DRY_RUN is on, so development against a
  // partial database still works, and fails CLOSED once messaging is live: a
  // switch we cannot read is treated as off. A skipped tick is a delay; a batch
  // sent against an unknown switch is an incident.
  if (!(await isSystemEnabledForSend("vitality", "no-show-defence"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

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

  // Platform admin status: patients marked inactive / do_not_contact are excluded from
  // no-show confirmations too. Loaded ONCE per sweep and checked per target before
  // drafting. Skipped (not exhausted) so reminders resume if the override is lifted while
  // the appointment is still upcoming; a passed appointment exhausts the cadence anyway.
  // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED (ruling W1-B/2, 3 Sep 2026).
  // loadExcludedTargetKeys throws once messaging is LIVE and it cannot read the
  // override table, so a patient a human marked inactive can never be drafted
  // because of a database blip. It still returns an empty set under dry-run.
  let excludedKeys: Set<string>;
  try {
    excludedKeys = await loadExcludedTargetKeys();
  } catch (err) {
    if (!isExclusionsUnavailable(err)) throw err;
    console.error("[noshow] exclusion list unreadable while messaging is live; skipping this tick", err);
    return Response.json({ ok: true, skipped: "exclusions unavailable" });
  }

  // A) Due confirmations / reminders, in TWO passes (see lib/noshow/ramp.ts).
  //
  // Interleaving settle-and-send was safe only while the sweep sent everything it
  // found. It cannot survive a send cap: the moment a cap stops the loop, every
  // stale cadence after the cut-off is stranded in the due list and re-read on
  // every future tick, for ever. So: settle the whole backlog first (free — no
  // message, no LLM draft), then send a bounded slice of what genuinely remains.
  const due = await listDueCadences(now.toISOString());
  let sent = 0;
  let ended = 0;
  let failedCadences = 0;
  let suppressed = 0;

  // A1) SETTLE. Close every cadence that can never send again, and collect the
  //     ones that genuinely can.
  const sendable: Array<{ cadence: NoshowCadence; target: NoshowTarget; step: NoshowStep }> = [];
  for (const cadence of due) {
    // One bad cadence (a transient DB error) must not abort the whole sweep and
    // strand every later due cadence. Isolate each iteration: log and carry on.
    try {
      const target = await getTarget(cadence.targetId);
      if (!target) continue;

      const step = stepDef(cadence.currentStep + 1, NOSHOW_CADENCE);
      const disposition = disposeCadence(
        {
          // Platform admin status excludes this patient from confirmations.
          excluded: excludedKeys.has(excludedTargetKey(target.siteId, target.dentallyPatientId)),
          targetStatus: target.status,
          appointmentStartAt: target.appointmentStartAt,
          hasNextStep: step !== null,
          channelConsented: step ? channelConsented(target, step.channel) : false,
        },
        now,
      );

      if (disposition === "suppress") {
        suppressed += 1;
        continue;
      }
      if (disposition === "expire") {
        await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
        ended += 1;
        continue;
      }
      // disposeCadence only answers "send" when hasNextStep was true, so `step` is
      // non-null here; this is the type narrowing, not a second rule.
      if (!step) continue;
      sendable.push({ cadence, target, step });
    } catch (err) {
      failedCadences += 1;
      console.error(`[noshow-sweep] settling cadence ${cadence.id} failed; skipping to the next`, err);
    }
  }

  // A2) SEND, bounded. Most imminent appointment first, so a squeezed cap is
  //     spent on the patients whose appointment is closest. Deferred cadences are
  //     NOT touched: they stay active with next_due_at in the past, which is
  //     exactly the state listDueCadences selects on, so the next tick takes them.
  const sendCap = noshowSendCap();
  const { send, deferred } = applySendCap(orderBySoonestAppointment(sendable), sendCap);
  // The switch is re-read every ten rows for the rest of this run (ruling
  // W1-B/5): a long sweep must not keep drafting after the owner has switched
  // the system off. See src/lib/systems/live-switch.ts.
  const gate = liveSwitch("vitality", "no-show-defence");

  for (const { cadence, target, step } of send) {
    if (!(await gate.stillOn())) break;
    // A transient DB/LLM error on one message must not abort the rest of the run.
    try {
      const appointmentStart = new Date(target.appointmentStartAt);

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

      // Advance the cadence BEFORE enqueuing the outbox row. If the run is killed
      // between here and enqueue, the cadence has moved past this step, so the next
      // tick sends the NEXT step rather than re-sending this one — a skipped message
      // beats a double-text. (A kill in the old order left the cadence pointing at
      // this step with next_due_at <= now, so the next sweep re-drafted and re-sent it.)
      const adv = advanceAfter(step.step, appointmentStart, now, NOSHOW_CADENCE);
      await updateCadence(cadence.id, {
        currentStep: adv.currentStep,
        status: adv.status,
        nextDueAt: adv.nextDueAt,
        endedAt: adv.endedAt,
      });

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
      sent += 1;
    } catch (err) {
      failedCadences += 1;
      console.error(`[noshow-sweep] cadence ${cadence.id} failed; skipping to the next`, err);
    }
  }

  // B) Expire stale waitlist offers and re-offer the freed slot to the next person.
  const expired = await listExpiredOffers(now.toISOString());
  let offersExpired = 0;
  let reoffered = 0;
  for (const offer of expired) {
    try {
      // Guarded expiry: only transition an offer that is STILL 'offered'. If a
      // patient's YES claimed it ('offered' -> 'accepted') between the list and now,
      // expireOffer returns false and we must NOT reset the waitlist entry or re-offer
      // the slot — otherwise we would give away a slot the patient just booked.
      const didExpire = await expireOffer(offer.id, now.toISOString());
      if (!didExpire) continue;
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
    } catch (err) {
      console.error(`[noshow-sweep] expiring offer ${offer.id} failed; skipping to the next`, err);
    }
  }

  // `deferred` is the ramp made observable: on the first ticks after switch-on it
  // is large and falling, and if it never falls the cap is too tight for the
  // practice's volume (raise NOSHOW_MAX_SENDS_PER_RUN).
  return Response.json({
    ok: true,
    swept: due.length,
    sendCap,
    sendable: sendable.length,
    sent,
    deferred: deferred.length,
    ended,
    offersExpired,
    reoffered,
    failedCadences,
    suppressed,
  });
  } finally {
    await releaseCronLock("sweep-noshow");
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
