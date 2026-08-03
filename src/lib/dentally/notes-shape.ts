/**
 * The shape of a Dentally clinical-notes page, as its own pure module.
 *
 * THE PATH. Notes are read from `/v1/notes`. They used to be read from
 * `/v1/patient_notes`, which DOES NOT EXIST on real Dentally: it 404s. The tab
 * therefore failed on every live patient open and sat permanently on "We could not
 * read Dentally's clinical notes just now" — a permanent condition worded as a
 * transient one, on a clinical record. It went unnoticed for as long as it did
 * because the local mock served the invented path, so dev and the whole suite were
 * green while production had never once succeeded.
 *
 * PROVENANCE — live read-only GET, 2026-08-03, api.dentally.co:
 *
 *   GET /v1/notes?patient_id=56194&page=1&per_page=5   200
 *   GET /v1/notes?page=1&per_page=1                    200
 *   -> {"notes":[],"meta":{"total":0,"current_page":1,"total_pages":0}}
 *
 * So the COLLECTION KEY is calibrated: it is `notes`. What is NOT calibrated is the
 * shape of a ROW, because there were none to look at: the endpoint reports zero
 * notes for this practice both for a named patient and across the unfiltered index.
 * (The same key read /v1/patients?per_page=1 as `{"meta":{"total":52339,"page":1}}`
 * in the same minute, so the zero is the endpoint's answer, not a dead credential —
 * and the two meta shapes differ, which is itself evidence that /v1/notes is a real
 * distinct controller rather than a canned empty.)
 *
 * That is why the row mapper below THROWS instead of returning best-effort rows.
 * `body` / `author` / `created_at` are the field names the old invented endpoint
 * used, i.e. a guess that has never been checked against a real row. If rows ever
 * do arrive and none of them carry any of those names, the honest answer is "we
 * could not read this", which is what a throw produces here — not a page of notes
 * rendered blank, and not "No clinical notes in Dentally" for a patient whose
 * allergy is sitting in a field we failed to read.
 *
 * Neither function may ever be softened to `?? []`. That single operator is what
 * turns a shape mismatch into a confident empty result: the pager stops, read
 * health stays "ok", and the record states as fact something nobody checked.
 */

/** A clinical note as the record screen consumes it. */
export interface NoteRecord {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The row fields we read. Unverified against a live row — see the header. */
const ROW_FIELDS = ["body", "author", "created_at"] as const;

/**
 * Pull the row array out of one `/v1/notes` page.
 *
 * An envelope without a `notes` array is a shape we do not understand, and the only
 * safe reading of "I do not understand this" is a failure. An empty `notes` array is
 * NOT that: it is Dentally answering "none", and it returns [].
 */
export function notesFromEnvelope(env: unknown): unknown[] {
  const rows = (env as Record<string, unknown> | null | undefined)?.notes;
  if (Array.isArray(rows)) return rows;
  const saw = Object.keys((env ?? {}) as Record<string, unknown>).join(", ") || "none";
  throw new Error(`GET /v1/notes returned no 'notes' array (saw keys: ${saw})`);
}

/**
 * Map raw rows to NoteRecords, or throw if the rows are unreadable.
 *
 * Empty in, empty out — a patient with no notes is an ordinary answer. But rows that
 * carry none of the field names we read are the uncalibrated case, and are refused.
 */
export function toNoteRecords(rows: unknown[]): NoteRecord[] {
  if (rows.length > 0) {
    const readable = rows.some((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return ROW_FIELDS.some((f) => str(r[f]) !== null);
    });
    if (!readable) {
      const saw = Object.keys((rows[0] ?? {}) as Record<string, unknown>).join(", ") || "none";
      throw new Error(
        `/v1/notes rows carry none of ${ROW_FIELDS.join("/")} (saw: ${saw}); ` +
          `the row shape has never been calibrated against a live note`,
      );
    }
  }
  return rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      body: str(r.body) ?? "",
      author: str(r.author) ?? "Team",
      createdAt: str(r.created_at) ?? "",
    };
  });
}
