import { absenceBlocksShift, addDayKey, groupAbsencesByStaff } from "@/lib/absence/rules";
import type { Absence } from "@/lib/absence/types";
import { isLiveShift, type RotaShift } from "./types";

// ---------------------------------------------------------------------------
// Publishing a week, and telling the truth about what changed since last time.
//
// PUBLISHING IS THE MOMENT THE PRACTICE MAKES A PROMISE. Until then the rota is a
// draft that the generator is free to rewrite; afterwards, people have arranged
// childcare around it. So the record we keep is not "version 3 exists" but exactly
// which shifts version 3 contained, because the question a disagreement turns on is
// "what was I told", and only the rows answer that.
//
// Everything here is pure: no database, no clock, no React. The snapshot is a plain
// serialisable object, which is what makes it storable as jsonb AND comparable in a
// test at a fixed date.
// ---------------------------------------------------------------------------

/**
 * One shift, as it was published.
 *
 * A DELIBERATELY NARROW SHAPE. It carries what a staff member was told (when, where,
 * as what, with whom) and nothing else. Statuses, timestamps and origins are
 * excluded on purpose: a snapshot that included `notifiedAt` would differ from the
 * previous one the instant somebody was texted, and every publish would report
 * changes that are not changes.
 */
export interface PublishedShift {
  id: string;
  staffId: string;
  siteId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  role: string;
  pairedStaffId: string | null;
  note: string | null;
}

/** The immutable record of one publication. Stored verbatim as `rota_publication.snapshot`. */
export interface PublicationSnapshot {
  /** Monday of the published week, `YYYY-MM-DD`. */
  weekStart: string;
  /** The site published, or null for every site at once. */
  siteId: string | null;
  version: number;
  shifts: PublishedShift[];
}

/** Stable order: day, then time, then site, then person. Independent of load order. */
function comparePublished(a: PublishedShift, b: PublishedShift): number {
  return (
    a.shiftDate.localeCompare(b.shiftDate) ||
    a.startTime.localeCompare(b.startTime) ||
    a.siteId.localeCompare(b.siteId) ||
    a.staffId.localeCompare(b.staffId)
  );
}

/** The six days Mon..Sat of a week, plus the Sunday, as an inclusive date range. */
export function weekRange(weekStart: string): { from: string; to: string } {
  return { from: weekStart, to: addDayKey(weekStart, 6) };
}

/**
 * The next version number for a week.
 *
 * Versions start at 1 and only ever go up. Derived from the max rather than the
 * count, so a deleted publication row (which should never happen, but rows do get
 * deleted) can never cause a version number to be reused and two different rotas to
 * both call themselves v3.
 */
export function nextVersion(existing: { version: number }[]): number {
  let max = 0;
  for (const p of existing) if (Number.isFinite(p.version) && p.version > max) max = Math.trunc(p.version);
  return max + 1;
}

/**
 * Build the snapshot for a publication.
 *
 * Only LIVE shifts inside the week are included, and only for the named site when
 * one is given. A cancelled or tombstoned shift is by definition not something
 * anybody is being told to work.
 */
export function buildPublication(
  shifts: RotaShift[],
  weekStart: string,
  version: number,
  siteId: string | null = null,
): PublicationSnapshot {
  const { from, to } = weekRange(weekStart);
  const included = shifts
    .filter(
      (s) =>
        s.id !== undefined &&
        isLiveShift(s) &&
        s.shiftDate >= from &&
        s.shiftDate <= to &&
        (siteId === null || s.siteId === siteId),
    )
    .map<PublishedShift>((s) => ({
      id: s.id!,
      staffId: s.staffId,
      siteId: s.siteId,
      shiftDate: s.shiftDate,
      startTime: s.startTime,
      endTime: s.endTime,
      role: s.role,
      pairedStaffId: s.pairedStaffId ?? null,
      note: s.note ?? null,
    }))
    .sort(comparePublished);

  return { weekStart, siteId, version, shifts: included };
}

/** A shift that exists in both versions but is not the same shift any more. */
export interface ChangedShift {
  before: PublishedShift;
  after: PublishedShift;
  /** Exactly which fields moved, so the copy can say "moved to Thursday" not "changed". */
  fields: (keyof PublishedShift)[];
}

export interface PublicationDiff {
  added: PublishedShift[];
  removed: PublishedShift[];
  changed: ChangedShift[];
  unchanged: number;
  /** added + removed + changed. The number a manager is shown before publishing. */
  changeCount: number;
}

/** The fields whose change means a staff member was told something different. */
const COMPARED_FIELDS: (keyof PublishedShift)[] = [
  "staffId",
  "siteId",
  "shiftDate",
  "startTime",
  "endTime",
  "role",
  "pairedStaffId",
  "note",
];

/**
 * What changed between what was published and what the rota says now.
 *
 * Matched by shift id, not by slot: a shift MOVED from Tuesday to Thursday is one
 * shift that changed, and reporting it as a deletion plus an addition would tell the
 * manager two things happened when one did. Ids survive a move because a move is an
 * update, which is exactly why DELETE writes a tombstone rather than dropping a row.
 */
export function diffAgainstPublished(
  current: RotaShift[],
  snapshot: PublicationSnapshot,
): PublicationDiff {
  const now = buildPublication(current, snapshot.weekStart, snapshot.version, snapshot.siteId);
  const before = new Map(snapshot.shifts.map((s) => [s.id, s]));
  const after = new Map(now.shifts.map((s) => [s.id, s]));

  const added: PublishedShift[] = [];
  const removed: PublishedShift[] = [];
  const changed: ChangedShift[] = [];
  let unchanged = 0;

  for (const [id, shift] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(shift);
      continue;
    }
    const fields = COMPARED_FIELDS.filter((f) => prior[f] !== shift[f]);
    if (fields.length === 0) unchanged += 1;
    else changed.push({ before: prior, after: shift, fields });
  }
  for (const [id, shift] of before) if (!after.has(id)) removed.push(shift);

  added.sort(comparePublished);
  removed.sort(comparePublished);
  changed.sort((a, b) => comparePublished(a.after, b.after));

  return { added, removed, changed, unchanged, changeCount: added.length + removed.length + changed.length };
}

/** A published shift that clashes with agreed time off. */
export interface AbsenceConflict {
  shiftId: string;
  staffId: string;
  shiftDate: string;
}

/** Everything the confirm step shows before anybody is texted. */
export interface PrePublishSummary {
  /** The version this publish would create. */
  version: number;
  /** True when this week has never been published, so there is nothing to diff. */
  firstPublish: boolean;
  /** How many shifts would be published. */
  shiftCount: number;
  /** How many differ from the last published version. Zero on a re-publish of nothing. */
  changeCount: number;
  diff: PublicationDiff | null;
  /** Shifts rostered on somebody's agreed time off. Not a blocker; a thing to see. */
  conflicts: AbsenceConflict[];
  /** How many distinct people would be told something. */
  staffCount: number;
}

/**
 * Everything a manager should see before pressing Publish.
 *
 * Computed HERE, once, under test, rather than as four `.filter()` calls inside a
 * React component. What this returns decides whether somebody presses a button that
 * texts real phones, so it is a rule, not layout.
 */
export function summarisePrePublish(input: {
  shifts: RotaShift[];
  weekStart: string;
  siteId?: string | null;
  /** The most recent published snapshot for this week and site, if any. */
  previous: PublicationSnapshot | null;
  /** Every publication already recorded for this week and site. */
  existingVersions: { version: number }[];
  absences: Absence[];
}): PrePublishSummary {
  const siteId = input.siteId ?? null;
  const version = nextVersion(input.existingVersions);
  const candidate = buildPublication(input.shifts, input.weekStart, version, siteId);

  const diff = input.previous ? diffAgainstPublished(input.shifts, input.previous) : null;
  const absencesByStaff = groupAbsencesByStaff(input.absences);
  const conflicts: AbsenceConflict[] = candidate.shifts
    .filter((s) =>
      absenceBlocksShift(
        { staffId: s.staffId, shiftDate: s.shiftDate },
        absencesByStaff.get(s.staffId) ?? [],
      ),
    )
    .map((s) => ({ shiftId: s.id, staffId: s.staffId, shiftDate: s.shiftDate }));

  return {
    version,
    firstPublish: input.previous === null,
    shiftCount: candidate.shifts.length,
    // A first publish is 100% new by definition; calling that "0 changes" would read
    // as "nothing to send" on the one press that sends the most.
    changeCount: diff ? diff.changeCount : candidate.shifts.length,
    diff,
    conflicts,
    staffCount: new Set(candidate.shifts.map((s) => s.staffId)).size,
  };
}
