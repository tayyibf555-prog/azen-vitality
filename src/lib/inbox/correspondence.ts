import { readPatientDentallySms, type DentallySmsHealth } from "@/lib/dentally/sms";
import { getThreadForPatient } from "./repository";
import { mergeDentallySms } from "./dentally-merge";
import { sourceLabel } from "./delivery";
import type { InboxMessage } from "./types";

/**
 * ONE patient's complete correspondence, from every place a message can live.
 *
 * WHY THIS SITS ABOVE ./repository RATHER THAN INSIDE IT. The repository reads this
 * platform's own stores and is also what the site-wide Conversations inbox uses;
 * putting a per-patient Dentally GET inside it would put a live upstream call on a
 * path that lists every thread for a site. The patient record is the only screen that
 * can afford one Dentally read per open, so the composition happens here.
 *
 * THE HEALTH FIELDS ARE THE FEATURE. Twelve platform stores plus Dentally are read
 * independently and every one of them is caught, so the screen must be able to say
 * which of four things happened: everything read, some sources are down, everything
 * is down, or Dentally's own history is simply not switched on. Collapsing those into
 * "here is the history" is how a record ends up asserting that a patient was never
 * contacted during the exact outage that hid the messages.
 */

export interface PatientCorrespondence {
  /** Every message, oldest first (chat order). */
  messages: InboxMessage[];
  /** Human labels of the platform sources that threw, e.g. ["Recall", "Campaign"]. */
  failedSources: string[];
  /** How many platform sources were attempted, so "some" and "all" are tellable apart. */
  totalSources: number;
  /** Whether Dentally's own SMS log was read, failed, or is not switched on. */
  dentally: DentallySmsHealth;
}

export async function getPatientCorrespondence(
  siteIds: string[],
  patientId: string,
  patientName = "",
): Promise<PatientCorrespondence> {
  // Deliberately parallel and deliberately independent: Dentally being unreachable
  // must not cost the platform's own history, and vice versa.
  const [platform, dentally] = await Promise.all([
    getThreadForPatient(siteIds, patientId).catch((err) => {
      // getThreadForPatient catches per source and does not throw; this guards the
      // one thing it cannot catch (constructing the client at all) so the record
      // page never 500s on a message history.
      console.warn("correspondence: platform thread read threw outright", err);
      return { thread: null, failedSources: 1, totalSources: 1, failedSourceNames: ["agent"] };
    }),
    readPatientDentallySms(patientId),
  ]);

  const platformMessages = platform.thread?.messages ?? [];
  const messages =
    dentally.health === "ok" && dentally.messages.length > 0
      ? mergeDentallySms(platformMessages, dentally.messages, patientId, patientName)
      : platformMessages;

  return {
    messages,
    failedSources: platform.failedSourceNames.map(sourceLabel),
    totalSources: platform.totalSources,
    dentally: dentally.health,
  };
}
