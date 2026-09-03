import type { DeliveryStatus } from "./types";

/**
 * What a message's stored status MEANS on a patient record, as its own pure module.
 *
 * WHY THIS EXISTS. The Correspondence tab used to render a body of text and a
 * timestamp and nothing else. Every one of the eleven message stores behind it keeps
 * a `status` column, and one of its values is `failed` — the provider could not
 * deliver it. A failed message therefore rendered byte-for-byte like a delivered one:
 * a coordinator reading the record saw the words "your appointment has moved to
 * 9:40am" and concluded the patient had been told. That is the same class of defect
 * as the empty-vs-failed one the rest of this record was already built to avoid,
 * except one layer further in — not "we could not read the history" but "we read it
 * correctly and displayed an undelivered message as a delivered one".
 *
 * The vocabulary differs per module because the tables were written at different
 * times: some carry `approved`, some carry `sending`, the speed-to-lead attempt log
 * carries only `sent`/`failed`, and a couple of rows in the older tables carry values
 * nobody documented. Normalising here means the tab has ONE set of words for a state
 * rather than eleven, and means a value we have never seen cannot quietly become
 * "Sent".
 *
 * THE UNKNOWN CASE IS THE POINT. An unrecognised status maps to `unknown` and is
 * shown, labelled, never dropped and never upgraded. Dropping it hides a message that
 * really was sent; calling it "Sent" makes a delivery claim nobody checked. Saying
 * "status not recorded" beside the message is the only reading that is true whichever
 * it turns out to be.
 */

/** Raw status → the closed set the record screen understands. */
export function normaliseDeliveryStatus(raw: string | null | undefined): DeliveryStatus {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "sent") return "sent";
  if (v === "failed") return "failed";
  // Approved / queued / sending all mean the same thing to a reader: a human has
  // signed it off and it has not left yet. The distinction between them is the
  // drain's business, not the record's.
  if (v === "approved" || v === "queued" || v === "sending") return "queued";
  if (v === "draft") return "draft";
  if (v === "discarded") return "discarded";
  return "unknown";
}

/**
 * Whether a row belongs on the patient's correspondence timeline at all.
 *
 * A draft is a sentence someone typed and has not sent; a discarded draft is one a
 * human deliberately killed. Neither was ever said to the patient, so putting either
 * on a record of what was said would be a lie in the opposite direction to the one
 * this module fixes. Everything else — including `unknown` — is shown.
 */
export function belongsOnRecord(status: DeliveryStatus): boolean {
  return status !== "draft" && status !== "discarded";
}

/**
 * The words for each state.
 *
 * "Sent" is deliberately not "Delivered". What the platform knows is that the
 * provider accepted the message; whether the handset received it is a separate fact
 * carried by the delivery webhook, and claiming it here would be inventing one.
 * "Not delivered" for `failed` is deliberately blunt for the same reason it matters:
 * the reader's next action should be to contact the patient another way.
 */
export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  sent: "Sent",
  failed: "Not delivered",
  queued: "Waiting to send",
  unknown: "Status not recorded",
  draft: "Draft",
  discarded: "Discarded",
};

/**
 * Every message source that can appear on a patient's correspondence timeline, in
 * the words a receptionist would use rather than the module slug.
 *
 * PINNED BY A TEST against the source registry in ./repository, on the same reasoning
 * as the owner-route coverage test: a new lifecycle module that starts messaging
 * patients and is not added here would render its sends under a raw slug, or (worse,
 * if this map were consulted for inclusion rather than labelling) not render at all.
 */
export const SOURCE_LABEL: Record<string, string> = {
  agent: "Conversation",
  recall: "Recall",
  reactivation: "Reactivation",
  noshow: "Appointment confirmation",
  coordinator: "Treatment follow-up",
  closer: "Treatment plan follow-up",
  postop: "Aftercare check-in",
  previsit: "Pre-visit questions",
  reviews: "Review request",
  collection: "Balance reminder",
  outreach: "Campaign",
  diary: "Appointment change",
  "speed-to-lead": "New enquiry reply",
  dentally: "Dentally",
};

/** The human label for a source, falling back to the slug rather than to nothing. */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}
