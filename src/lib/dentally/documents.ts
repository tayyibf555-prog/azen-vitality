import { DentallyClient } from "./client";
import { dentallyFromEnv } from "./read";
import { runWithDentallyPriority } from "./budget";
import { metaTotal, pageToCompletion } from "./paging";
import {
  documentsFromEnvelope,
  toDentallyDocumentRecords,
  type DentallyDocumentRecord,
} from "./documents-shape";

/**
 * Reading the DOCUMENTS Dentally holds for one patient.
 *
 * THE FINDING THIS EXISTS FOR. The Correspondence tab said, in readable ink at the top
 * of a clinical record, that Dentally's "letters, email and scanned documents are not
 * [shown], because Dentally does not return them". `/v1/patient_documents` answers 200
 * on a per-patient read with the key the practice already holds. The sentence was
 * written as an honest answer to a real question from the practice manager and it was
 * simply false about a third of what it denied — the same way the tab's earlier "-
 * Dentally does not expose its correspondence" claim was false about /v1/sms, and the
 * same way the clinical-notes read was pointed at a `/v1/patient_notes` path that never
 * existed. A permanent claim about the connection, made once, never re-checked, is this
 * project's most repeated defect.
 *
 * DEFAULT OFF, ON ITS OWN SWITCH, AND THAT IS THE POINT. This does NOT ride on
 * DENTALLY_SMS_READ_ENABLED. Two independent reads against two undocumented endpoints
 * get two independent switches, so a practice can turn on the one that has been checked
 * against live without also turning on the one that has not. Switching either on is a
 * deliberate act by a human who has just verified it, not a default this code assumes.
 *
 * WHAT SWITCHING IT ON CHANGES. One extra Dentally GET per patient-record open of the
 * Correspondence tab (the resource has no practice-wide index, so there is no cheaper
 * shape), classified INTERACTIVE so it draws on the display ceiling and can never
 * starve booking or the background sweeps. And the tab's scope sentence changes to say
 * documents are included, which must not happen while the read is off or the screen
 * would be making a claim it is not delivering.
 *
 * WHAT IT NEVER DOES. Write. These are signed clinical consent records; this platform
 * has no business creating or altering one, Dentally publishes no route for it, and the
 * client's readOnly latch refuses every non-GET before the request is built.
 */

/**
 * How many pages of one patient's documents to walk.
 *
 * Generous for the same reason MAX_SMS_PAGES is: the walk is bounded by Dentally's own
 * meta.total, not by this, and the patient this has to cover is the one with fifteen
 * years of signed forms. The four patients probed on 2026-08-31 held 2, 0, 5 and 1.
 */
const MAX_DOCUMENT_PAGES = 20;
const PER_PAGE = 100;

export type DentallyDocumentsHealth = "off" | "ok" | "failed";

export interface DentallyDocumentsRead {
  /** Oldest first, matching the correspondence timeline's chat order. */
  documents: DentallyDocumentRecord[];
  /**
   * `off` when the read is not enabled — NOT the same as `ok` with none found. The tab
   * must be able to say "we do not show Dentally's documents" rather than "Dentally
   * holds none for this patient", which would be a claim about the patient's consent
   * records.
   */
  health: DentallyDocumentsHealth;
  /** False when this is only part of the patient's document history. See sms.ts. */
  complete: boolean;
}

/** True only when the read is explicitly enabled. See the header for why it is its own flag. */
export function isDentallyDocumentsReadEnabled(): boolean {
  return process.env.DENTALLY_DOCUMENTS_READ_ENABLED === "true";
}

/**
 * One patient's Dentally documents, or a health flag saying why there are none.
 *
 * NEVER THROWS, for the reason readPatientDentallySms never throws: the caller is a
 * patient record, and a record that 500s because an undocumented endpoint changed shape
 * is worse than one that says it could not read part of the history. The throw from
 * ./documents-shape is caught here and turned into `health: "failed"`, which the tab
 * renders as a failed-read notice — never as "Dentally holds no documents for this
 * patient".
 */
export async function readPatientDentallyDocuments(
  patientId: string,
  opts: { client?: DentallyClient } = {},
): Promise<DentallyDocumentsRead> {
  if (!isDentallyDocumentsReadEnabled()) return { documents: [], health: "off", complete: true };
  if (!patientId) return { documents: [], health: "off", complete: true };
  const client = opts.client ?? dentallyFromEnv();
  try {
    const read = await runWithDentallyPriority("interactive", () =>
      pageToCompletion<unknown>(
        async (page, perPage) => {
          const env = await client.getPatientDocuments(patientId, page, perPage);
          // documentsFromEnvelope THROWS on an envelope it does not recognise, and that
          // must not be softened to `?? []`: an empty document list on a consent record
          // is a claim, and a shape change must never be able to make it.
          return {
            rows: documentsFromEnvelope(env),
            total: metaTotal((env as { meta?: unknown }).meta),
          };
        },
        PER_PAGE,
        MAX_DOCUMENT_PAGES,
      ),
    );
    const documents = toDentallyDocumentRecords(read.rows);
    // Oldest first, to match the chat order the correspondence timeline renders in.
    // Dentally returns these newest-first; the timeline merge re-sorts everything
    // anyway, but sorting here keeps this module's own contract honest.
    documents.sort((a, b) => a.at.localeCompare(b.at));
    return { documents, health: "ok", complete: read.complete };
  } catch (err) {
    console.warn(`dentally: failed to read /v1/patient_documents for patient ${patientId}`, err);
    return { documents: [], health: "failed", complete: true };
  }
}

/**
 * ONE document's CURRENT presigned link, re-read at the moment somebody clicks it.
 *
 * WHY THIS IS NOT JUST A FIELD ON THE ROW ABOVE. The `url` Dentally returns is a
 * presigned S3 link carrying X-Amz-Expires and an X-Amz-Date stamped at the instant of
 * the read. Measured 2026-08-31: X-Amz-Expires was 42033 and 42001 seconds — about
 * eleven and a half hours. A record page rendered at nine in the morning therefore
 * carries links that are dead before the next morning's clinic, and a dead link on a
 * consent record does not read as "this link expired", it reads as "the document is
 * gone". So the screen never links at the baked URL; it links at our own route, which
 * calls this, and this re-reads Dentally so the browser is handed a link minted seconds
 * ago.
 *
 * Returns null when the document is not on this patient's list — which is also the
 * ACCESS CHECK, and it is why this takes a patientId rather than a document id alone.
 * A caller may only ever reach a document through the patient it belongs to, so a
 * mismatched pair yields null and the route 404s, exactly as the record's own
 * out-of-scope patients do.
 */
export async function readDocumentUrl(
  patientId: string,
  documentId: string,
  opts: { client?: DentallyClient } = {},
): Promise<string | null> {
  if (!isDentallyDocumentsReadEnabled()) return null;
  if (!patientId || !documentId) return null;
  const read = await readPatientDentallyDocuments(patientId, opts);
  if (read.health !== "ok") return null;
  const doc = read.documents.find((d) => d.id === documentId);
  return doc && doc.url !== "" ? doc.url : null;
}
