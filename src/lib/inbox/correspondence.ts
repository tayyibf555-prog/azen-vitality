import { readPatientDentallySms, type DentallySmsHealth } from "@/lib/dentally/sms";
import { readPatientDentallyDocuments, type DentallyDocumentsHealth } from "@/lib/dentally/documents";
import { readPatientDentallyEmails, type DentallyEmailsHealth } from "@/lib/dentally/emails";
import { getThreadForPatient } from "./repository";
import { mergeDentallySms } from "./dentally-merge";
import { buildCorrespondenceTimeline, type CorrespondenceTimeline } from "./correspondence-timeline";
import { sourceLabel } from "./delivery";
import type { InboxMessage } from "./types";

/**
 * ONE patient's complete correspondence, from every place a message can live.
 *
 * WHY THIS SITS ABOVE ./repository RATHER THAN INSIDE IT. The repository reads this
 * platform's own stores and is also what the site-wide Conversations inbox uses;
 * putting a per-patient Dentally GET inside it would put a live upstream call on a
 * path that lists every thread for a site. The patient record is the only screen that
 * can afford Dentally reads per open, so the composition happens here.
 *
 * THE HEALTH FIELDS ARE THE FEATURE. Twelve platform stores plus THREE Dentally reads
 * are read independently and every one of them is caught, so the screen must be able to
 * say which of several things happened for each: everything read, some sources are
 * down, everything is down, or that read is simply not switched on. Collapsing those
 * into "here is the history" is how a record ends up asserting that a patient was never
 * contacted during the exact outage that hid the messages.
 *
 * WHAT CHANGED ON 2026-08-31, AND WHY IT IS FOUR READS AND NOT ONE. On the 27 August
 * call the practice owner put this tab beside Dentally's own correspondence page and
 * named what was missing. Read-only probes then found that two of the three things the
 * tab said Dentally "does not return" were reachable: /v1/patient_documents holds the
 * signed forms, and /v1/emails answers (though it returned nothing on every patient
 * checked). Each is its own read, its own switch and its own health value — never
 * folded into the SMS one — because a practice must be able to enable a read that has
 * been verified against live without also enabling one that has not, and because
 * "documents read fine, email failed" is a sentence the screen has to be able to say.
 *
 * COST, STATED HERE BECAUSE THIS IS WHERE IT IS SPENT. With every switch on, opening
 * this tab costs FOUR Dentally GETs: one for SMS, one for documents, and two for email
 * (its `external_provider` parameter is mandatory and takes two values, so the two
 * buckets are two queries). All four are classified INTERACTIVE inside their own
 * modules, so they draw on the display ceiling and can never starve booking or the
 * background sweeps.
 */

export interface PatientCorrespondence {
  /**
   * Every message, oldest first (chat order).
   *
   * KEPT ALONGSIDE `timeline` rather than replaced by it. The messages half is what the
   * merge with Dentally's SMS operates on and what several existing callers and tests
   * consume; the timeline is the rendered view that also carries documents and emails.
   * Deriving one from the other at every call site would put the flattening rule in two
   * places.
   */
  messages: InboxMessage[];
  /** The merged, ordered view the record screen renders: messages + documents + emails. */
  timeline: CorrespondenceTimeline;
  /** Human labels of the platform sources that threw, e.g. ["Recall", "Campaign"]. */
  failedSources: string[];
  /** How many platform sources were attempted, so "some" and "all" are tellable apart. */
  totalSources: number;
  /** Whether Dentally's own SMS log was read, failed, or is not switched on. */
  dentally: DentallySmsHealth;
  /** Whether Dentally's documents were read, failed, or are not switched on. */
  documents: DentallyDocumentsHealth;
  /** Whether Dentally's emails were read, half-read, failed, or are not switched on. */
  emails: DentallyEmailsHealth;
  /**
   * How many email rows arrived that this platform could not read at all.
   *
   * Surfaced up to the screen rather than being handled quietly in the read, because
   * the only useful response to it is a human going and looking — see
   * CORRESPONDENCE_COPY.emailsUnreadable.
   */
  unreadableEmails: number;
  /**
   * FALSE when any Dentally read that SUCCEEDED could not reach the end of its history.
   *
   * The owner's "it only goes back to a certain date, which is only to May", given a
   * field. A single flag across the three reads rather than three flags, because the
   * sentence a reader needs is the same in every case — "this is not the whole history"
   * — and three near-identical warnings on one panel is the row-of-amber-chips failure
   * this project already shipped once.
   */
  dentallyComplete: boolean;
}

export async function getPatientCorrespondence(
  siteIds: string[],
  patientId: string,
  patientName = "",
): Promise<PatientCorrespondence> {
  // Deliberately parallel and deliberately independent: Dentally being unreachable
  // must not cost the platform's own history, and vice versa. The three Dentally reads
  // are independent of each other for the same reason — a documents shape change must
  // not be able to hide the SMS history.
  const [platform, dentally, documents, emails] = await Promise.all([
    getThreadForPatient(siteIds, patientId).catch((err) => {
      // getThreadForPatient catches per source and does not throw; this guards the
      // one thing it cannot catch (constructing the client at all) so the record
      // page never 500s on a message history.
      console.warn("correspondence: platform thread read threw outright", err);
      return { thread: null, failedSources: 1, totalSources: 1, failedSourceNames: ["agent"] };
    }),
    readPatientDentallySms(patientId),
    readPatientDentallyDocuments(patientId),
    readPatientDentallyEmails(patientId),
  ]);

  const platformMessages = platform.thread?.messages ?? [];
  const messages =
    dentally.health === "ok" && dentally.messages.length > 0
      ? mergeDentallySms(platformMessages, dentally.messages, patientId, patientName)
      : platformMessages;

  return {
    messages,
    timeline: buildCorrespondenceTimeline(messages, documents.documents, emails.emails),
    failedSources: platform.failedSourceNames.map(sourceLabel),
    totalSources: platform.totalSources,
    dentally: dentally.health,
    documents: documents.health,
    emails: emails.health,
    unreadableEmails: emails.unreadable,
    // ONLY reads that actually ran can contribute an incompleteness. A read that is off
    // or that failed reports `complete: true` from its own module precisely so it does
    // not raise a second warning on top of the sentence it already has — see the
    // catch in readPatientDentallySms.
    dentallyComplete: dentally.complete && documents.complete && emails.complete,
  };
}
