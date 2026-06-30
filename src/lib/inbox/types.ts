// The unified Conversations inbox aggregates messages from several stores into a
// single, channel-agnostic shape. Nothing here is persisted: these are the
// read-side projections the inbox view and reply route share.

export type InboxChannel = "sms" | "whatsapp" | "email" | "after-hours";
export type InboxDirection = "inbound" | "outbound";

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
