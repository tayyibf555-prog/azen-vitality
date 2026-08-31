/**
 * The shape of a Dentally patient-documents page, as its own pure module.
 *
 * WHAT THIS ENDPOINT IS. `/v1/patient_documents` is where Dentally files the forms a
 * patient signs on the practice iPad — on this practice, the NHS personal-record
 * declaration. It is the readable half of what the Correspondence tab used to deny
 * existed: the tab said Dentally's "letters, email and scanned documents are not
 * [shown], because Dentally does not return them", and the documents third of that
 * sentence was simply false.
 *
 * PROVENANCE — read-only GETs, api.dentally.co, 2026-08-31, four patients (15, 56194,
 * 40000, 30000) returning 2, 0, 5 and 1 rows against meta.total 2, 0, 5 and 1. The full
 * calibration, including the S3 link expiry and the scanned-uploads finding, is on
 * DentallyClient.getPatientDocuments; it is not repeated here.
 *
 * WHY THE GUARDS ARE THE SAME AS ./sms-shape's. Eight real rows on four patients is a
 * genuine calibration — stronger than /v1/emails has (zero rows, ever) and comparable
 * to /v1/sms's. So this module takes the STRICT posture: an envelope it does not
 * recognise THROWS, and rows carrying none of the calibrated field names THROW. Neither
 * may be softened to `?? []`. That operator is what turns a shape change into a
 * confident empty result, and a confident empty here reads on a clinical record as
 * "this patient has signed nothing", which is a claim about their consent.
 *
 * A THROW HERE IS SAFE BY DESIGN. The caller catches it into a failed-read notice on
 * the tab, which is true whether the cause is a shape change, a revoked scope or the
 * endpoint being withdrawn.
 */

/** One document Dentally holds against a patient, as the record screen consumes it. */
export interface DentallyDocumentRecord {
  id: string;
  /** Dentally's own description, e.g. "NHS PR". May be empty. */
  description: string;
  /**
   * Dentally's form identifier, e.g. "nhs_pr_r11_en", or null.
   *
   * THIS IS THE FIELD THAT DECIDES THE LABEL, and it is the only honest way to tell
   * the two kinds apart. A row WITH a form_id is a form the patient completed on the
   * practice iPad. A row WITHOUT one is a file somebody put on the record — an upload.
   * See documentKind below for why the distinction may not be guessed from anything
   * else on the row.
   */
  formId: string | null;
  /** When Dentally filed it. This is what the timeline sorts on. */
  at: string;
  /** Whether the patient signed it, and when. */
  signed: boolean;
  signedAt: string | null;
  /** Whether Dentally expects a signature that has not been given. */
  requiresSigning: boolean;
  /**
   * The presigned S3 link AS READ AT THE TIME OF THE FETCH.
   *
   * It expires in about eleven and a half hours (X-Amz-Expires 42033/42001 seconds,
   * X-Amz-Date stamped at the read). It is carried on the record so the reader knows a
   * document HAS a file, and so a test can assert the host — but it must NOT be the
   * href on a rendered page, because that link is dead by the next morning and a dead
   * link reads as a missing document. The screen links at our own route, which re-reads
   * this endpoint at click time.
   */
  url: string;
  /** Dentally appointment ids this document was filed against. Often empty. */
  appointmentIds: string[];
}

/** Which of the two kinds a row is. See DentallyDocumentRecord.formId. */
export type DocumentKind = "form" | "upload";

/**
 * Form or upload, decided on the ONE field that carries the answer.
 *
 * NOT decided on `description`, and that is the trap worth naming. Every one of the
 * eight rows observed on this practice had `description: "NHS PR"`, so a description
 * test would have classified correctly on the sample and misclassified the first
 * scanned letter that arrived — the exact case this distinction exists for. `signed`
 * is no better: all eight were `signed: true`, and an upload could plausibly carry
 * either value.
 *
 * NO UPLOAD HAS EVER BEEN OBSERVED on this practice, so the "upload" branch is
 * genuinely untested against live. It is implemented anyway, and labelled with the
 * owner's own word, because the alternative is that the first scanned letter to appear
 * renders as a form and is described to a clinician as something the patient signed.
 */
export function documentKind(doc: DentallyDocumentRecord): DocumentKind {
  return doc.formId === null ? "upload" : "form";
}

/**
 * What the timeline prints as this document's kind.
 *
 * "Upload" is the practice owner's own word for a scanned or uploaded file and is used
 * verbatim: a screen that renames the thing the reader already has a name for makes
 * them translate. A form carries its Dentally description instead, with its signed
 * state appended — "NHS PR · signed" — because on a consent record whether it was
 * signed is the whole point of showing it.
 *
 * A form whose description Dentally left empty falls back to the word "Form" rather
 * than printing a bare " · signed" against nothing.
 */
export function documentLabel(doc: DentallyDocumentRecord): string {
  if (documentKind(doc) === "upload") return "Upload";
  const name = doc.description.trim() === "" ? "Form" : doc.description.trim();
  // Three states, not two. "not signed" is said out loud when Dentally is WAITING for
  // a signature; a document that simply never needed one says nothing at all, because
  // printing "not signed" against it would invent an outstanding action.
  if (doc.signed) return `${name} · signed`;
  if (doc.requiresSigning) return `${name} · not signed`;
  return name;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The row fields we read. Calibrated against eight live rows — see the header. */
const ROW_FIELDS = ["created_at", "description", "url", "form_id"] as const;

/**
 * Pull the row array out of one `/v1/patient_documents` page.
 *
 * An envelope without a `patient_documents` array is a shape we do not understand, and
 * the only safe reading of "I do not understand this" is a failure. An empty array is
 * NOT that: it is Dentally answering "none" — which it did for patient 56194 — and it
 * returns [].
 */
export function documentsFromEnvelope(env: unknown): unknown[] {
  const rows = (env as Record<string, unknown> | null | undefined)?.patient_documents;
  if (Array.isArray(rows)) return rows;
  const saw = Object.keys((env ?? {}) as Record<string, unknown>).join(", ") || "none";
  throw new Error(`GET /v1/patient_documents returned no 'patient_documents' array (saw keys: ${saw})`);
}

/**
 * Map raw rows to DentallyDocumentRecords, or throw if the rows are unreadable.
 *
 * Empty in, empty out — a patient who has signed nothing is an ordinary answer. Rows
 * carrying none of the calibrated field names are the uncalibrated case, and are
 * refused rather than rendered as a list of blank documents.
 */
export function toDentallyDocumentRecords(rows: unknown[]): DentallyDocumentRecord[] {
  if (rows.length > 0) {
    const readable = rows.some((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return ROW_FIELDS.some((f) => str(r[f]) !== null);
    });
    if (!readable) {
      const saw = Object.keys((rows[0] ?? {}) as Record<string, unknown>).join(", ") || "none";
      throw new Error(
        `/v1/patient_documents rows carry none of ${ROW_FIELDS.join("/")} (saw: ${saw}); ` +
          `the row shape no longer matches the 2026-08-31 calibration`,
      );
    }
  }
  return rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      description: str(r.description) ?? "",
      formId: str(r.form_id),
      // created_at is what Dentally filed it at, and it was present on all eight rows.
      // updated_at is the fallback rather than the primary: a document re-saved later
      // would otherwise jump to the top of a chronological record it did not belong at.
      at: str(r.created_at) ?? str(r.updated_at) ?? "",
      signed: r.signed === true,
      signedAt: str(r.signed_at),
      requiresSigning: r.requires_signing === true,
      url: str(r.url) ?? "",
      appointmentIds: Array.isArray(r.appointment_ids)
        ? r.appointment_ids.map((a) => String(a)).filter((a) => a !== "")
        : [],
    } satisfies DentallyDocumentRecord;
  });
}
