/**
 * The patient record's eleven tabs: slugs, order, labels, and the exact words each
 * unfillable tab says about itself.
 *
 * PURE. No I/O. Tested.
 *
 * WHY THE COPY LIVES HERE rather than in the JSX that renders it. These are
 * clinical-safety sentences. On a patient record, "this patient has none" and "we
 * cannot read this" are DIFFERENT CLINICAL FACTS, and conflating them is a
 * patient-safety event, not a copy nit. Kept in a tested module they can be reviewed
 * in one place and a test can hold the line; buried in a component they drift.
 *
 * THE FOUR SENTENCES, and they are never interchangeable:
 *   A. "This patient has none."  A real read returned nothing.
 *   B. "We cannot read this."    Dentally exposes no endpoint we call.
 *   C. "We do not hold this yet." Our own side, not built or not wired.
 *   D. "The read failed."        A read we DO have threw just now.
 *
 * ORDER AND COMPLETENESS. All eleven are always rendered, in Dentally's own order,
 * with NO marker on the tab itself. Hiding a tab reads as a lost capability to a
 * Dentally user who goes looking for it; marking four of eleven is the row-of-amber-
 * chips failure PRODUCT.md names, where the caveats shout louder than the facts. The
 * honesty belongs inside the panel, attached to the thing it concerns, quietly.
 */

export const PATIENT_TAB_SLUGS = [
  "details",
  "medical",
  "chart",
  "appointments",
  "recalls",
  "notes",
  "account",
  "perio",
  "correspondence",
  "tasks",
  "audit",
] as const;

export type PatientTabSlug = (typeof PATIENT_TAB_SLUGS)[number];

/**
 * How much of this tab we can actually fill.
 *   live         - a real read backs it end to end.
 *   partial      - a real read backs it, but Dentally's own screen holds more.
 *   unreadable   - Dentally exposes nothing we can call. Category B.
 *   not-held-yet - our own side, not built. Category C.
 */
export type TabAvailability = "live" | "partial" | "unreadable" | "not-held-yet";

export interface PatientTab {
  slug: PatientTabSlug;
  label: string;
  availability: TabAvailability;
  /**
   * For an `unreadable` tab, the sentence that must be read before this patient is
   * treated. Empty for tabs that render real content and carry their caveats inline.
   */
  cannotRead: string;
  /** What the tab WILL hold, so an empty screen still says what it is for. */
  willHold: string;
}

export const PATIENT_TABS: readonly PatientTab[] = [
  {
    slug: "details",
    label: "Details",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "medical",
    // PARTIAL from the day medical-history capture landed, and it left the
    // "unreadable" set for the SAME reason perio did — not the chart's. The chart
    // became fillable because a Dentally read was found. Medical's Dentally endpoint
    // (/v1/medical_histories) EXISTS but is permanently empty for this practice
    // (0 rows across 51k patients, verified GET-only), so nothing is mirrored from
    // it — but the patient's own `medical_alert` flag IS a real read now
    // (PatientRecord.medicalAlert), and this platform AUTHORS a medical-history
    // questionnaire + review log of its own (gated off by default). So the tab
    // renders its own screen — the alert mirror, the questionnaire, the review
    // status — with every caveat stated inline, exactly as the chart tab was
    // migrated above.
    //
    // The old cannotRead asserted "no client method, no endpoint, no table, no
    // column." Every clause of that is now false, so it must not survive this
    // commit — a blanked sentence, and the tab routes to its own component
    // (record-tab-content.tsx) rather than the shared "we cannot read this" panel.
    label: "Medical",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "chart",
    // PARTIAL from the day the FDI chart landed. /v1/treatment_plan_items is a
    // real read, so the chart is no longer category B. What it CANNOT reach
    // (BPE, perio, tooth status, images) is stated on the chart itself, beside
    // the affordance it concerns, which is where a caveat belongs.
    //
    // The old willHold promised "and it will write back to Dentally". That is
    // now known to be false: Dentally publishes no create route on any charting
    // resource. It must not survive this commit.
    label: "Chart",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "appointments",
    label: "Appointments",
    availability: "live",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "recalls",
    label: "Recalls",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "notes",
    label: "Notes",
    availability: "live",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "account",
    label: "Account",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "perio",
    label: "Perio",
    availability: "unreadable",
    cannotRead:
      "We cannot read periodontal charting. Dentally does not expose it through the connection we have.",
    willHold:
      "When it is built, this tab will hold BPE scores and the pocket chart, with the date of each assessment.",
  },
  {
    slug: "correspondence",
    label: "Correspondence",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "tasks",
    label: "Tasks",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "audit",
    label: "Audit",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
] as const;

/** True when `raw` is one of the eleven. Anything else must 404, never fall back to
 *  Details: a mistyped tab that silently shows a different one is how a reader ends
 *  up believing they checked something they did not. */
export function isPatientTab(raw: string): raw is PatientTabSlug {
  return (PATIENT_TAB_SLUGS as readonly string[]).includes(raw);
}

export function patientTab(slug: PatientTabSlug): PatientTab {
  // Non-null by construction: PATIENT_TABS covers every slug, and a test holds it.
  return PATIENT_TABS.find((t) => t.slug === slug) as PatientTab;
}

/** The tab's own URL under a record base path (which already ends in the patient id).
 *  Details is the record root rather than /details, so the default tab has one URL. */
export function patientTabHref(basePath: string, slug: PatientTabSlug): string {
  return slug === "details" ? basePath : `${basePath}/${slug}`;
}

// ---------------------------------------------------------------------------
// The reusable empty and failed sentences, so no panel invents its own wording.
// ---------------------------------------------------------------------------

/**
 * THE SENTENCE BOTH CORRESPONDENCE EMPTIES CARRY, so the two cannot drift apart.
 *
 * It is the same instruction FAILED_COPY.correspondence gives a reader when the
 * read threw, and it is needed here for a different reason: not that the list could
 * not be built, but that the list is built from the wrong side of an identification
 * that can fail. "Nothing here" and "nothing was sent" are not the same statement,
 * and only one of them is safe to print on a patient's record.
 */
const UNMATCHED_NUMBER_POINTER =
  "A message we sent to a number that could not be matched to this record is held in the Conversations inbox " +
  "under that number instead, so check there before assuming this patient has not been contacted.";

/** Category A: a real read returned nothing. */
export const EMPTY_COPY = {
  appointments: "No appointments on record.",
  recalls: "No recall dates on this patient's record.",
  practiceNotes: "No practice notes yet. Add the first one above.",
  // Worded so it cannot be read as "this patient has no clinical notes". It is a
  // statement about THIS CONNECTION, which reads the /v1/notes endpoint and
  // nothing else: a note recorded somewhere in Dentally that this read does not
  // cover would otherwise be denied, in writing, on a clinical record.
  dentallyNotes: "No clinical notes have come through from Dentally for this patient.",
  plans: "No treatment plans on record.",
  invoices: "No invoices on record.",
  // Worded so it cannot be read as "this patient has never been contacted", and
  // POINTED, because on this screen it can be wrong about a patient who was texted
  // minutes ago. The record read finds a conversation only under the patient's
  // Dentally id (loadAgentMessagesForPatient in src/lib/inbox/repository.ts); a
  // message we sent to a number identifyByPhone could not match is filed under
  // `lead:<number>` and never moves. That is not exotic: identification matches on
  // mobile_phone ONLY, so a landline, a work number or a shared family number
  // misses, and the lookup is capped at 3 seconds, so a slow Dentally demotes a
  // patient we could have named. An empty panel with no pointer tells the reader
  // the opposite of the truth, which is the one thing this tab exists to prevent.
  correspondence:
    "No messages to this patient have been recorded from this platform. " +
    UNMATCHED_NUMBER_POINTER,
  // The same claim when Dentally's own SMS log HAS been read and is also empty. It
  // is a wider claim than the one above, so it may only be shown when the Dentally
  // read actually succeeded — never when it is switched off or failed.
  correspondenceWithDentally:
    "No messages to this patient have been recorded from this platform, and Dentally holds no SMS for them " +
    "either. " +
    UNMATCHED_NUMBER_POINTER,
  tasks: "No open tasks for this patient.",
  // Worded so it cannot be read as "every tooth is present and sound". The
  // chart draws treatment ITEMS; it does not draw the dentition.
  chartItems:
    "No treatment items on this patient's chart in Dentally. This chart shows treatment items and not tooth " +
    "status, so this does not tell you whether every tooth is present or sound.",
  chartDraft: "Nothing has been planned on this screen for this patient.",
  // Worded so it cannot be read as "nothing has ever happened to this record",
  // which is the failure mode the Audit tab is most prone to.
  audit: "No changes have been made to this patient through this platform.",
} as const;

/**
 * Category D: a read we DO have threw. Never the same sentence as category A.
 *
 * THE FOUR AT THE BOTTOM WERE MISSING, and their absence was the defect: the
 * correspondence, tasks, audit, recall and status reads each caught to an empty array
 * or a null, and the panel then printed the category A sentence. A Supabase blip or an
 * RLS regression during a complaint investigation put "No messages have been sent to
 * this patient from this platform" on the screen, in writing, as a fact about the
 * patient. An outage must never be able to make a positive claim about a record.
 */
export const FAILED_COPY = {
  appointments: "We could not read this patient's appointments just now.",
  plans: "We could not read this patient's treatment plans just now.",
  dentallyNotes: "We could not read Dentally's clinical notes just now.",
  invoices: "We could not read this patient's invoices just now.",
  correspondence:
    "We could not read this patient's message history just now, so this is NOT a record of what was sent. " +
    "Check the Conversations inbox before assuming this patient has not been contacted.",
  partialCorrespondence:
    "Part of this patient's message history could not be read just now, so messages may be missing from this list.",
  // A count told the reader something was missing but not WHAT, which on a record
  // leaves them nowhere to go and look. partialCorrespondenceCopy() below names the
  // sources instead; this constant remains the wording when there are none to name.
  tasks: "We could not read this patient's tasks just now, so this is not a complete list of open work.",
  audit: "We could not read this patient's change history just now.",
  recalls: "We could not read the recall worklist just now, so we cannot say whether this patient is on it.",
  status:
    "We could not read this patient's status just now, so we cannot show whether the practice has marked them " +
    "inactive or do-not-contact. Check before contacting this patient.",
  statusChip: "Status not read",
  // THE LOUDEST FALSE CLAIM AVAILABLE ON THE RECORD, if it were missing. A
  // failed chart read renders 32 unmarked teeth, which a clinician reads as a
  // fact about the patient. The chart's status bar is always rendered so this
  // sentence always has somewhere to go.
  chartItems:
    "We could not read this patient's chart from Dentally just now, so nothing on this chart can be relied on. " +
    "An unmarked tooth here does not mean an unmarked tooth in Dentally.",
  treatments:
    "We could not read the treatment list from Dentally just now, so treatments cannot be selected or named.",
  chartDraft: "We could not read what has been planned on this screen for this patient just now.",
} as const;

/** Category C: on our own side, and stated as one quiet line, never a row of chips. */
export const NOT_HELD_COPY = {
  detailsFields:
    "Dentally's own record also holds a middle name, preferred name, NI and NHS numbers, town, county, " +
    "home and work phone, the assigned dentist and hygienist, recall intervals, recall method and " +
    "acquisition source. We do not read those fields yet, so they are not shown.",
  recallIntervals:
    "Dentally also records a recall interval and a recall method. We do not read those yet, so they are not shown.",
  badDebtor: "Dentally's 'Set bad debtor' marker has no equivalent here yet.",
} as const;

/**
 * The Account tab's own sentences, kept here so the record's money copy is reviewed and
 * swept in one place rather than living inside the component.
 *
 * WHY reconciliation needs saying. Total invoiced sums the gross of EVERY invoice,
 * including ones written off, cancelled or credited. Total paid and Balance count only
 * live debt, so a written-off course is in Total invoiced but in neither of the other
 * two, and the three figures no longer subtract (Balance = Invoiced - Paid stops
 * holding). Each figure is individually correct and Dentally-sourced; the gap is real
 * and must be explained, not hidden. The sentence is shown ONLY when the figures
 * actually fail to reconcile (see accountFiguresReconcile), never as always-on
 * furniture on a clean patient, which is the caveat-nobody-reads failure mode.
 */
export const ACCOUNT_COPY = {
  reconciliation:
    "Total invoiced counts every invoice raised, including any written off, cancelled or credited. Total paid " +
    "and Balance count only live debt, so for this patient these three figures do not subtract cleanly. Each " +
    "figure is correct on its own and is read from Dentally.",
} as const;

/** Category B, inline: things a panel that DOES render must still say it cannot reach. */
export const CANNOT_READ_COPY = {
  invoiceColumns:
    "Summary, practitioners and location are not returned by the invoice read we have, so those columns are blank.",
  payments:
    "Payment and allocation history is not shown here yet. Dentally does return this patient's payments, and each " +
    "payment carries the invoices it was allocated against, so this is work still to do on this record rather than " +
    "a limit of the connection.",
  dentallyTasks: "Dentally's own task list is not readable.",
  dentallyAudit:
    "This is a record of changes made through this platform. Anything done inside Dentally itself, including " +
    "logins, record views, appointment edits and note edits, is not shown: Dentally does not expose its audit " +
    "trail through the connection we have.",
  taskScope:
    "Shows recall, no-show and reactivation tasks, plus after-hours callbacks where the caller's number was " +
    "recognised. Coordinator, speed-to-lead and smile assessment tasks are not keyed to a patient, so they " +
    "cannot be listed here.",
  /**
   * The record header's neutral medical wording.
   *
   * SEMANTICS UPDATED. This used to be the header's PERMANENT pill, correct back
   * when there was no medical read of any kind. Now medical_alert is readable and a
   * review can be stored, so the header renders a computed THREE-STATE pill instead
   * (medicalHeaderPill in src/lib/patient-medical/review-status.ts): red when
   * Dentally flags an alert, amber when a review is due, and this exact neutral
   * wording ONLY when the review status could not be READ — a failed read, never a
   * permanent state. It is kept here as the canonical neutral wording, and it is the
   * SHAPE bpeFlag below copies (words, not a dot); the pill's failed-read label uses
   * this same string, and this test-pinned constant is what stops the two drifting.
   */
  medicalHistoryFlag: "Medical history not read",
  /** The chart's BPE marker. Deliberately the same SHAPE as the medical flag
   *  above and kept beside it: Dentally puts a RED dot on BPE when one is due,
   *  we cannot know, and a bare grey dot in that trained position reads as
   *  "checked, nothing due", which is a claim. Words, not a dot. */
  bpeFlag: "BPE not read",

  // -------------------------------------------------------------------------
  // THE CHART'S SEVEN. Each one is rendered somewhere on the chart, beside the
  // affordance it concerns, and each names DENTALLY as the place to look.
  //
  // Dentally's API exposes NO periodontal data and NO BPE scores at all
  // (verified: "perio" appears in their documentation only inside the word
  // "period"), while Dentally's OWN charting screen has both. So a BPE or perio
  // region rendering as empty, blank or greyed-out would tell a dentist "no
  // findings" when the truth is "not available here", and that is a plausible
  // contributor to a missed diagnosis. None of these may be omitted, and none
  // of them may be a disabled control with no explanation.
  // -------------------------------------------------------------------------
  bpe:
    "We cannot read BPE scores. Dentally does not expose them through the connection we have, so this chart " +
    "cannot tell you what the last basic periodontal examination found or whether one is due. Open this " +
    "patient in Dentally to see their BPE history.",
  perioOnChart:
    "We cannot read periodontal charting. Dentally holds pocket depths, bleeding and recession on its own " +
    "chart and exposes no part of it through the connection we have, so nothing on this screen reflects this " +
    "patient's periodontal condition. Check Dentally before treating this patient.",
  toothStatus:
    "We cannot read tooth status. This chart draws the treatment items Dentally returns, not the dentition " +
    "itself, so a tooth drawn here may be missing, extracted, crowned or unerupted in Dentally, which is the " +
    "record.",
  chartImages:
    "We cannot read chart images. Dentally holds radiographs and clinical photographs against the chart and " +
    "does not expose them through the connection we have, so open this patient in Dentally to view them.",
  cloudGallery:
    "We cannot read the Cloud Gallery. Dentally's imaging gallery sits outside the connection we have, so " +
    "whatever it holds for this patient can only be seen in Dentally.",
  baseChartStatus:
    "Base chart treatment items are shown here, but we cannot read Dentally's socket level tooth status. That " +
    "is where Dentally holds whether a tooth is present, missing, retained or implanted, and it is not exposed " +
    "through the connection we have.",
  chartHistoryScope:
    "This is the history held in Dentally's treatment plan items. We cannot read Dentally's full clinical " +
    "history, which also holds base chart changes, clinical notes and periodontal assessments, so this list is " +
    "narrower than the one on Dentally's own chart.",
} as const;

/**
 * What the Correspondence tab says it covers, in the states it can actually be in.
 *
 * A SENTENCE HERE WAS FALSE, and that is why this block exists. The tab used to say
 * "Dentally does not expose its correspondence through the connection we have."
 * Dentally does. Its SMS feed is readable on a route the practice's key already holds
 * scope for, and it was never being read. The old sentence was written as an honest
 * answer to a real question from the practice manager, and it quietly became untrue —
 * the same failure as the invented /v1/patient_notes path: a permanent claim about
 * the connection, made once, never re-checked.
 *
 * The replacement never states what Dentally can or cannot do. It states what is on
 * THIS SCREEN, which is a fact this code actually knows in every state.
 *
 * THE SECOND SENTENCE IS THE ONE THAT MATTERS OPERATIONALLY. Nothing this platform
 * sends is written back into Dentally, so a member of staff working in Dentally sees
 * none of it. Saying so on the tab is the difference between a colleague knowing to
 * look here and a colleague concluding the patient was never contacted. The same
 * statement, at length, is in docs/runbooks/correspondence-visibility.md.
 *
 * AND THE FIRST SENTENCE WAS FALSE TOO, IN THE OTHER DIRECTION. "Every message this
 * platform has sent to this patient or received from them" was written when the
 * record read eleven module tables, and four live send paths went through none of
 * them: the missed-call callback, the no-show confirmation reply, the aftercare
 * acknowledgement, and a message a colleague sent by hand from the co-pilot. All
 * four now record into the agent conversation store (src/lib/inbox/record-outbound.ts),
 * and a structural test (src/lib/inbox/send-sites.test.ts) enumerates every
 * sendMessage call site in the tree so a new one cannot silently reopen the hole.
 *
 * AND "THE SENT HALF IS NOW COMPLETE" WAS THE NEXT VERSION OF THE SAME MISTAKE.
 * Every send site now records, which is not the same fact as every send reaching the
 * patient it went to. The four out-of-band senders key their record row by whatever
 * `identifyByPhone` returned, and when that returns nothing the row is filed under
 * `lead:<number>` — a conversation this patient's record read never looks at
 * (loadAgentMessagesForPatient filters on the Dentally id alone). Identification
 * matches on `mobile_phone` ONLY, so a landline, a work number or a shared family
 * number misses; and the missed-call lookup is capped at 3 seconds, so a Dentally
 * slowdown demotes a patient we could otherwise have named. Nothing re-keys it
 * afterwards: `adoptConversationPatientId` fires only when the agent REGISTERS a
 * brand-new patient mid-thread, never on identifying an existing one. So the scope
 * sentence names that exception, and the empty state points at the inbox.
 *
 * THE RECEIVED HALF HAS TWO MORE, named on the screen rather than rounded away: a
 * reply to a waitlist offer of a cancelled slot, and an opt-out from a number that
 * was in no campaign. Both genuinely have nothing on this platform to attach them
 * to. Writing "every message" over a screen missing any of these three is the same
 * defect as the sentence above, and the whole reason this block carries its own tests.
 */
export const CORRESPONDENCE_COPY = {
  scopePlatformOnly:
    "Every message this platform has sent to this patient: " +
    "recall, reactivation, appointment confirmations and changes, treatment follow-ups, aftercare " +
    "check-ins, review requests, balance reminders, campaigns, first replies to an enquiry, callbacks " +
    "after a missed call, and anything a colleague sent by hand from the inbox or the co-pilot. " +
    "The one exception is a message sent to a number that could not be matched to this record, which " +
    "stays in the Conversations inbox under that number. Their " +
    "own replies are here too, with the two exceptions noted below this list. " +
    "This history is held HERE, not in Dentally, and none of it is written back, so Dentally's own record " +
    "of this patient does not show it. Messages sent from Dentally itself are not shown on this screen.",
  scopeWithDentally:
    "Every message this platform has sent to this patient: " +
    "recall, reactivation, appointment confirmations and changes, treatment follow-ups, aftercare " +
    "check-ins, review requests, balance reminders, campaigns, first replies to an enquiry, callbacks " +
    "after a missed call, and anything a colleague sent by hand from the inbox or the co-pilot. " +
    "The one exception is a message sent to a number that could not be matched to this record, which " +
    "stays in the Conversations inbox under that number. Their " +
    "own replies are here too, with the two exceptions noted below this list. " +
    "SMS sent or received through Dentally is also included, marked Dentally; its letters, email and " +
    "scanned documents are not, because Dentally does not return them. Nothing on this screen is written " +
    "back into Dentally, so a colleague working in Dentally sees only Dentally's own messages.",
  /**
   * THE ONE MESSAGE WE SENT THAT CAN STILL BE MISSING, named beside the list.
   *
   * Not a rare edge. A record read finds a conversation only under the patient's
   * Dentally id, and the four out-of-band senders key theirs from whatever
   * `identifyByPhone` returned. It matches on `mobile_phone` alone, so a landline,
   * a work number or a shared family number never resolves; and the missed-call
   * lookup is bounded at 3 seconds so the caller hears no application error, which
   * means a slow Dentally silently demotes a patient we could have named.
   *
   * Stated as "does not move onto this record later" because the opposite was
   * written down as fact in the runbook and is not true: nothing re-keys these.
   * `adoptConversationPatientId` only fires when the agent registers a BRAND-NEW
   * patient mid-thread.
   */
  unmatchedNumbers:
    "One kind of message we sent can be missing from this list: one sent to a number this platform could not " +
    "match to this record, which happens with a landline, a work number, a shared family number, or any " +
    "number while the Dentally lookup is slow. It is held in the Conversations inbox under the number itself " +
    "and does not move onto this record later, so check there before concluding what was said to this patient.",
  /**
   * THE TWO REPLIES FROM THE PATIENT THAT ARE NOT HERE, named rather than rounded away.
   *
   * Both are structural, not bugs waiting to be fixed: a waitlist slot offer is not
   * tied to a defended appointment, so a reply to one has no target to hang off; and
   * an opt-out is answered by the suppression list before any conversation exists, so
   * a STOP from a number in no campaign correlates to nothing. Each is held somewhere
   * (the No-show list, the opt-out list) and neither can be tied to this timeline
   * without a schema change. Both are in the runbook's gap table.
   *
   * Shown beside the list rather than buried in the scope paragraph, because the
   * reader who needs it is the one already scanning the messages for a reply.
   */
  inboundGaps:
    "Two kinds of reply from the patient are not on this list: an answer to an offer of a cancelled slot " +
    "from the waitlist, and a STOP from a number that was not in any campaign. Neither can be tied to a " +
    "patient record. Check the No-show list and the opt-out list before concluding a patient never replied.",
  /** The per-source read ceiling, stated on the screen it bounds. */
  boundedRows:
    "Bounded at the 400 most recent messages from each source, so a patient with a very long history may " +
    "not see the oldest of them here.",
  /** Category D for the Dentally half specifically: a read we have, that failed. */
  dentallyFailed:
    "Dentally's own SMS history could not be read just now, so anything sent from Dentally itself is missing " +
    "from this list.",
  /**
   * The mirror image: every PLATFORM source failed but Dentally's read succeeded.
   *
   * FAILED_COPY.correspondence cannot be used here. It says "we could not read this
   * patient's message history", which on a screen that is visibly listing Dentally's
   * messages reads as a contradiction, and a reader resolves a contradiction by
   * believing the list. Found by rendering the tab in this exact state rather than
   * by reasoning about it.
   */
  platformFailedDentallyOk:
    "This platform's own message history could not be read just now, so anything IT sent is missing below. " +
    "Only Dentally's messages are shown. Check the Conversations inbox before assuming this patient has not " +
    "been contacted.",
  /** Why an approved-but-unsent or rejected draft is absent. */
  draftsExcluded:
    "Drafts waiting for approval and drafts that were rejected are not shown here, because neither was said to " +
    "the patient. They sit in the worklist of the module that wrote them.",
  /** What "Sent" does and does not claim. */
  sentMeaning:
    "Sent means the message was accepted by the network, not that the patient read it. Not delivered means it " +
    "did not reach them and they have not been told.",
} as const;

/**
 * The partial-failure sentence, NAMING the sources that could not be read.
 *
 * Pure and exported so the sentence is testable rather than assembled inside JSX,
 * which is the rule the rest of this file exists to enforce. The list is joined with
 * "and" before the last item because a reader scanning a record should not have to
 * parse a comma-separated slug dump to work out what to go and check.
 */
export function partialCorrespondenceCopy(failedSourceLabels: string[]): string {
  if (failedSourceLabels.length === 0) return FAILED_COPY.partialCorrespondence;
  const names =
    failedSourceLabels.length === 1
      ? failedSourceLabels[0]
      : `${failedSourceLabels.slice(0, -1).join(", ")} and ${failedSourceLabels[failedSourceLabels.length - 1]}`;
  return (
    `${names} could not be read just now, so messages from ${failedSourceLabels.length === 1 ? "it" : "them"} ` +
    `are missing from this list. Do not read this as a complete history.`
  );
}

/**
 * Everything else the chart screen says, so no sentence on it lives untested
 * inside JSX.
 *
 * These are not category B "cannot read" sentences, so they are kept apart from
 * CANNOT_READ_COPY rather than diluting it. They ARE swept for British English
 * and for em-dashes alongside it.
 */
export const CHART_COPY = {
  // Lives here, not in write-gate.ts, so the copy sweep covers it.
  writeBlockedTitle:
    "Charting is authored in Dentally. Dentally publishes no way for this platform to create or change " +
    "charting, so this control is shown for reference and cannot act from here.",
  planTemplates:
    "Treatment plan templates are held in Dentally and cannot be applied from here. Open this patient in " +
    "Dentally to use one.",
  historyExport: "Exports the lines shown here, as they were read from Dentally at the time above.",
  truncated:
    "This chart read reached its page limit, so it may not be the whole of this patient's chart. Check " +
    "Dentally before relying on it.",
  // A SEPARATE SENTENCE, because it is a separate fact. The catalogue walk and
  // the patient's own chart shared one flag, so a practice whose stock treatment
  // list runs past five hundred rows printed "this may not be the whole of this
  // patient's chart" on every patient, forever, while the chart itself had been
  // read in full. A caveat that is always on is a caveat nobody reads, and this
  // one is about the LIST, not about the person.
  truncatedCatalogue:
    "The treatment list read reached its page limit, so some treatments may be missing from the list on the " +
    "left. The chart itself is unaffected.",
  // Dentally sends surfaces as numbers, and its own documentation does not say
  // which region each number is. Marking a real surface with a guessed name is a
  // wrong surface on a clinical record, so the number is shown and never
  // converted.
  unreadSurfaces:
    "Some treatment items name surfaces in a form this platform cannot place on a tooth diagram, so those " +
    "surfaces are shown as the value Dentally sent rather than drawn. The tooth is marked and the values are " +
    "listed in History.",
  staleness:
    "Charting done in Dentally after this time is not shown here. Refresh to read the chart again.",
  offArch:
    "Treatment items on the other dentition are not drawn in this view. Turn on the combined chart to see " +
    "both dentitions at once.",
  unplaced:
    "Some treatment items name teeth this platform could not read, so they are not drawn on the arch. They " +
    "are listed in History with the value Dentally sent.",
  draftDisabled:
    "Planning on this screen is switched off, so this chart is a read only mirror. Charting is done in " +
    "Dentally.",
  draftSaveFailed:
    "That change was not saved. Nothing has been sent to Dentally, and what is on this screen may not be what " +
    "is stored.",
  socketStatus:
    "Dentally sets tooth status from the socket menu on its own chart. That menu is not exposed through the " +
    "connection we have.",
} as const;

/**
 * Which tab a record opens on, by role.
 *
 * DENTALLY.md:114 says a practitioner's patient records open on Chart and
 * everyone else opens on Details. roles.ts has no practitioner role today
 * (client_owner, client_coordinator and agency_admin only), so this returns
 * "details" for every role that currently exists and "chart" for a
 * client_practitioner that does not exist yet.
 *
 * It is NOT wired to a route. Naming and testing a behaviour we cannot yet
 * ship is the honest form; omitting it silently was not.
 */
export function defaultPatientTabForRole(role: string | null | undefined): PatientTabSlug {
  return role === "client_practitioner" ? "chart" : "details";
}
