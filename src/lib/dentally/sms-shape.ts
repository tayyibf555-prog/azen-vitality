/**
 * The shape of a Dentally SMS page, as its own pure module.
 *
 * WHAT THIS ENDPOINT IS. `/v1/sms` is Dentally's own SMS log — the feed behind the
 * Correspondence tab inside Dentally itself. It is UNDOCUMENTED: it appears nowhere
 * in developer.dentally.co's resource list and nowhere in the changelog. It is
 * nonetheless real and readable, gated by an undocumented `correspondence` umbrella
 * scope that the practice's key already carries (see the memory
 * `dentally-readonly-key-is-not-readonly` for the scope header).
 *
 * PROVENANCE — read-only GET, api.dentally.co, recorded 2026-08-21 by the probe that
 * preceded this build:
 *
 *   GET /v1/sms?patient_id=56194&per_page=25   200, 9 rows
 *   GET /v1/sms?patient_id=40000&per_page=25   200, 19 rows
 *   GET /v1/sms?patient_id=30000&per_page=25   200, 18 rows
 *
 * Row keys observed: id, archived, body, created_at, direction, from, read, read_at,
 * sent_at, to, user_id, message_type. `direction` is inbound|outbound. `patient_id`
 * is MANDATORY — there is no practice-wide index — and there is no SMS webhook, so
 * there is no push path either: this is a per-patient poll or nothing.
 *
 * WHY THE GUARDS ARE THE SAME AS ./notes-shape's. The collection key `sms` and the
 * row keys above come from ONE recorded session, on one machine, against an endpoint
 * whose vendor has never acknowledged it. That is exactly the standing this repo's
 * clinical-notes read had when it was pointed at `/v1/patient_notes`, an endpoint
 * that turned out not to exist at all, and the reason nobody noticed for months was
 * a mock serving the invented path while every live call 404'd.
 *
 * So: an envelope this code does not recognise THROWS, and rows carrying none of the
 * expected field names THROW. Neither may ever be softened to `?? []`. That single
 * operator is what turns a shape mismatch into a confident empty result — the pager
 * stops, read health stays "ok", and the Correspondence tab states in writing that
 * Dentally holds no messages for a patient nobody checked.
 *
 * A THROW HERE IS SAFE BY DESIGN. The caller catches it into a failed-read notice on
 * the tab ("Dentally's own SMS history could not be read"), which is true whether the
 * cause is a shape change, a revoked scope or the endpoint being withdrawn.
 */

/** One Dentally-sent or Dentally-received SMS, as the record screen consumes it. */
export interface DentallySmsRecord {
  id: string;
  body: string;
  direction: "inbound" | "outbound";
  /** When it left (or arrived). Falls back to created_at when sent_at is absent. */
  at: string;
  /** The destination/origin as Dentally recorded it. May be empty. */
  address: string;
  /**
   * Dentally's own classification, verbatim and UNINTERPRETED — e.g.
   * `pms_appointment_reminder`, `recall`, `portal_patient_2fa`,
   * `twilio_error_response`, or null. Shown as provenance, never branched on: the
   * vocabulary is undocumented and a value we have not seen must not change
   * behaviour.
   */
  messageType: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The row fields we read. Calibrated against three live patients — see the header. */
const ROW_FIELDS = ["body", "created_at", "direction", "sent_at"] as const;

/**
 * Pull the row array out of one `/v1/sms` page.
 *
 * An envelope without an `sms` array is a shape we do not understand, and the only
 * safe reading of "I do not understand this" is a failure. An empty `sms` array is
 * NOT that: it is Dentally answering "none", and it returns [].
 */
export function smsFromEnvelope(env: unknown): unknown[] {
  const rows = (env as Record<string, unknown> | null | undefined)?.sms;
  if (Array.isArray(rows)) return rows;
  const saw = Object.keys((env ?? {}) as Record<string, unknown>).join(", ") || "none";
  throw new Error(`GET /v1/sms returned no 'sms' array (saw keys: ${saw})`);
}

/**
 * Map raw rows to DentallySmsRecords, or throw if the rows are unreadable.
 *
 * Empty in, empty out — a patient Dentally has never texted is an ordinary answer.
 * Rows that carry none of the calibrated field names are the uncalibrated case, and
 * are refused rather than rendered as a list of blank messages.
 */
export function toDentallySmsRecords(rows: unknown[]): DentallySmsRecord[] {
  if (rows.length > 0) {
    const readable = rows.some((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return ROW_FIELDS.some((f) => str(r[f]) !== null);
    });
    if (!readable) {
      const saw = Object.keys((rows[0] ?? {}) as Record<string, unknown>).join(", ") || "none";
      throw new Error(
        `/v1/sms rows carry none of ${ROW_FIELDS.join("/")} (saw: ${saw}); ` +
          `the row shape no longer matches the 2026-08-21 calibration`,
      );
    }
  }
  return rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    // Anything that is not explicitly "inbound" is treated as outbound, matching how
    // every other message source on this platform reads its own direction column.
    const direction = str(r.direction) === "inbound" ? "inbound" : "outbound";
    return {
      id: String(r.id ?? ""),
      body: str(r.body) ?? "",
      direction,
      at: str(r.sent_at) ?? str(r.created_at) ?? "",
      address: (direction === "inbound" ? str(r.from) : str(r.to)) ?? "",
      messageType: str(r.message_type),
    } satisfies DentallySmsRecord;
  });
}
