import { PanelEmpty, PanelFailed, PanelNote, PanelScope, PanelSection } from "./panel";
import {
  CORRESPONDENCE_COPY,
  EMPTY_COPY,
  FAILED_COPY,
  partialCorrespondenceCopy,
} from "@/lib/patient/tabs";
import { CorrespondenceTimelineView } from "./correspondence-timeline-view";
import type { CorrespondenceView } from "@/lib/patient/correspondence-view";
import type { CorrespondenceTimeline } from "@/lib/inbox/correspondence-timeline";
import type { DentallySmsHealth } from "@/lib/dentally/sms";
import type { DentallyDocumentsHealth } from "@/lib/dentally/documents";
import type { DentallyEmailsHealth } from "@/lib/dentally/emails";

/**
 * Correspondence: what this platform has said to this patient, what came back, and
 * what Dentally holds against the record.
 *
 * NOT "everything", and the copy no longer says so in either direction. The exceptions
 * are real and named ON THE SCREEN: a message we sent to a number that could not be
 * matched to this record (filed under lead:<number>, which the record read never looks
 * at), a reply to a waitlist slot offer, a STOP from a number in no campaign, and
 * anything scanned onto Dentally's record on paper. A heading claiming completeness
 * over any of them is the defect this file keeps re-learning.
 *
 * WHAT CHANGED ON 2026-08-31, AND IT IS THE THIRD TIME THIS TAB HAS PRINTED A FALSE
 * SENTENCE ABOUT THE CONNECTION. It said Dentally's "letters, email and scanned
 * documents are not [shown], because Dentally does not return them." Read-only probes
 * found /v1/patient_documents answers with the practice's existing key (eight real
 * rows across four patients), and /v1/emails answers too — it simply returned nothing,
 * which is a different fact and is now stated as one. Only the scanned-paper third
 * survived, and it survives on EVIDENCE now rather than on assumption: every document
 * returned was a signed iPad form, and the two other paths that might have held scans
 * (/v1/documents, /v1/patient_files) 404.
 *
 * The predecessors of that sentence were "Dentally does not expose its correspondence
 * through the connection we have" (false: /v1/sms) and a clinical-notes read pointed at
 * a /v1/patient_notes path that never existed. The pattern is always the same — a
 * permanent claim about the connection, made once as an honest answer, never
 * re-checked. Every claim on this screen is therefore about what was MEASURED and what
 * is ON THIS SCREEN, never about what Dentally is capable of.
 *
 * SEVEN OUTCOMES, NOT FOUR. Each source is read independently, so the tab must
 * distinguish "none were sent" from "some platform sources are down" from "none could
 * be read" from "Dentally's SMS is not switched on" from "Dentally's documents failed"
 * from "half of Dentally's email answered" from "the history is real but cut short".
 * The failed sources are NAMED, because a count tells a reader something is missing
 * without telling them where to go and look.
 *
 * THE SCOPE BAND IS LOAD-BEARING. It says, in readable ink at the top, that this
 * history lives in the platform and is NOT written back into Dentally. Without that
 * sentence a colleague working in Dentally sees an empty correspondence page and
 * concludes the patient was never contacted.
 */

export function TabCorrespondence({
  timeline,
  failedSources = [],
  totalSources = 0,
  dentally = "off",
  documents = "off",
  emails = "off",
  unreadableEmails = 0,
  dentallyComplete = true,
  view = "pages",
  documentHrefBase = null,
}: {
  /** The merged, ordered view: platform messages, Dentally SMS, documents and emails. */
  timeline: CorrespondenceTimeline;
  /** Human labels of the platform sources that threw. */
  failedSources?: string[];
  totalSources?: number;
  /** Whether Dentally's own SMS log was read, failed, or is switched off. */
  dentally?: DentallySmsHealth;
  /** Whether Dentally's documents were read, failed, or are switched off. */
  documents?: DentallyDocumentsHealth;
  /** Whether Dentally's emails were read, half-read, failed, or are switched off. */
  emails?: DentallyEmailsHealth;
  /** How many email rows arrived in a form this platform could not read. */
  unreadableEmails?: number;
  /** False when a Dentally read that SUCCEEDED could not reach the end of the history. */
  dentallyComplete?: boolean;
  /** The remembered layout, read from the cookie server-side. */
  view?: CorrespondenceView;
  /** Base href for a document link, or null when the documents read is off. */
  documentHrefBase?: string | null;
}) {
  const entries = timeline.entries;
  const undated = timeline.undated;
  const hasAnything = entries.length > 0 || undated.length > 0;

  const failedCount = failedSources.length;
  const allFailed = failedCount > 0 && failedCount >= totalSources;
  const someFailed = failedCount > 0 && !allFailed;
  const anyFailed =
    failedCount > 0 || dentally === "failed" || documents === "failed" || emails === "failed";

  return (
    <div className="space-y-5">
      {/* The practice manager's question was "does this link to the correspondence
          page on Dentally?". The honest answer is that it reads Dentally's SMS,
          documents and email when those are switched on, and writes nothing back
          either way — stated up front in readable ink rather than as a footnote,
          because a reader who assumes otherwise draws a false conclusion about a
          patient in both directions. */}
      <PanelScope title="What this shows">
        {dentally === "ok" ? CORRESPONDENCE_COPY.scopeWithDentally : CORRESPONDENCE_COPY.scopePlatformOnly}
        {/* Appended only in the state that DELIVERS it. A scope sentence promising
            documents while the read is off would be the same failure as the sentence
            this whole commit exists to remove, pointing the other way. */}
        {documents === "ok" ? ` ${CORRESPONDENCE_COPY.scopeDocuments}` : ""}
      </PanelScope>
      <PanelSection title="Message history">
        {someFailed ? <PanelFailed>{partialCorrespondenceCopy(failedSources)}</PanelFailed> : null}
        {/* Which total-failure sentence depends on whether ANYTHING is on screen.
            "We could not read this patient's message history" printed above a visible
            list of Dentally's messages reads as a contradiction, and a reader resolves
            a contradiction by believing the list. */}
        {allFailed ? (
          <PanelFailed>
            {dentally === "ok" && hasAnything
              ? CORRESPONDENCE_COPY.platformFailedDentallyOk
              : FAILED_COPY.correspondence}
          </PanelFailed>
        ) : null}
        {dentally === "failed" ? <PanelFailed>{CORRESPONDENCE_COPY.dentallyFailed}</PanelFailed> : null}
        {/* Each Dentally read gets its OWN failure sentence, naming the thing that is
            missing. One combined "part of Dentally could not be read" would leave a
            reader unable to tell whether they are missing a text message or a signed
            consent form, which are not interchangeable on a clinical record. */}
        {documents === "failed" ? (
          <PanelFailed>{CORRESPONDENCE_COPY.documentsFailed}</PanelFailed>
        ) : null}
        {emails === "failed" ? <PanelFailed>{CORRESPONDENCE_COPY.emailsFailed}</PanelFailed> : null}
        {emails === "partial" ? <PanelFailed>{CORRESPONDENCE_COPY.emailsPartial}</PanelFailed> : null}
        {/* THE OWNER'S "it only goes back to a certain date, which is only to May",
            answered in words. A read that could not reach the end of the history says
            so; silence would tell the reader the history simply ends there. */}
        {!dentallyComplete ? (
          <PanelFailed>{CORRESPONDENCE_COPY.dentallyHistoryIncomplete}</PanelFailed>
        ) : null}
        {unreadableEmails > 0 ? <PanelFailed>{CORRESPONDENCE_COPY.emailsUnreadable}</PanelFailed> : null}

        {!hasAnything && !allFailed ? (
          <>
            <PanelEmpty>
              {/* The WIDER claim - that Dentally holds nothing either - may only be made
                  when Dentally was actually read. Switched off or failed, the narrower
                  platform-only sentence is the only true one.

                  BOTH carry the Conversations-inbox pointer, because an empty panel
                  here is the tab's most dangerous state: a patient texted minutes ago on
                  a number identifyByPhone could not match is filed under lead:<number>,
                  which this read never looks at, and the bare sentence told the reader
                  in writing that nothing had been sent. */}
              {dentally === "ok" && !anyFailed
                ? EMPTY_COPY.correspondenceWithDentally
                : EMPTY_COPY.correspondence}
            </PanelEmpty>
            {/* The inbound exceptions belong here as much as beside a list: "no messages"
                is also a claim about what came back, and a reply to a waitlist offer
                cannot reach this screen at all. Previously these notes rendered ONLY when
                the list was non-empty, so the emptiest screen made the widest claim with
                the fewest caveats. */}
            <PanelNote>{CORRESPONDENCE_COPY.inboundGaps}</PanelNote>
          </>
        ) : null}

        {hasAnything ? (
          <CorrespondenceTimelineView
            entries={entries}
            undated={undated}
            initialView={view}
            documentHrefBase={documentHrefBase}
          />
        ) : null}

        {hasAnything ? (
          <>
            <PanelNote>{CORRESPONDENCE_COPY.sentMeaning}</PanelNote>
            <PanelNote>{CORRESPONDENCE_COPY.draftsExcluded}</PanelNote>
            {/* THE OUTBOUND EXCEPTION, next to the list rather than inferred from an
                absence. Every send path records, but a record row keyed lead:<number> is
                on a conversation this patient's read never touches, and identification
                fails routinely: it matches mobile_phone only, and the missed-call lookup
                is capped at 3 seconds. */}
            <PanelNote>{CORRESPONDENCE_COPY.unmatchedNumbers}</PanelNote>
            {/* The scope paragraph above claims every message this platform SENT, with
                that one exception. It does not claim the same of what came back, so the
                two replies that cannot reach this list are named here too, next to the
                list a reader is scanning. */}
            <PanelNote>{CORRESPONDENCE_COPY.inboundGaps}</PanelNote>
            {/* Was a bare string in this JSX, which is the one thing this tab's copy rules
                forbid: an untested sentence making a claim about completeness. */}
            <PanelNote>{CORRESPONDENCE_COPY.boundedRows}</PanelNote>
          </>
        ) : null}

        {/* SAID IN BOTH STATES, empty and full alike, and that is deliberate. Scanned
            paper is missing whether or not this patient has anything else, and the
            emptiest screen is the one where a reader is most likely to conclude the
            record is bare. Shown only when the documents read is actually on: while it
            is off, the tab is not claiming to show Dentally's documents at all, and a
            caveat about a subset of a thing you are not showing is noise. */}
        {documents === "ok" ? (
          <PanelNote>{CORRESPONDENCE_COPY.scannedUploadsUnreadable}</PanelNote>
        ) : null}
        {/* The email finding, said only when the read RAN and came back empty. Never
            "this patient has no emails" — the connection returned none on every patient
            checked, which is a fact about the connection, not about the patient. */}
        {emails === "ok" && !entries.some((e) => e.kind === "email") ? (
          <PanelNote>{CORRESPONDENCE_COPY.emailsEmpty}</PanelNote>
        ) : null}
      </PanelSection>
    </div>
  );
}
