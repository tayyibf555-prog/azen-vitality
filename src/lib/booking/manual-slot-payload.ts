import { BOOKING_SLOT_DURATION_MIN, type BookingSlot } from "@/lib/booking/slots";

// ---------------------------------------------------------------------------
// The request body a manual dashboard booking must POST.
//
// Recall, reactivation and the treatment coordinator all send their "Book
// appointment" through buildManualBookingPayload (src/lib/dentally/write.ts),
// which refuses anything without BOTH an end time and a practitioner, because
// real Dentally rejects such a write. The drawers used to post a start time and
// nothing else, so every click came back a 400 and the button had never once
// worked. Building the body here, from a slot the user actually picked out of
// live availability, is what keeps the two ends in agreement.
//
// Pure: no clock, no I/O, no React. Unit tested against buildManualBookingPayload
// itself, so the contract cannot drift apart again.
// ---------------------------------------------------------------------------

/** The fixed length every bookable slot is quoted at, for UI labels. */
export const SLOT_DURATION_LABEL = `${BOOKING_SLOT_DURATION_MIN} min`;

export interface ManualBookingFields {
  /** Slot start, ISO, exactly as Dentally returned it. */
  start: string;
  /** Slot end, ISO. Dentally rejects a booking without one. */
  finish_time: string;
  /** The slot's clinician. Dentally rejects a booking without one. */
  practitioner_id: string;
}

export type ManualBookingFieldsResult = { fields: ManualBookingFields } | { error: string };

/**
 * Turn a picked availability slot into the fields the booking endpoints require.
 * Every rejection carries a line a coordinator can act on, because these surface
 * verbatim in the drawer.
 */
export function manualBookingFieldsFromSlot(slot: BookingSlot | null | undefined): ManualBookingFieldsResult {
  if (!slot) return { error: "Choose a time first." };
  if (!slot.start || Number.isNaN(Date.parse(slot.start))) {
    return { error: "That time could not be read. Please pick another slot." };
  }
  if (!slot.finish || Number.isNaN(Date.parse(slot.finish))) {
    return { error: "That time has no end time, so it cannot be booked. Please pick another slot." };
  }
  if (Date.parse(slot.finish) <= Date.parse(slot.start)) {
    return { error: "That time ends before it starts, so it cannot be booked. Please pick another slot." };
  }
  if (!slot.practitionerId) {
    return { error: "That time has no clinician attached, so it cannot be booked. Please pick another slot." };
  }
  return {
    fields: {
      start: slot.start,
      finish_time: slot.finish,
      practitioner_id: slot.practitionerId,
    },
  };
}
