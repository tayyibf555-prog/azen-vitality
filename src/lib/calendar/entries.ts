// ===========================================================================
// BREAKS AND NOTES ON THE DIARY.
//
// THESE ARE OUR RECORDS, NOT DENTALLY'S. Dentally exposes no endpoint for
// breaks, blocked time or diary notes: there is no such method on DentallyClient
// and no such route on the mock. They live in public.diary_entry (migration
// 0063). Nothing here mirrors Dentally and nothing here should ever be described
// as coming from it.
//
// A break or a note must be IMPOSSIBLE to mistake for a patient appointment. Two
// of the five differences are structural rather than decorative and one of them
// lives here: the accessible sentence LEADS with the kind, so a screen reader
// cannot take a break for a booking either. (The others are the separate DOM
// list, the never-type-coloured surface, the icon in place of a state glyph, and
// the italic muted text.)
// ===========================================================================

export type DiaryEntryKind = "break" | "note";

export interface DiaryEntryRecord {
  id: string;
  clientId: string;
  siteId: string;
  /** null = the whole site: it applies to every clinician column that day. */
  practitionerId: string | null;
  /** 'YYYY-MM-DD', the Europe/London day. */
  day: string;
  startMin: number;
  endMin: number;
  kind: DiaryEntryKind;
  title: string;
  body: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export const ENTRY_TITLE_MAX = 80;
export const ENTRY_BODY_MAX = 500;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Does this entry apply to this column? A site-wide entry applies to all of them. */
export function entryAppliesTo(
  entry: Pick<DiaryEntryRecord, "practitionerId">,
  practitionerId: string | null,
): boolean {
  if (entry.practitionerId === null) return true;
  return entry.practitionerId === practitionerId;
}

function hhmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The sentence assistive tech reads.
 *
 * It LEADS with the kind ("Break." / "Note.") and never carries a patient name,
 * so it can never be heard as an appointment:
 *   "Break. 13:00 to 14:00, 60 minutes. Lunch. Femi Osei."
 */
export function entrySentence(
  entry: Pick<DiaryEntryRecord, "kind" | "startMin" | "endMin" | "title" | "body">,
  clinicianName: string | null,
): string {
  const kind = entry.kind === "break" ? "Break" : "Note";
  const minutes = Math.max(0, entry.endMin - entry.startMin);
  const parts = [
    `${kind}.`,
    `${hhmm(entry.startMin)} to ${hhmm(entry.endMin)}, ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  ];
  const title = entry.title.trim();
  if (title !== "") parts.push(`${title}.`);
  const body = (entry.body ?? "").trim();
  if (body !== "") parts.push(`${body}.`);
  if (clinicianName && clinicianName.trim() !== "") parts.push(`${clinicianName.trim()}.`);
  return parts.join(" ");
}

/**
 * The entries that OCCUPY a column's time, for the drop validator.
 *
 * A BREAK occupies: dropping a patient onto lunch is exactly the class of error
 * this feature exists to prevent. A NOTE does not: it is a label on the day, not
 * a claim on the clinician.
 *
 * A break does NOT, however, turn white time grey. Grey means off, and a
 * clinician on lunch is not off.
 */
export function occupyingEntries(
  entries: readonly DiaryEntryRecord[],
  practitionerId: string | null,
): DiaryEntryRecord[] {
  return entries.filter((e) => e.kind === "break" && entryAppliesTo(e, practitionerId));
}

/** Every entry drawn in a column, breaks and notes alike. */
export function entriesForColumn(
  entries: readonly DiaryEntryRecord[],
  practitionerId: string | null,
  dayKey: string,
): DiaryEntryRecord[] {
  return entries.filter((e) => e.day === dayKey && entryAppliesTo(e, practitionerId));
}

export interface EntryInput {
  kind: unknown;
  title: unknown;
  body?: unknown;
  day: unknown;
  startMin: unknown;
  endMin: unknown;
  practitionerId?: unknown;
}

export interface ValidatedEntry {
  kind: DiaryEntryKind;
  title: string;
  body: string | null;
  day: string;
  startMin: number;
  endMin: number;
  practitionerId: string | null;
}

export type EntryValidation =
  | { ok: true; value: ValidatedEntry }
  | { ok: false; error: string };

/**
 * Validate a break or note before it reaches the database.
 *
 * Minutes must be multiples of five because the whole grid is a five minute
 * grid: an entry starting at 13:02 would draw between two rules and read as a
 * rendering fault rather than as a fact.
 */
export function validateEntryInput(input: EntryInput): EntryValidation {
  const kind = input.kind;
  if (kind !== "break" && kind !== "note") {
    return { ok: false, error: "Choose whether this is a break or a note." };
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "") return { ok: false, error: "Give this a title." };
  if (title.length > ENTRY_TITLE_MAX) {
    return { ok: false, error: `Keep the title to ${ENTRY_TITLE_MAX} characters or fewer.` };
  }

  const bodyRaw = typeof input.body === "string" ? input.body.trim() : "";
  if (bodyRaw.length > ENTRY_BODY_MAX) {
    return { ok: false, error: `Keep the note to ${ENTRY_BODY_MAX} characters or fewer.` };
  }

  const day = typeof input.day === "string" ? input.day.trim() : "";
  if (!DAY_KEY_RE.test(day)) return { ok: false, error: "That is not a valid date." };

  const startMin = typeof input.startMin === "number" ? input.startMin : Number(input.startMin);
  const endMin = typeof input.endMin === "number" ? input.endMin : Number(input.endMin);
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) {
    return { ok: false, error: "Give a start and an end time." };
  }
  if (startMin % 5 !== 0 || endMin % 5 !== 0) {
    return { ok: false, error: "Times must be on a five minute mark." };
  }
  if (startMin < 0 || endMin > 1440 || endMin <= startMin) {
    return { ok: false, error: "The end time must be after the start time, within the same day." };
  }

  const practitionerRaw = input.practitionerId;
  const practitionerId =
    typeof practitionerRaw === "string" && practitionerRaw.trim() !== ""
      ? practitionerRaw.trim()
      : null;

  return {
    ok: true,
    value: { kind, title, body: bodyRaw === "" ? null : bodyRaw, day, startMin, endMin, practitionerId },
  };
}
