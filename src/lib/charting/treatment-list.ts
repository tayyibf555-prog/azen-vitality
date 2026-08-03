// ===========================================================================
// THE LEFT PANEL'S LIST BEHAVIOUR: filter, search, sort, favourites, and the
// 37-key alphabet rail.
//
// PURE. treatment-panel.tsx computes nothing of its own.
//
// THE RULES, and why each one:
//   - ALPHABETICAL BY NAME is the default, because the reference list is.
//   - A CODE-PREFIX MATCH RANKS ABOVE A NAME MATCH, because the code is what a
//     dentist types. Searching "121" must not put "Amalgam 121 review" above
//     the treatment whose code IS 121.
//   - THE RAIL ALWAYS RENDERS ALL 37 KEYS and a zero-count key is DISABLED. A
//     rail letter that jumps nowhere is worse than one visibly empty, and a
//     rail that changes shape as you type is not an index.
//   - FAVOURITES ARE A PERSONAL DISPLAY PREFERENCE, so this module takes the
//     set as an argument and stays pure rather than reaching for localStorage.
// ===========================================================================

import type { TreatmentRow } from "./types";

export interface TreatmentFilter {
  query?: string;
  categoryId?: string | null;
  favourites?: ReadonlySet<string>;
  favouritesOnly?: boolean;
  favouritesFirst?: boolean;
  sort?: "name" | "code";
}

/** star, 0-9, A-Z. Thirty-seven, always. */
export const ALPHABET_KEYS: readonly string[] = [
  "star",
  ..."0123456789".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
];

/** 0 = the code starts with the query, 1 = anything else matched, -1 = no match. */
function rank(row: TreatmentRow, query: string): number {
  if (query.length === 0) return 1;
  const q = query.toLowerCase();
  const code = row.code.toLowerCase();
  if (code.startsWith(q)) return 0;
  if (code.includes(q) || row.name.toLowerCase().includes(q)) return 1;
  return -1;
}

export function filterTreatments(
  rows: readonly TreatmentRow[],
  filter: TreatmentFilter,
): TreatmentRow[] {
  const query = (filter.query ?? "").trim();
  const favourites = filter.favourites ?? new Set<string>();
  const sort = filter.sort ?? "name";

  const kept = rows
    .map((row) => ({ row, score: rank(row, query) }))
    .filter(({ row, score }) => {
      if (score < 0) return false;
      // The category filter and the favourites filter COMPOSE. One overriding
      // the other is how a list quietly shows rows the user excluded.
      if (filter.categoryId && row.categoryId !== filter.categoryId) return false;
      if (filter.favouritesOnly && !favourites.has(row.id)) return false;
      return true;
    });

  kept.sort((a, b) => {
    if (filter.favouritesFirst) {
      const fa = favourites.has(a.row.id) ? 0 : 1;
      const fb = favourites.has(b.row.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    if (a.score !== b.score) return a.score - b.score;
    return sort === "code"
      ? a.row.code.localeCompare(b.row.code, "en-GB", { numeric: true })
      : a.row.name.localeCompare(b.row.name, "en-GB", { sensitivity: "base" });
  });

  return kept.map((k) => k.row);
}

/**
 * The rail key this row jumps to: the first ALPHANUMERIC character of the name,
 * so a leading bracket or a stray space does not create a phantom key.
 *
 * A name with NO alphanumeric character at all falls into "0". That is
 * arbitrary, and it is deliberately not null and not a 38th key: a null would
 * drop the row out of the grouped list entirely, and a key outside the 37 would
 * put it in a group the rail can never reach. Either way a treatment would
 * vanish from the list, which is worse than one filed oddly.
 */
export function bucketKeyOf(row: TreatmentRow): string {
  const match = /[a-z0-9]/i.exec(row.name);
  return match ? match[0].toUpperCase() : "0";
}

/**
 * WHICH TREATMENT THIS IS, for selection and for the draft key.
 *
 * NOT the code on its own, and that is a correction rather than a nicety. The
 * code is read defensively from `code`, `reference` or `abbreviation`, none of
 * which is calibrated against live, and it falls back to the empty string. With
 * an empty code, `row.code === activeCode` was true for EVERY row, so selecting
 * one treatment highlighted the entire list and a clinician could not see what
 * they were about to chart. Worse, draftKey is `${tooth}:${treatmentCode}`, so
 * every codeless treatment on a tooth collapsed into one entry.
 *
 * The id is always populated, so it is the fallback. The code is still what the
 * list PRINTS: this is identity, not decoration, and the two are kept apart.
 */
export function treatmentKey(row: TreatmentRow): string {
  return row.code.length > 0 ? row.code : row.id;
}

export interface AlphabetBucket {
  key: string;
  /** What the rail PRINTS. The favourites bucket is a star, not the word. */
  label: string;
  count: number;
}

const BUCKET_LABEL: Record<string, string> = { star: "★" };

/**
 * All 37 keys with HONEST counts, so a zero-count key can render visibly
 * disabled rather than as a live control that jumps nowhere.
 */
export function alphabetBuckets(
  rows: readonly TreatmentRow[],
  favourites: ReadonlySet<string> = new Set<string>(),
): AlphabetBucket[] {
  const counts = new Map<string, number>(ALPHABET_KEYS.map((k) => [k, 0]));
  counts.set("star", rows.filter((r) => favourites.has(r.id)).length);
  for (const row of rows) {
    const key = bucketKeyOf(row);
    if (counts.has(key)) counts.set(key, (counts.get(key) as number) + 1);
  }
  return ALPHABET_KEYS.map((key) => ({
    key,
    label: BUCKET_LABEL[key] ?? key,
    count: counts.get(key) as number,
  }));
}

export function serialiseFavourites(favourites: ReadonlySet<string>): string {
  return JSON.stringify([...favourites]);
}

/** Tolerates corrupt, absent or wrongly-shaped storage. A broken display
 *  preference must never throw on a clinical screen. */
export function parseFavourites(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set<string>();
  }
}
