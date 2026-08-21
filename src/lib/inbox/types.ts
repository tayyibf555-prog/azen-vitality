// The unified Conversations inbox aggregates messages from several stores into a
// single, channel-agnostic shape. Nothing here is persisted: these are the
// read-side projections the inbox view and reply route share.

export type InboxChannel = "sms" | "whatsapp" | "email" | "after-hours";
export type InboxDirection = "inbound" | "outbound";

/**
 * What the platform knows about whether a message actually left.
 *
 * `sent` means the provider accepted it, not that the handset displayed it.
 * `unknown` means the store held a status this code has never seen, and is shown
 * as such rather than being rounded up to `sent` or dropped. See ./delivery for
 * the mapping and the reasoning.
 */
export type DeliveryStatus = "sent" | "failed" | "queued" | "draft" | "discarded" | "unknown";

/** One normalised message from any source store. */
export interface InboxMessage {
  /** Stable id, prefixed by source to stay unique across stores. */
  id: string;
  /**
   * The contact this message belongs to. Canonical forms:
   *   - `patient:<dentallyPatientId>` for a known patient
   *   - `lead:<phone>` for an unidentified enquiry
   *   - `address:<phone|email>` when only a raw destination is known
   * The reply route resolves this back to a real recipient + consent ref.
   */
  contactRef: string;
  /** Display name for the contact (may be a masked label for unknown numbers). */
  contactName: string;
  channel: InboxChannel;
  direction: InboxDirection;
  body: string;
  /** ISO timestamp the message happened at. */
  at: string;
  /** Which store this came from, e.g. "agent", "reactivation", "after-hours". */
  source: string;
  /**
   * Whether it left. Optional so the site-wide inbox list, which does not render a
   * status, is unaffected; the patient record always populates it. Absent is NOT
   * the same as `unknown`: absent means the caller did not ask, `unknown` means the
   * store answered with something we do not recognise.
   */
  status?: DeliveryStatus;
  /**
   * The human who approved or actioned this send, as the store recorded them.
   *
   * On this platform an outbound lifecycle message is drafted by an agent and
   * released by a person, and "who released it" is the question a complaint
   * investigation actually asks. Null where the row carries no approver — an
   * inbound message, a live conversation turn, or an automatic transactional send.
   */
  actionedBy?: string | null;
  /**
   * Set when this platform message was ALSO found in Dentally's own SMS log.
   *
   * Both systems hold the same text because Dentally's Twilio number sent it; the
   * platform row is kept because it is the richer record (it knows which module
   * wrote it and who released it), and this flag is how the screen says so instead
   * of dropping Dentally's copy without a word. See ./dentally-merge.
   */
  alsoInDentally?: boolean;
}

/** A per-contact thread: every message we hold for one contact, newest activity first. */
export interface Thread {
  contactRef: string;
  contactName: string;
  /** The channel of the most recent message (the thread's primary channel). */
  channel: InboxChannel;
  /** ISO timestamp of the most recent message. */
  lastAt: string;
  /** A short preview of the most recent message body. */
  lastSnippet: string;
  /** True when the latest message is inbound (i.e. awaiting a human reply). */
  unread?: boolean;
  /** All messages for this contact, oldest first (chat order). */
  messages: InboxMessage[];
}
