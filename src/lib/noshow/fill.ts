// Waitlist auto-fill: offer a freed slot to the next eligible waiting patient.
// Used both on cancellation (inbound) and on offer expiry (sweep). Server-side
// (goes through the repository / service client).

import { draftSlotOffer } from "./draft";
import { pickCandidate } from "./waitlist";
import type { FreedSlot } from "./types";
import {
  approveTouch,
  createSlotOffer,
  enqueueOutbox,
  insertTouch,
  listOffersForSlot,
  listWaitlist,
  setOfferTouch,
  setWaitlistStatus,
} from "./repository";

const HOUR = 3_600_000;

function offerTtlHours(): number {
  return Number(process.env.NOSHOW_OFFER_TTL_HOURS ?? 4);
}

function patientToRef(patientId: string): string {
  return `patient:${patientId}`;
}

/**
 * Offer a freed slot to the next eligible waitlist patient and queue the offer
 * SMS. One live offer per slot at a time; entries already tried are skipped.
 * Returns the waitlist id offered to, or null if the slot is taken / nobody fits.
 */
export async function offerSlotToNextCandidate(
  slot: FreedSlot,
  now: Date = new Date(),
): Promise<{ waitlistId: string } | null> {
  const prior = await listOffersForSlot(slot.appointmentId);
  if (prior.some((o) => o.status === "filled")) return null; // slot already taken
  if (prior.some((o) => o.status === "offered")) return null; // a live offer is out
  const excludeIds = new Set(prior.map((o) => o.waitlistId)); // already declined/expired

  const waiting = await listWaitlist({ siteIds: [slot.siteId], statuses: ["waiting"] });
  const candidate = pickCandidate(waiting, slot, excludeIds);
  if (!candidate) return null;

  const expiresAt = new Date(now.getTime() + offerTtlHours() * HOUR).toISOString();
  const offer = await createSlotOffer({
    siteId: slot.siteId,
    waitlistId: candidate.id,
    dentallyPatientId: candidate.dentallyPatientId,
    freedAppointmentId: slot.appointmentId,
    freedStartAt: slot.startAt,
    durationMin: slot.durationMin,
    practitioner: slot.practitioner,
    expiresAt,
  });

  const body = draftSlotOffer({
    patientName: candidate.patientName,
    startAt: slot.startAt,
    practitioner: slot.practitioner,
  });
  // Offer touches are not tied to a defended target (target_id null).
  const touch = await insertTouch({
    targetId: null,
    cadenceId: null,
    siteId: slot.siteId,
    step: 0,
    channel: "sms",
    body,
    draftedBy: "claude",
    status: "draft",
  });
  await approveTouch(touch.id, "auto");
  await enqueueOutbox({
    touchId: touch.id,
    siteId: slot.siteId,
    channel: "sms",
    toRef: patientToRef(candidate.dentallyPatientId),
    body,
  });
  await setOfferTouch(offer.id, touch.id);
  await setWaitlistStatus(candidate.id, "offered");
  return { waitlistId: candidate.id };
}
