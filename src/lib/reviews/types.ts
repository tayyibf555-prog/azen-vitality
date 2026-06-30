// Reviews & reputation domain types.
//
// The channel / touch types are shared with reactivation so the reused outbox +
// drain contracts stay identical (the shared drain lists queued review_outbox
// rows and dispatches them exactly as it does no-show / recall). Reviews adds its
// own request shape keyed by appointment.

export type {
  TouchChannel,
  TouchStatus,
  DraftedBy,
  ReactivationTouch,
  ReactivationOutboxItem,
} from "@/lib/reactivation/types";

// scheduled  -> a review request is queued for send_at, not yet sent
// sent        -> the review-request message has been drafted, enqueued and dispatched
// skipped     -> deliberately not sent (e.g. attended:false, or no consent at attend time)
// suppressed  -> the patient opted out before the send, so the sweep blocked it
// failed      -> the send could not be completed
export type ReviewStatus =
  | "scheduled"
  | "sent"
  | "skipped"
  | "suppressed"
  | "failed";

export interface ReviewRequest {
  id: string;
  siteId: string;
  dentallyAppointmentId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: import("@/lib/reactivation/types").TouchChannel;
  attendedAt: string;          // ISO, when the appointment was marked attended
  sendAt: string;              // ISO, when the review request is due to send
  status: ReviewStatus;
  createdAt: string;
}
