import { DentallyClient } from "./client";
import { dentallyFromEnv } from "./read";
import { runWithDentallyPriority } from "./budget";
import { metaTotal, pageToCompletion } from "./paging";
import {
  emailsFromEnvelope,
  toDentallyEmailRecords,
  unreadableCount,
  type DentallyEmailRecord,
} from "./emails-shape";

/**
 * Reading the EMAILS Dentally holds for one patient.
 *
 * THE HONEST STATE OF THIS ENDPOINT. `/v1/emails` answers. It requires BOTH
 * `patient_id` and `external_provider` — measured, each one produced its own 422 —
 * and it returns 200 for both values of the second. It has no practice-wide index. And
 * across six live reads on 2026-08-31 (patients 15, 40000 and 56194, in both buckets)
 * it returned ZERO ROWS EVERY TIME, with meta.total 0.
 *
 * SO THIS MODULE SHIPS TO ANSWER A QUESTION, NOT TO DELIVER A KNOWN FEATURE. The
 * practice owner said every patient has "emails we sent him" in Dentally. This route
 * cannot evidence that on any patient checked, including the practice's most recently
 * active records. Either the mail is somewhere this connection cannot reach, or this
 * endpoint fills under conditions the probe did not meet. Switching this read on is how
 * the practice finds out on a real patient, which is why it exists — and the tab's copy
 * states the finding plainly rather than implying either that emails are shown or that
 * the practice never emailed anybody.
 *
 * DEFAULT OFF, ON ITS OWN SWITCH, and here that matters more than anywhere. This is the
 * least-calibrated read in the Dentally layer: not one row has ever been seen. It must
 * not ride on the documents flag (eight real rows) or the SMS flag (three patients of
 * real rows), because a practice enabling a verified read must not silently also enable
 * an unverified one.
 *
 * WHAT SWITCHING IT ON COSTS. TWO Dentally GETs per Correspondence-tab open, not one —
 * `external_provider` is mandatory and the two buckets are two separate queries, and
 * there is no way to ask for both. Both are classified INTERACTIVE so they draw on the
 * display ceiling and can never starve booking or the background sweeps. That cost is
 * stated here because it is the reason a practice might reasonably leave this off: two
 * reads per record open, for a feed that has so far been empty every time.
 *
 * WHAT IT NEVER DOES. Write. Dentally sends mail on the practice's behalf, so a POST
 * here would most likely transmit a real email to a real patient rather than file a
 * record of one — the identical hazard /v1/sms carries with Twilio. The client's
 * readOnly latch refuses every non-GET before the request is built.
 */

const MAX_EMAIL_PAGES = 20;
const PER_PAGE = 100;

export type DentallyEmailsHealth = "off" | "ok" | "partial" | "failed";

export interface DentallyEmailsRead {
  /** Oldest first, matching the correspondence timeline's chat order. */
  emails: DentallyEmailRecord[];
  /**
   * `off`     the read is not enabled.
   * `ok`      BOTH buckets were read.
   * `partial` ONE bucket answered and the other threw. See the read below for why this
   *           is its own value: reporting a half-read as "ok" would let the screen
   *           assert a completeness it does not have, and reporting it as "failed"
   *           would throw away emails that were successfully read.
   * `failed`  neither bucket could be read.
   */
  health: DentallyEmailsHealth;
  /** False when this is only part of the patient's email history. See sms.ts. */
  complete: boolean;
  /**
   * How many rows arrived that this platform could not read at all.
   *
   * Never zero-by-omission: ./emails-shape refuses to drop a row it cannot parse,
   * because the row shape has never been calibrated and dropping one would hide a real
   * email behind a wrong guess about a field name. The tab prints this count.
   */
  unreadable: number;
}

/** True only when the read is explicitly enabled. See the header for why it is its own flag. */
export function isDentallyEmailsReadEnabled(): boolean {
  return process.env.DENTALLY_EMAILS_READ_ENABLED === "true";
}

/** One bucket of one patient's mail. Throws; the caller decides what a half-read means. */
async function readBucket(
  client: DentallyClient,
  patientId: string,
  externalProvider: boolean,
): Promise<{ emails: DentallyEmailRecord[]; complete: boolean }> {
  const read = await pageToCompletion<unknown>(
    async (page, perPage) => {
      const env = await client.getPatientEmails(patientId, externalProvider, page, perPage);
      // The ENVELOPE is calibrated (six live 200s), so this half keeps the strict rule
      // and throws on a shape it does not recognise. The ROW mapper below is the loose
      // one, and ./emails-shape's header explains at length why the two differ.
      return { rows: emailsFromEnvelope(env), total: metaTotal((env as { meta?: unknown }).meta) };
    },
    PER_PAGE,
    MAX_EMAIL_PAGES,
  );
  return { emails: toDentallyEmailRecords(read.rows, externalProvider), complete: read.complete };
}

/**
 * One patient's Dentally emails from BOTH buckets, or a health flag saying why not.
 *
 * NEVER THROWS, for the reason every read on this record never throws: the caller is a
 * patient record and a 500 on a message history is worse than a stated failure.
 *
 * THE TWO BUCKETS ARE CAUGHT SEPARATELY, which is the one interesting decision here.
 * `external_provider` is mandatory and takes two values, so this is two queries and
 * they can fail independently. Catching them together would mean one bucket throwing
 * discards the other bucket's real emails; treating a one-bucket success as a full
 * success would let the screen imply it has the patient's whole mail history when it
 * has at most half. `partial` is the third answer, and the tab prints a sentence for it.
 */
export async function readPatientDentallyEmails(
  patientId: string,
  opts: { client?: DentallyClient } = {},
): Promise<DentallyEmailsRead> {
  if (!isDentallyEmailsReadEnabled()) {
    return { emails: [], health: "off", complete: true, unreadable: 0 };
  }
  if (!patientId) return { emails: [], health: "off", complete: true, unreadable: 0 };
  const client = opts.client ?? dentallyFromEnv();

  const [own, external] = await runWithDentallyPriority("interactive", () =>
    Promise.all([
      readBucket(client, patientId, false).then(
        (r) => ({ ok: true as const, ...r }),
        (err) => {
          console.warn(`dentally: failed to read /v1/emails (own) for patient ${patientId}`, err);
          return { ok: false as const, emails: [] as DentallyEmailRecord[], complete: true };
        },
      ),
      readBucket(client, patientId, true).then(
        (r) => ({ ok: true as const, ...r }),
        (err) => {
          console.warn(`dentally: failed to read /v1/emails (external) for patient ${patientId}`, err);
          return { ok: false as const, emails: [] as DentallyEmailRecord[], complete: true };
        },
      ),
    ]),
  );

  const okCount = (own.ok ? 1 : 0) + (external.ok ? 1 : 0);
  const health: DentallyEmailsHealth = okCount === 2 ? "ok" : okCount === 1 ? "partial" : "failed";
  const emails = [...own.emails, ...external.emails];
  // Oldest first, to match the chat order the correspondence timeline renders in.
  emails.sort((a, b) => a.at.localeCompare(b.at));
  return {
    emails,
    health,
    // Completeness is only claimed over buckets that actually answered. A bucket that
    // threw contributes `complete: true` above precisely so it does not raise a
    // second, redundant incompleteness warning on top of the `partial` sentence.
    complete: own.complete && external.complete,
    unreadable: unreadableCount(emails),
  };
}
