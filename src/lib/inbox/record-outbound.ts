import { findOrCreateConversation, appendMessage } from "@/lib/agent/repository";
import type { MessageChannel } from "@/lib/messaging/types";

/**
 * PUT AN OUTBOUND MESSAGE ON THE PATIENT'S OWN RECORD, AFTER IT HAS GONE OUT.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS.
 * ===========================================================================
 *
 * The Correspondence tab, `repository.ts` and the runbook all made the same
 * load-bearing claim: every message this platform sends to a patient appears on
 * their record. It was false in four places. The drain-backed modules each write a
 * `*_touch` row and the agent spine appends to `agent_conversation`, but four live
 * patient-facing send paths wrote NOTHING the tab reads:
 *
 *   1. the missed-call callback text (voice webhook),
 *   2. the no-show YES/CANCEL confirmation reply (inbound webhook),
 *   3. the post-op acknowledgement (inbound webhook),
 *   4. the co-pilot's `send_message` tool.
 *
 * The fourth is the one that should have been caught by reading the screen: a
 * practice manager deliberately texts a patient, is told "Sent", and the message
 * appears nowhere on that patient's record. The next person to open the record — to
 * answer "what have we already said to her?" — sees a history with a hole in it and
 * no indication that anything is missing.
 *
 * The fix is the one the human-takeover reply already used
 * (`src/app/api/inbox/reply/route.ts`): append the outbound turn to the agent
 * conversation store, which is the spine the record read (`loadAgentMessagesForPatient`)
 * already reads. No new table, no new source to register, no new failure mode.
 *
 * ===========================================================================
 * IT FAILS SOFT, AND THAT IS THE WHOLE CONTRACT.
 * ===========================================================================
 *
 * Every caller invokes this AFTER the provider has accepted the message. The patient
 * already has the text. So this function:
 *
 *   - never throws (every error is caught and logged),
 *   - never retries (a retry loop here would delay a webhook, not fix a row),
 *   - never sends anything (it has no access to a provider, by construction),
 *
 * which makes it impossible for a logging failure to unsend, resend or double-send a
 * message. A caller must never make its own send conditional on the result: the
 * boolean is for a response payload and for tests, not for control flow around a send.
 *
 * The direction is implicit in the role. `agent` maps to `outbound` in
 * `directionFromAgentRole`, and the tab renders it as a message FROM the practice.
 * Only pass messages that actually left.
 */

export interface OutboundRecord {
  /** The site the message was sent from. Scopes the record read. */
  siteId: string;
  /**
   * The agent store's patient key, in the store's OWN convention:
   *   - a known patient: the raw Dentally id (`loadAgentMessagesForPatient` accepts
   *     both that and the `patient:<id>` form, and `contactRefFromConv` normalises it);
   *   - an unidentified number: `lead:<phone>`, exactly as the inbound webhook keys it,
   *     so a later reply from that number threads onto the same conversation.
   *
   * Use `outboundPatientKey` below rather than building this by hand.
   */
  dentallyPatientId: string;
  /** Display name for a NEW conversation. Ignored when one already exists. */
  patientName: string;
  /** The channel it was sent on, so the record shows SMS/WhatsApp/email correctly. */
  channel: MessageChannel;
  /** The exact words that went to the patient. */
  body: string;
  /** Who/what sent it, for the log line only. Never shown to a patient. */
  source: string;
}

/**
 * The agent store's key for a recipient: their Dentally id when we know it, the
 * `lead:<address>` form the inbound webhook uses when we do not.
 *
 * Centralised because getting it wrong FORKS the thread rather than failing: a
 * message keyed `lead:07…` for a patient we could have identified lands on a
 * conversation the patient record never reads, and looks exactly like this bug.
 *
 * AND THE LEAD BRANCH IS NOT ONLY FOR STRANGERS. Callers pass whatever their identity
 * lookup returned, and `identifyByPhone` matches on `mobile_phone` ALONE, so a patient
 * fully on file who rings from a landline, a work number or a shared family number
 * resolves to null; so does anybody whose Dentally lookup outran the voice route's
 * 3-second cap. Those messages are correctly keyed by this function and still never
 * appear on the patient's record, because `loadAgentMessagesForPatient` filters to
 * `[<id>, "patient:<id>"]`. Nothing re-keys them afterwards: `adoptConversationPatientId`
 * fires only when the agent REGISTERS a brand-new patient mid-thread. This is a real
 * residual gap, not a bug to fix here — it is named on the Correspondence tab
 * (CORRESPONDENCE_COPY.unmatchedNumbers), pointed at from its empty state, recorded in
 * section 6 of docs/runbooks/correspondence-visibility.md, and pinned in
 * ./record-outbound.test.ts. Widening the record read to accept a lead key would file
 * every unidentified caller onto whichever patient happens to share the number.
 */
export function outboundPatientKey(patientId: string | null | undefined, address: string): string {
  const id = (patientId ?? "").trim();
  return id ? id : `lead:${address}`;
}

/**
 * Record one already-sent outbound message where the patient record reads it.
 *
 * Returns true when the row landed, false when it did not. NEVER throws.
 */
export async function recordOutbound(input: OutboundRecord): Promise<boolean> {
  // A message with no site or no patient key has nowhere to land. Say so in the log
  // rather than writing a row keyed on an empty string, which would collect every
  // unattributable message onto one shared phantom conversation.
  if (!input.siteId || !input.dentallyPatientId) {
    console.warn(
      `[correspondence] ${input.source}: outbound not recorded, no site or patient key ` +
        `(site=${JSON.stringify(input.siteId)} key=${JSON.stringify(input.dentallyPatientId)})`,
    );
    return false;
  }
  try {
    const conversation = await findOrCreateConversation({
      siteId: input.siteId,
      dentallyPatientId: input.dentallyPatientId,
      patientName: input.patientName,
      channel: input.channel,
      treatment: null,
      fundingType: null,
    });
    await appendMessage({ conversationId: conversation.id, role: "agent", body: input.body });
    return true;
  } catch (err) {
    // LOUD, because the message DID go out. The patient has been texted and their
    // record does not show it, which is precisely the state the Correspondence tab
    // exists to prevent; a person needs to be able to find this in the logs.
    console.error(
      `[correspondence] ${input.source}: a message was SENT to ${input.dentallyPatientId} but could not be ` +
        `recorded on their record. The patient has it; the record does not.`,
      err,
    );
    return false;
  }
}
