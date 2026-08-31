import { DentallyClient } from "./client";
import { dentallyFromEnv } from "./read";
import { runWithDentallyPriority } from "./budget";
import { metaTotal, pageToCompletion } from "./paging";
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

/**
 * How many pages of one patient's SMS to walk.
 *
 * RAISED FROM 10, and the ceiling is no longer the thing doing the work. What bounds
 * this read now is Dentally's own `meta.total` (see pageToCompletion): the walk stops
 * the moment it has as many rows as Dentally says exist. The ceiling is only a
 * runaway guard for a pathological response, so it can afford to be generous — and it
 * must be, because it is a PER-PATIENT read and the patient it has to cover is the one
 * with fifteen years of reminders, not the median one.
 *
 * 40 x 100 is 4,000 messages. If a real patient ever exceeds that, the read comes back
 * `complete: false` and the screen SAYS the history is cut short, which is the whole
 * point of the change.
 */
const MAX_SMS_PAGES = 40;
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
  /**
   * FALSE when this is only part of the patient's Dentally history.
   *
   * THE OWNER'S ACTUAL COMPLAINT, given a field. Side by side with Dentally's own
   * correspondence page he said of ours: "it only goes back to a certain date, which
   * is only to May". The old walk had no way to know that had happened, so the screen
   * had no way to say it, so a list missing everything before May asserted by its
   * silence that nothing was said before May.
   *
   * Meaningful only when `health` is "ok": a read that failed or is switched off makes
   * no claim about completeness either way, and this stays true so no caller can read
   * an incompleteness warning out of a read that never ran.
   */
  complete: boolean;
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
  if (!isDentallySmsReadEnabled()) return { messages: [], health: "off", complete: true };
  if (!patientId) return { messages: [], health: "off", complete: true };
  const client = opts.client ?? dentallyFromEnv();
  try {
    // THE WALK IS MEASURED NOW, not guessed at. The loop that stood here stopped on
    // the first page shorter than PER_PAGE and reported nothing about whether that
    // was the end of the list. pageToCompletion compares what it has against
    // Dentally's own meta.total — which /v1/sms publishes, and which the old loop
    // never read — so a history cut short is a fact the screen can state rather than
    // a silence a reader mistakes for "nothing was sent". See paging.ts for the two
    // ways the old short-page stop ended a walk early.
    const read = await runWithDentallyPriority("interactive", () =>
      pageToCompletion<unknown>(
        async (page, perPage) => {
          const env = await client.getPatientSms(patientId, page, perPage);
          // smsFromEnvelope THROWS on an envelope it does not recognise. That is
          // deliberate and must not be softened: `?? []` here would stop the pager on
          // a shape change and report a confident, empty, wrong history.
          return { rows: smsFromEnvelope(env), total: metaTotal((env as { meta?: unknown }).meta) };
        },
        PER_PAGE,
        MAX_SMS_PAGES,
      ),
    );
    const messages = toDentallySmsRecords(read.rows);
    // Oldest first, to match the chat order the correspondence timeline renders in.
    messages.sort((a, b) => a.at.localeCompare(b.at));
    return { messages, health: "ok", complete: read.complete };
  } catch (err) {
    console.warn(`dentally: failed to read /v1/sms for patient ${patientId}`, err);
    // `complete: true` on a FAILURE is deliberate and is not a claim that the history
    // is whole. health "failed" already tells the screen it has nothing; adding an
    // incompleteness warning on top would put two different failure sentences on one
    // panel and make the reader work out which applies.
    return { messages: [], health: "failed", complete: true };
  }
}
