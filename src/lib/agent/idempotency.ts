import { consumeBudget } from "@/lib/rate-budget";

// Twilio retries an inbound webhook if our handler is slow or times out. Without
// a dedup that retry re-runs the WHOLE agent turn, which can double-book or send
// the patient two replies. The status and voice webhooks lean on natural dedup
// (outbox message-id uniqueness, capture dedup); the inbound agent turn has no
// such natural key, so we gate on the Twilio MessageSid.
//
// We reuse the shared consume_rate_budget RPC (migration 0023) as an atomic
// "claim once" primitive: a MessageSid keyed budget with a limit of 1 returns
// true exactly once, then false for every retry of the same SID inside the
// window. This bounds spend across serverless instances and needs no new table.
//
// Fails OPEN (treats as first-seen) on a DB error, matching consumeBudget, so a
// transient outage degrades dedup rather than dropping a genuine new message.

const MSGSID_WINDOW_SECONDS = 24 * 60 * 60; // a retry storm is over well within a day

/**
 * Claim an inbound Twilio MessageSid for processing. Returns true the first time
 * a SID is seen (process the message) and false on any subsequent retry of the
 * same SID (no-op). A blank SID is always treated as first-seen (nothing to
 * dedup on) so a provider that omits it never silently drops messages.
 */
export async function claimInboundMessage(messageSid: string): Promise<boolean> {
  if (!messageSid) return true;
  return consumeBudget(`twilio-inbound-msgsid:${messageSid}`, 1, MSGSID_WINDOW_SECONDS);
}
