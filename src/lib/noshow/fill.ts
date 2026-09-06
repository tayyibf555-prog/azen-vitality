// Waitlist auto-fill: offer a freed slot to the next eligible waiting patient.
// Used both on cancellation (inbound) and on offer expiry (sweep). Server-side
// (goes through the repository / service client).

import { draftSlotOffer } from "./draft";
import { pickCandidate } from "./waitlist";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
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
  // ===========================================================================
  // THE KILL SWITCH LIVES HERE, NOT IN THE CALLERS, AND THAT IS THE FIX.
  //
  // This function is the ONLY thing in the platform that queues a waitlist slot
  // offer, and the owner's own words for the no-show switch are "Appointment
  // confirmations, reminders and waitlist fill stop." It had four call sites and
  // the guard was written three times:
  //
  //   src/app/api/noshow/sweep/route.ts     isSystemEnabled, top of the run
  //   src/app/api/noshow/[action]/route.ts  systemOff(), per request
  //   src/lib/noshow/inbound.ts             gated by the inbound webhook
  //   src/app/api/sync/noshow/route.ts      NOTHING. No toggle read in the file.
  //
  // The fourth is not a hypothetical. The Dentally reconciliation pass calls this
  // for every appointment that was cancelled at the desk, so with the system
  // switched OFF it still drafted an offer, wrote a noshow_touch and left a real
  // patient SMS sitting in noshow_outbox. The shared drain would not send it while
  // the switch stayed off — but rows survive for MAX_ROW_AGE_MS (48 hours), so an
  // owner who switched the system off and back on within two days got a burst of
  // offers for slots they had already dealt with by hand.
  //
  // A fourth copy of the guard would have closed today's hole and left the shape
  // intact for the fifth caller. The guard belongs to the SEND, so it lives with
  // the send. FAIL DIRECTION: isSystemEnabledForSend, i.e. fail-open only while
  // MESSAGING_DRY_RUN is on and fail-CLOSED once messaging is live — the same
  // posture as every other send choke point. A slot that goes unoffered during a
  // toggle-table blip is re-offered by the next sweep tick; a text sent for a
  // system the owner switched off cannot be recalled.
  //
  // UNCONDITIONAL, and that matters as much as where it lives. The client used to
  // be read as `getSite(slot.siteId)?.clientId` with the check itself written
  // `if (clientId && !(await ...))`, so a slot on a site id SITES no longer maps —
  // a site renamed or retired in src/lib/mock/clients.ts while noshow_slot_offer /
  // noshow_waitlist rows written under the old id are still live, or a second
  // practice onboarded before its SITES entry lands — short-circuited past the
  // switch entirely and went on to draft, create the offer, write a noshow_touch
  // and queue a real patient SMS. Delivery was then stopped only incidentally,
  // because the drain lists by vitalitySiteIds() off the same SITES table; a kill
  // switch whose protection rests on a SECOND lookup failing the same way is not a
  // kill switch. The practice's own client id is the fallback, exactly as
  // /api/speed-to-lead/[action] and /api/speed-to-lead/intake do it.
  // ===========================================================================
  const clientId = getSite(slot.siteId)?.clientId ?? "vitality";
  if (!(await isSystemEnabledForSend(clientId, "no-show-defence"))) {
    console.warn(
      `[noshow] waitlist fill skipped for site ${slot.siteId}: the no-show defence system is switched off`,
    );
    return null;
  }

  // Never offer a slot that no longer exists in time. A cancellation can arrive
  // after the appointment has already started, and an offer's TTL can outlive a
  // near-term slot, so both the inbound and sweep re-offer paths can reach here
  // with a past start. Offering it would text a patient an appointment they can
  // never attend and create an offer with a future expiry for a dead slot.
  const startAt = new Date(slot.startAt).getTime();
  if (Number.isNaN(startAt) || startAt <= now.getTime()) return null;

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
    siteId: slot.siteId,
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
