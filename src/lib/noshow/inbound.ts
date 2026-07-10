// No-show inbound handling: structured replies to a confirmation/reminder
// (YES = confirm, CANCEL = cancel + offer the slot) and to a waitlist slot offer
// (YES = claim, NO = decline + re-offer). Called early from the shared Twilio
// inbound webhook; returns handled:false to fall through to the agent.

import { DentallyClient } from "@/lib/dentally/client";
import { isDentallyWriteEnabled } from "@/lib/dentally/write";
import { isStopKeyword } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  claimOffer,
  findOpenOfferByAddress,
  findTargetByAddress,
  listActiveTargetIdsByAddress,
  getCadenceByTarget,
  getTarget,
  insertInboundTouch,
  setOfferStatus,
  setTargetStatus,
  setWaitlistStatus,
  slotIsFilled,
  updateCadence,
} from "./repository";
import { offerSlotToNextCandidate } from "./fill";

// Anchored to the start so "no problem" / "not sure" do not read as a cancel.
function isYes(body: string): boolean {
  return /^\s*(yes|y|confirm|confirmed|ok|okay|yep|yeah|👍)\b/i.test(body);
}
// Only an EXPLICIT cancel/decline intent. A bare "no" (optionally punctuated) or
// "no thanks" counts, and "can't/cannot/unable/won't" count ONLY when followed by
// attendance words ("can't make it", "cannot attend") — a cheerful "Can't wait!"
// must never cancel a real appointment. Anything ambiguous falls through to the
// agent, which is far safer than a destructive cancel on a false positive.
function isCancel(body: string): boolean {
  return /^\s*(sorry[,!.\s]+)?((i|we)\s+)?(cancel\b|(need|have)\s+to\s+cancel\b|(can'?t|cannot|won'?t|unable\s+to)\s+(make|come|attend|do|be\s+there)\b|no\s*[.,!]?\s*$|no\s+(thanks|thank you|thankyou)\b)/i.test(
    body,
  );
}

export interface NoshowInboundResult {
  handled: boolean;
  reply?: string;
}

export async function handleNoshowInbound(input: {
  from: string;
  body: string;
  channel: MessageChannel;
  dentally: DentallyClient;
  // The site this inbound belongs to, when the caller can determine it. In a
  // multi-site practice sharing one number, this prevents a YES/NO reply from
  // resolving against a live offer on a DIFFERENT site. Optional: when unknown,
  // findOpenOfferByAddress pins to the most-recent offer's own site instead.
  siteId?: string;
  // Whether real Dentally writes are permitted. Defaults to the deployment gate;
  // injectable so tests can exercise both paths without touching process.env.
  writesEnabled?: boolean;
  now?: Date;
}): Promise<NoshowInboundResult> {
  const now = input.now ?? new Date();
  const writesEnabled = input.writesEnabled ?? isDentallyWriteEnabled();

  // A carrier-standard opt-out keyword (STOP/END/QUIT/UNSUBSCRIBE/CANCEL) must
  // always reach the suppression path, never be read as an appointment cancel or
  // offer decline. Fall through so the webhook records the suppression.
  if (isStopKeyword(input.body)) return { handled: false };

  // 1) An open waitlist offer to this number takes priority. Site-scoped so a
  // reply cannot resolve an offer on a different site sharing this number.
  const offer = await findOpenOfferByAddress(input.from, input.siteId);
  if (offer) {
    const taken = "Sorry, that slot has just been taken. We will keep you on the list for the next opening.";
    if (isYes(input.body)) {
      // If the freed slot has already started (the patient replied YES after the
      // appointment time passed, e.g. an offer sent late in the day and answered
      // the next morning), it can no longer be booked. Expire this offer and keep
      // them on the waitlist rather than creating a past-dated Dentally booking.
      if (new Date(offer.freedStartAt).getTime() <= now.getTime()) {
        await setOfferStatus(offer.id, "expired", now.toISOString());
        await setWaitlistStatus(offer.waitlistId, "waiting");
        return {
          handled: true,
          reply: "Sorry, that slot has now passed. We will keep you on the list and let you know the moment another opening comes up.",
        };
      }
      // Atomically claim this offer; if another reply won, or the slot is already
      // filled, stop here so two patients can never both book the same time.
      const claimed = await claimOffer(offer.id);
      if (!claimed || (await slotIsFilled(offer.freedAppointmentId))) {
        return { handled: true, reply: taken };
      }
      // The slot is theirs on OUR side; reception makes the Dentally booking.
      // We deliberately do NOT createAppointment here: the offer only carries a
      // practitioner NAME (real Dentally requires practitioner_id + finish_time),
      // and the diary may have been refilled at the desk since the slot freed —
      // an unverified automatic write risks a double-booking. The accepted offer
      // is the staff work item; the copy promises confirmation, not a done deal.
      await setWaitlistStatus(offer.waitlistId, "booked");
      return {
        handled: true,
        reply: "Lovely, that time is yours. Reception will confirm your booking shortly.",
      };
    }
    if (isCancel(input.body)) {
      await setOfferStatus(offer.id, "declined", now.toISOString());
      await setWaitlistStatus(offer.waitlistId, "waiting");
      await offerSlotToNextCandidate(
        {
          appointmentId: offer.freedAppointmentId,
          siteId: offer.siteId,
          startAt: offer.freedStartAt,
          durationMin: offer.durationMin,
          practitioner: offer.practitioner,
        },
        now,
      );
      return { handled: true, reply: "No problem, we will keep you on the list for the next opening." };
    }
    // Ambiguous reply to an offer: let the agent help rather than guess.
    return { handled: false };
  }

  // 2) A confirmation/reminder for this number's own appointment.
  const t = await findTargetByAddress(input.from);
  if (t) {
    const target = await getTarget(t.targetId);
    const cadence = await getCadenceByTarget(t.targetId);
    await insertInboundTouch({
      targetId: t.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: t.siteId,
      channel: input.channel,
      body: input.body,
    });

    // A YES/CANCEL from a patient with MORE THAN ONE live defended appointment is
    // ambiguous: resolving against "most recently messaged" can confirm — or worse,
    // cancel — the WRONG appointment. Hand these to the agent, which lists the
    // patient's appointments and confirms exactly which one they mean.
    if (isYes(input.body) || isCancel(input.body)) {
      const active = await listActiveTargetIdsByAddress(input.from);
      if (active.length > 1) {
        if (cadence && cadence.status === "active") {
          await updateCadence(cadence.id, { status: "paused" });
        }
        return { handled: false };
      }
    }

    if (isYes(input.body)) {
      await setTargetStatus(t.targetId, "confirmed");
      if (cadence) await updateCadence(cadence.id, { status: "confirmed", endedAt: now.toISOString() });
      return { handled: true, reply: "Thanks for confirming, we look forward to seeing you." };
    }
    if (isCancel(input.body)) {
      // Stop reminders either way: the patient has told us they are not coming.
      await setTargetStatus(t.targetId, "cancelled");
      if (cadence) await updateCadence(cadence.id, { status: "cancelled", endedAt: now.toISOString() });

      // Only claim the appointment is cancelled if Dentally ACTUALLY cancelled it.
      // Telling a patient "that is cancelled" while the diary still expects them
      // (writes disabled, wrong key, transient error) strands them as a recorded
      // no-show — and offering the "freed" slot to the waitlist double-books it.
      let dentallyCancelled = false;
      if (target && writesEnabled) {
        try {
          await input.dentally.cancelAppointment(target.appointmentId);
          dentallyCancelled = true;
        } catch {
          // Fall through to the reception handoff reply below.
        }
      }
      if (target && dentallyCancelled) {
        await offerSlotToNextCandidate(
          {
            appointmentId: target.appointmentId,
            siteId: target.siteId,
            startAt: target.appointmentStartAt,
            durationMin: target.durationMin || 30,
            practitioner: target.practitioner,
          },
          now,
        );
        return {
          handled: true,
          reply: "That is cancelled for you. If you would like to rebook, just let me know a day that suits and I will find a time.",
        };
      }
      return {
        handled: true,
        reply: "Thanks for letting us know. I have passed your cancellation to reception and they will confirm it shortly. If you would like to rebook, just let me know a day that suits.",
      };
    }

    // Other message from a defended patient: pause reminders and let the agent
    // handle it (e.g. a reschedule request).
    if (cadence && cadence.status === "active") await updateCadence(cadence.id, { status: "paused" });
    return { handled: false };
  }

  return { handled: false };
}
