import { DentallyClient } from "./client";
import { dentallyFromEnv } from "./read";
import { runWithDentallyPriority } from "./budget";
import { smsFromEnvelope, toDentallySmsRecords, type DentallySmsRecord } from "./sms-shape";

/**
 * Reading Dentally's OWN SMS history for one patient.
 *
 * THE FINDING THIS EXISTS FOR. The question put to this build was whether the
 * platform could write its correspondence BACK into Dentally, so a Dentally-only
 * member of staff sees one complete history. The answer is no — see
 * docs/runbooks/correspondence-visibility.md — but the premise turned out to be
 * wrong in a better way: Dentally's own SMS feed is READABLE on a route the
 * practice's key already has scope for, and nothing was reading it. So the fix runs
 * the other way. Pull Dentally's messages IN, rather than pushing ours OUT.
 *
 * DEFAULT OFF, AND THAT IS THE POINT. `/v1/sms` is undocumented: absent from
 * developer.dentally.co's resource list and from its changelog, gated by a
 * `correspondence` scope that is absent from the published scope table. Its shape was
 * calibrated in one recorded read-only session and cannot be re-verified from a
 * development machine. Switching it on is therefore a deliberate act by a human who
 * has just checked it against live, not a default this code assumes — the same
 * discipline the write gate uses, for the same reason.
 *
 * WHAT SWITCHING IT ON CHANGES. One extra Dentally GET per patient-record open (the
 * resource has no practice-wide index, so there is no cheaper shape), classified
 * INTERACTIVE so it draws on the display ceiling and can never starve booking or the
 * background sweeps. And the Correspondence tab's scope sentence changes to say that
 * Dentally's SMS is included, which must not happen while the read is off or the
 * screen would be making a claim it is not delivering.
 *
 * WHAT IT NEVER DOES. Write. Not a note, not a log entry, not a probe. Dentally
 * sends its SMS via Twilio, so a POST here would most likely transmit a real text to
 * a real patient rather than file a record of one. The client's readOnly latch
 * refuses every non-GET before it is constructed.
 */

/** How many pages of one patient's SMS to walk. 10 x 100 rows is a whole history. */
const MAX_SMS_PAGES = 10;
const PER_PAGE = 100;

export type DentallySmsHealth = "off" | "ok" | "failed";

export interface DentallySmsRead {
  /** Newest-last, matching the correspondence timeline's chat order. */
  messages: DentallySmsRecord[];
  /**
   * `off` when the read is not enabled — NOT the same as `ok` with no messages.
   * The tab must be able to say "we do not show Dentally's own SMS" rather than
   * "Dentally has none for this patient", which would be a claim about the patient.
   */
  health: DentallySmsHealth;
}

/**
 * True only when the read is explicitly enabled.
 *
 * One flag, not three (the write gate needs a dedicated key and base URL because
 * enabling it wrongly writes to production; enabling this wrongly reads a patient's
 * own messages with a key that is already reading their clinical notes on the same
 * screen). The blast radius of a mistake here is a failed read, which fails soft.
 */
export function isDentallySmsReadEnabled(): boolean {
  return process.env.DENTALLY_SMS_READ_ENABLED === "true";
}

/**
 * One patient's Dentally SMS history, or a health flag saying why there is none.
 *
 * NEVER THROWS. The caller is a patient record, and a record that 500s because an
 * undocumented endpoint changed shape is worse than one that says it could not read
 * part of the history. The throw from ./sms-shape is caught here and turned into
 * `health: "failed"`, which the tab renders as a failed-read notice — never as
 * "Dentally holds no messages for this patient".
 */
export async function readPatientDentallySms(
  patientId: string,
  opts: { client?: DentallyClient } = {},
): Promise<DentallySmsRead> {
  if (!isDentallySmsReadEnabled()) return { messages: [], health: "off" };
  if (!patientId) return { messages: [], health: "off" };
  const client = opts.client ?? dentallyFromEnv();
  try {
    const rows = await runWithDentallyPriority("interactive", async () => {
      const all: unknown[] = [];
      for (let page = 1; page <= MAX_SMS_PAGES; page += 1) {
        // smsFromEnvelope THROWS on an envelope it does not recognise. That is
        // deliberate and must not be softened: `?? []` here would stop the pager on
        // a shape change and report a confident, empty, wrong history.
        const pageRows = smsFromEnvelope(await client.getPatientSms(patientId, page, PER_PAGE));
        all.push(...pageRows);
        if (pageRows.length < PER_PAGE) break; // short page => last page
      }
      return all;
    });
    const messages = toDentallySmsRecords(rows);
    // Oldest first, to match the chat order the correspondence timeline renders in.
    messages.sort((a, b) => a.at.localeCompare(b.at));
    return { messages, health: "ok" };
  } catch (err) {
    console.warn(`dentally: failed to read /v1/sms for patient ${patientId}`, err);
    return { messages: [], health: "failed" };
  }
}
