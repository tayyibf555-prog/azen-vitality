/**
 * The shape of a Dentally emails page, as its own pure module.
 *
 * THIS MODULE IS DELIBERATELY THE LOOSE ONE, AND ./sms-shape AND ./documents-shape ARE
 * DELIBERATELY THE STRICT ONES. The difference is not style, it is standing.
 *
 * WHAT WE ACTUALLY KNOW, from read-only GETs on 2026-08-31:
 *
 *   GET /v1/emails                                        422 "patient_id is required"
 *   GET /v1/emails?patient_id=15                          422 "external_provider is required"
 *   GET /v1/emails?patient_id=15&external_provider=true   200  0 rows, meta.total 0
 *   GET /v1/emails?patient_id=15&external_provider=false  200  0 rows, meta.total 0
 *   ...the same for patients 40000 and 56194, in both buckets. Six 200s, zero rows.
 *
 * So the ENVELOPE is calibrated (`{emails: [], meta: {total, current_page,
 * total_pages}}`, six times over) and the ROW IS NOT. Nobody — not this probe, not the
 * one before it — has ever seen a single row from this endpoint on this practice.
 *
 * WHY THAT CHANGES THE RULE. ./sms-shape throws on a row it cannot recognise, and it is
 * right to: it has three patients' worth of real rows behind it, so an unrecognised row
 * genuinely means "the shape changed under us". Here there is no calibration to have
 * changed. Throwing on the first real email would mean the very first time this
 * practice's mail became readable, the Correspondence tab reported a failed read and
 * showed nothing — reintroducing, on that day, the exact defect this build exists to
 * remove.
 *
 * SO: TOLERATE SEVERAL SPELLINGS, AND REPORT WHAT COULD NOT BE PLACED. A row we can
 * partly read is rendered with what we could read. A row we cannot read AT ALL is still
 * COUNTED and surfaced to the screen as "Dentally holds N emails for this patient that
 * this platform could not read" — never dropped, and never rendered as a blank message.
 * That is the same posture charting-read.ts takes on Dentally's unverified `teeth` and
 * `surfaces` wire shapes, and for the same reason: reporting what you could not place
 * beats both guessing and silence.
 *
 * THE PRACTICE OWNER BELIEVES THESE EMAILS EXIST. He said every patient has "emails we
 * sent him". This endpoint cannot evidence that, in either bucket, on any patient
 * checked. Whatever holds them, it is not this route — and the tab's copy says exactly
 * that rather than implying the practice never emailed anybody.
 */

/** One email Dentally holds against a patient, as the record screen consumes it. */
export interface DentallyEmailRecord {
  id: string;
  /** The subject line, or "" when the row carried nothing we could read as one. */
  subject: string;
  /** A plain-text body where one could be found. May be "". */
  body: string;
  /** Best-effort direction. See directionOf below for why it defaults outbound. */
  direction: "inbound" | "outbound";
  /** When it was sent, as best as could be read. May be "" — see the timeline's rule. */
  at: string;
  /** Which bucket it came from: Dentally's own mail, or an external provider's. */
  externalProvider: boolean;
  /**
   * True when NONE of the fields above could be read from the row.
   *
   * The row is still returned. This flag is how the screen says "there is an email
   * here we could not read" instead of drawing an empty card, which a reader would
   * take for an empty email rather than an unread one.
   */
  unreadable: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * The first readable value among several candidate keys.
 *
 * The candidate lists below are PREDICTIONS, not observations, and are commented as
 * such wherever they are used. They are ordered most-likely-first so that a row
 * carrying two of them is read by the more specific name.
 */
function firstOf(r: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = str(r[k]);
    if (v !== null) return v;
  }
  return null;
}

// UNVERIFIED KEY PREDICTIONS. Not one of these has been seen on a live row; they are
// the spellings Dentally uses elsewhere (`body`, `created_at`, `sent_at` and
// `direction` are all real /v1/sms field names) plus the obvious mail equivalents.
// They are named here, in one place, so that the day a real row arrives the fix is a
// one-line edit against a recorded expectation rather than an archaeology exercise.
const SUBJECT_KEYS = ["subject", "title", "name"] as const;
const BODY_KEYS = ["body", "text_body", "plain_body", "content", "html_body"] as const;
const AT_KEYS = ["sent_at", "created_at", "delivered_at", "updated_at"] as const;

/**
 * Best-effort direction, defaulting to OUTBOUND.
 *
 * Outbound is the safe default here, unlike almost everywhere else on this record. A
 * practice's mail to a patient is overwhelmingly what this feed would hold, and the
 * cost of the two mistakes is asymmetric: an inbound email mislabelled "To patient"
 * is a mislabelled row a reader can see the text of and correct for, whereas guessing
 * "From patient" over something the practice sent would put words in the patient's
 * mouth on a record that may be read during a complaint.
 *
 * It matches how ./sms-shape resolves the same question, and how every other message
 * source on this platform reads its own direction column.
 */
function directionOf(r: Record<string, unknown>): "inbound" | "outbound" {
  const raw = str(r.direction) ?? str(r.kind) ?? "";
  return raw.toLowerCase() === "inbound" ? "inbound" : "outbound";
}

/**
 * Pull the row array out of one `/v1/emails` page.
 *
 * The ENVELOPE is calibrated — six live reads all returned `{emails: [...], meta}` —
 * so this half keeps the strict rule: an envelope without an `emails` array THROWS.
 * An empty `emails` array is not that; it is the answer this endpoint gave every
 * time, and it returns [].
 */
export function emailsFromEnvelope(env: unknown): unknown[] {
  const rows = (env as Record<string, unknown> | null | undefined)?.emails;
  if (Array.isArray(rows)) return rows;
  const saw = Object.keys((env ?? {}) as Record<string, unknown>).join(", ") || "none";
  throw new Error(`GET /v1/emails returned no 'emails' array (saw keys: ${saw})`);
}

/**
 * Map raw rows to DentallyEmailRecords. NEVER THROWS on a row.
 *
 * This is the one row mapper in the Dentally layer that does not refuse an
 * unrecognised shape, and the header says why at length: there is no calibration for
 * it to violate. A row it cannot read comes back with `unreadable: true` and is
 * counted on screen.
 */
export function toDentallyEmailRecords(
  rows: unknown[],
  externalProvider: boolean,
): DentallyEmailRecord[] {
  return rows.map((row, i) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const subject = firstOf(r, SUBJECT_KEYS);
    const body = firstOf(r, BODY_KEYS);
    const at = firstOf(r, AT_KEYS);
    // The id is NOT part of the readability test. A row that carries nothing but an id
    // is exactly the case this flag exists for: something is filed here, and we cannot
    // say what it was.
    const id = str(r.id) ?? (typeof r.id === "number" ? String(r.id) : null);
    return {
      // Falls back to the row's position so two unreadable rows never collide on one
      // React key and silently render as one. `unreadable:` prefixes it so the id can
      // never be mistaken for a Dentally identifier by a later reader.
      id: id ?? `unreadable:${externalProvider ? "ext" : "own"}:${i}`,
      subject: subject ?? "",
      body: body ?? "",
      direction: directionOf(r),
      at: at ?? "",
      externalProvider,
      unreadable: subject === null && body === null && at === null,
    } satisfies DentallyEmailRecord;
  });
}

/** How many of these rows carried nothing this platform could read. */
export function unreadableCount(rows: readonly DentallyEmailRecord[]): number {
  return rows.reduce((n, r) => n + (r.unreadable ? 1 : 0), 0);
}
