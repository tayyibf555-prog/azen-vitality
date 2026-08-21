import { DRAIN_SOURCE_TO_SLUG } from "@/lib/systems/catalog";

/**
 * EVERY PLACE IN THIS CODEBASE THAT CAN PUT A MESSAGE ON THE WIRE, AND WHERE EACH
 * ONE LANDS ON A PATIENT'S RECORD.
 *
 * ===========================================================================
 * WHY A REGISTRY AND NOT A COMMENT.
 * ===========================================================================
 *
 * The Correspondence tab, `repository.ts` and the runbook all say the record holds
 * every message this platform has sent to a patient. That claim was made once and
 * then quietly stopped being true four times over: the missed-call callback, the
 * no-show confirmation reply, the post-op acknowledgement and the co-pilot's
 * `send_message` tool each texted real patients and wrote nothing the tab reads.
 *
 * The reason it went unnoticed is structural. `TOUCH_SOURCES` in ./repository is a
 * registry of what the record READS, and `delivery.test.ts` pins it against the
 * drain's source list — so a new *drain* module cannot go missing. But four of the
 * platform's ten send sites do not go through the drain at all, and nothing in the
 * codebase enumerated them. A new agent that sends outside the drain could ship
 * tomorrow and re-open exactly the same hole with every test green.
 *
 * So this file is the other half: a registry of what the platform WRITES. Its
 * companion test (`send-sites.test.ts`) reads the source tree, finds every
 * `sendMessage(` call site for itself, and fails if the tree and this list disagree
 * — in either direction, and on the COUNT per file as well as the file list. A new
 * send cannot be added, anywhere, without someone stating in this file who it goes
 * to and where it will show up.
 *
 * ===========================================================================
 * THE ONE DOOR.
 * ===========================================================================
 *
 * `sendMessage` in src/lib/messaging/send.ts is the only caller of the Twilio and
 * Resend providers (also pinned by the companion test), so enumerating its call
 * sites really does enumerate the platform's outbound. That is what makes the
 * crawl a proof rather than a spot check.
 */

/** Who a send site's messages go to. Only "patient" needs a record. */
export type SendAudience = "patient" | "staff";

export interface SendSite {
  /** Path from the repository root, exactly as it appears in the tree. */
  file: string;
  /**
   * How many `sendMessage(` call sites this file holds.
   *
   * Pinned so that adding a SECOND send to a file already on this list — a staff
   * ping inside a patient-facing route, say — fails the test too. Without the count
   * the registry would only catch whole new files.
   */
  calls: number;
  audience: SendAudience;
  /**
   * For a patient-facing site: the correspondence sources (see
   * CORRESPONDENCE_SOURCE_NAMES in ./repository) where the record read finds these
   * messages. Never empty for a patient site.
   *
   * Null for a staff site, which has no patient record to appear on.
   *
   * IT NAMES THE SOURCE, NOT THE PATIENT, and the difference is load-bearing. A site
   * that resolves its recipient from a phone number writes its row under whatever
   * `outboundPatientKey` produced: the Dentally id when identifyByPhone matched, and
   * `lead:<number>` when it did not. The second lands in `agent` all the same, and
   * the patient's own record read never opens it. So this field means "the row is
   * written where the read looks", not "the patient will see it" — the residual gap
   * is stated on the screen (CORRESPONDENCE_COPY.unmatchedNumbers) and in section 6
   * of docs/runbooks/correspondence-visibility.md.
   */
  recordedIn: readonly string[] | null;
  /** What this site sends, and — for a patient site — what writes the record row. */
  note: string;
}

/** The drain's own module list, so this registry cannot drift from the drain's. */
const DRAIN_SOURCES: readonly string[] = Object.keys(DRAIN_SOURCE_TO_SLUG);

export const SEND_SITES: readonly SendSite[] = [
  // -------------------------------------------------------------------------
  // Patient-facing.
  // -------------------------------------------------------------------------
  {
    file: "src/app/api/messaging/drain/route.ts",
    calls: 2,
    audience: "patient",
    recordedIn: DRAIN_SOURCES,
    note:
      "The shared outbox drain: ten lifecycle modules plus the one-shot WhatsApp-to-SMS " +
      "fallback (the second call site, same row, same body). Each source's own recordSent " +
      "stamps its *_touch row, which is what the record reads.",
  },
  {
    file: "src/app/api/inbox/reply/route.ts",
    calls: 1,
    audience: "patient",
    recordedIn: ["agent"],
    note: "Human takeover from the Conversations inbox. Appends the outbound to agent_conversation.",
  },
  {
    file: "src/app/api/webhooks/twilio/inbound/route.ts",
    calls: 4,
    audience: "patient",
    recordedIn: ["agent"],
    note:
      "Four replies to an inbound text: the no-show YES/CANCEL answer, the post-op " +
      "acknowledgement, the per-sender throttle line and the booking agent's own reply. " +
      "All four append to agent_conversation; the first two do it through recordOutbound " +
      "because their branches return before the conversation store is otherwise touched.",
  },
  {
    file: "src/app/api/webhooks/twilio/voice/route.ts",
    calls: 1,
    audience: "patient",
    recordedIn: ["agent"],
    note:
      "The missed-call callback text, on the single sendCallbackSms path shared by the " +
      "after-hours fallback and the in-hours overflow. recordOutbound threads it under the " +
      "caller's Dentally id, or lead:<number> when we could not identify them.",
  },
  {
    file: "src/lib/copilot/tools.ts",
    calls: 1,
    audience: "patient",
    recordedIn: ["agent"],
    note:
      "The co-pilot's send_message tool: a person deliberately texting a patient. Dispatched " +
      "directly rather than through the drain, so recordOutbound is the only thing putting it " +
      "on the record.",
  },
  {
    file: "src/lib/speed-to-lead/contact.ts",
    calls: 1,
    audience: "patient",
    recordedIn: ["agent", "speed-to-lead"],
    note:
      "First contact with a new enquiry. Appends to agent_conversation before the send and " +
      "logs a speed_to_lead_attempt row after it; the record reads both.",
  },
  {
    file: "src/lib/speed-to-lead/nurture.ts",
    calls: 1,
    audience: "patient",
    recordedIn: ["agent", "speed-to-lead"],
    note: "Nurture follow-ups to a lead who did not reply. Appends to the lead's threaded conversation.",
  },

  // -------------------------------------------------------------------------
  // Staff-facing. Nothing here goes to a patient, so nothing here belongs on a
  // patient record — and putting it there would be its own defect: a rota text to a
  // nurse filed under a patient of the same name.
  // -------------------------------------------------------------------------
  {
    file: "src/app/api/rota/publish/route.ts",
    calls: 2,
    audience: "staff",
    recordedIn: null,
    note: "Publishing a rota texts and emails each member of staff their own shifts.",
  },
  {
    file: "src/app/api/rota/sweep/route.ts",
    calls: 1,
    audience: "staff",
    recordedIn: null,
    note: "The rota sweep texts a member of staff their upcoming shift list.",
  },
  {
    file: "src/lib/agent/alerts.ts",
    calls: 1,
    audience: "staff",
    recordedIn: null,
    note: "The handover ping to STAFF_ALERT_PHONE when a conversation needs a person.",
  },
];

/** The patient-facing sites, which are the ones the record must account for. */
export const PATIENT_SEND_SITES: readonly SendSite[] = SEND_SITES.filter(
  (s) => s.audience === "patient",
);
