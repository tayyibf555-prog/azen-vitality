// No-show inbound handling: structured replies to a confirmation/reminder
// (YES = confirm, CANCEL = free the slot + offer the waitlist) and to a waitlist
// slot offer (YES = claim + book, NO = decline + re-offer). Called early from the
// shared Twilio inbound webhook; returns handled:false to fall through to the agent.

import { DentallyClient } from "@/lib/dentally/client";
import { isStopKeyword } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import type { FreedSlot } from "./types";
import {
  claimOffer,
  findOpenOfferByAddress,
  findTargetByAddress,
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
function isCancel(body: string): boolean {
  return /^\s*(cancel|no\b|can'?t|cannot|unable)/i.test(body);
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
  now?: Date;
}): Promise<NoshowInboundResult> {
  const now = input.now ?? new Date();

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
      // Atomically claim this offer; if another reply won, or the slot is already
      // filled, stop here so two patients can never both book the same time.
      const claimed = await claimOffer(offer.id);
      if (!claimed || (await slotIsFilled(offer.freedAppointmentId))) {
        return { handled: true, reply: taken };
      }
      try {
        await input.dentally.createAppointment({
          patient_id: offer.dentallyPatientId,
          start_time: offer.freedStartAt,
          duration: offer.durationMin,
          site_id: offer.siteId,
          ...(offer.practitioner ? { practitioner: offer.practitioner } : {}),
          reason: "Waitlist fill",
          booked_via_api: true,
        });
      } catch {
        // Booking failed: release this claim and pass the slot to the next person
        // rather than freezing it until the offer's TTL.
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
        return { handled: true, reply: taken };
      }
      await setOfferStatus(offer.id, "filled", now.toISOString());
      await setWaitlistStatus(offer.waitlistId, "booked");
      return { handled: true, reply: "Brilliant, you are booked in. We look forward to seeing you." };
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

    if (isYes(input.body)) {
      await setTargetStatus(t.targetId, "confirmed");
      if (cadence) await updateCadence(cadence.id, { status: "confirmed", endedAt: now.toISOString() });
      return { handled: true, reply: "Thanks for confirming, we look forward to seeing you." };
    }
    if (isCancel(input.body)) {
      if (target) {
        try {
          await input.dentally.cancelAppointment(target.appointmentId);
        } catch {
          /* best effort: still record our side so the slot can be reused */
        }
        await setTargetStatus(t.targetId, "cancelled");
        if (cadence) await updateCadence(cadence.id, { status: "cancelled", endedAt: now.toISOString() });
        const slot: FreedSlot = {
          appointmentId: target.appointmentId,
          siteId: target.siteId,
          startAt: target.appointmentStartAt,
          durationMin: target.durationMin || 30,
          practitioner: target.practitioner,
        };
        await offerSlotToNextCandidate(slot, now);
      }
      return {
        handled: true,
        reply: "That is cancelled for you. If you would like to rebook, just let me know a day that suits and I will find a time.",
      };
    }

    // Other message from a defended patient: pause reminders and let the agent
    // handle it (e.g. a reschedule request).
    if (cadence && cadence.status === "active") await updateCadence(cadence.id, { status: "paused" });
    return { handled: false };
  }

  return { handled: false };
}
