// ===========================================================================
// SIX-POINT ENTRY: THE SETTINGS A HYGIENIST CHANGES ONCE AND NEVER AGAIN,
// AND THE THREE PURE RULES THE ENTRY GRID IS DRIVEN BY.
//
// Dentally's own perio exam has entry settings — which arch to start with, the
// direction the chart is worked in, and whether the chart moves on by itself or
// waits for Tab (help.dentally.com, "How to create a perio exam"). A hygienist
// who has charted one way for six years does not want to relearn it, so the
// settings exist and they are theirs, not the patient's.
//
// EVERYTHING HERE IS PURE, AND THAT IS THE POINT. vitest in this repo collects
// only `src/**/*.test.ts` in a node environment and cannot test a .tsx at all,
// so anything in pocket-chart.tsx that could be wrong is untestable by
// construction. The traversal order, the scale cycling and the correction
// window are exactly the parts that can be wrong, so they live here.
//
// WHAT IS DELIBERATELY NOT HERE: the scales themselves. Dentally records
// furcation GRADES 1–4 and mobility STAGES 1–3, and those belong to the perio
// engine, which validates them. This module cycles whatever scale it is handed
// and never states its ends — a scale written down twice is a scale that can
// disagree with itself, and the disagreement would show up as a grade a
// clinician can type and the engine then refuses at save.
//
// NO CLOCK IS READ IN THIS FILE. `withinCorrectionWindow` takes both instants,
// because a module that reads Date.now() cannot be tested and, in a render
// path, is a hydration bug this repo has already paid for.
// ===========================================================================

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/** Which arch the sweep starts in. Dentally's "start with" setting. */
export type EntryArch = "upper" | "lower";

/**
 * The direction the chart is worked in, named from the CHART's point of view,
 * which is how a clinician reads it: `right-to-left` starts at the patient's
 * upper right (FDI 18) and sweeps across to the upper left, which is the order
 * the FDI arch arrays are already written in and the UK convention.
 */
export type EntryDirection = "right-to-left" | "left-to-right";

/**
 * `auto` — a recorded value moves the cursor on by itself, which is what makes
 * a 192-number chart survivable and what a voice stream needs.
 * `tab` — the value is recorded in place and the cursor waits. Digits typed
 * after it EXTEND the number rather than starting the next one, because that is
 * what "waits for Tab" has to mean if a two-digit pocket is to be typable at all.
 */
export type EntryAdvance = "auto" | "tab";

export interface ChartEntryPrefs {
  startArch: EntryArch;
  direction: EntryDirection;
  advance: EntryAdvance;
}

export const ENTRY_ARCHES: readonly EntryArch[] = ["upper", "lower"];
export const ENTRY_DIRECTIONS: readonly EntryDirection[] = ["right-to-left", "left-to-right"];
export const ENTRY_ADVANCES: readonly EntryAdvance[] = ["auto", "tab"];

/** Whole phrases, not fragments: these are read on screen next to a control. */
export const ENTRY_ARCH_LABEL: Record<EntryArch, string> = {
  upper: "upper arch first",
  lower: "lower arch first",
};

export const ENTRY_DIRECTION_LABEL: Record<EntryDirection, string> = {
  "right-to-left": "right to left",
  "left-to-right": "left to right",
};

export const ENTRY_ADVANCE_LABEL: Record<EntryAdvance, string> = {
  auto: "move on automatically",
  tab: "wait for Tab",
};

/**
 * Upper arch, right to left, moving on by itself.
 *
 * The first two are the UK convention and match the order the FDI arch arrays
 * are already written in, so a practice that never opens the settings gets the
 * order it would have drawn on paper. The third is the one that makes 192
 * numbers possible in the time an examination actually takes.
 */
export const DEFAULT_CHART_ENTRY_PREFS: ChartEntryPrefs = {
  startArch: "upper",
  direction: "right-to-left",
  advance: "auto",
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * PER CLINICIAN, not per patient.
 *
 * The chart's own display preferences are keyed by site and patient because
 * they describe a view of one mouth. These describe a pair of hands: the way
 * this hygienist charts does not change when the next patient sits down, and
 * making them re-pick it every time is how a setting stops being used.
 *
 * A null clinician gets a shared key rather than a thrown error — the entry
 * grid refuses to SAVE without a named clinician (GDC 4.1.4), but it must not
 * fall over while one is being resolved.
 */
export function chartEntryPrefsStorageKey(siteId: string, clinicianId: string | null): string {
  return `perio:chart-entry-prefs:${siteId}:${clinicianId ?? "unattributed"}`;
}

function one<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Tolerates corrupt, partial, wrongly-typed and outright hostile storage, and
 * fills from the defaults rather than throwing.
 *
 * A preference is not clinical data. Nothing here may ever be the reason a
 * hygienist cannot chart: the worst a broken stored value can do is put the
 * cursor where the defaults would have put it. Accepts the raw JSON string or
 * an already-parsed value, so the caller does not have to guess which it holds.
 */
export function parseChartEntryPrefs(raw: unknown): ChartEntryPrefs {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { ...DEFAULT_CHART_ENTRY_PREFS };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CHART_ENTRY_PREFS };
  }
  const v = value as Record<string, unknown>;
  return {
    startArch: one(v.startArch, ENTRY_ARCHES, DEFAULT_CHART_ENTRY_PREFS.startArch),
    direction: one(v.direction, ENTRY_DIRECTIONS, DEFAULT_CHART_ENTRY_PREFS.direction),
    advance: one(v.advance, ENTRY_ADVANCES, DEFAULT_CHART_ENTRY_PREFS.advance),
  };
}

export function serialiseChartEntryPrefs(prefs: ChartEntryPrefs): string {
  // Written field by field rather than passing `prefs` straight through, so a
  // caller handing over a wider object cannot smuggle keys into storage that
  // the parser will then read back as if this module had written them.
  return JSON.stringify({
    startArch: prefs.startArch,
    direction: prefs.direction,
    advance: prefs.advance,
  });
}

// ---------------------------------------------------------------------------
// The traversal order
// ---------------------------------------------------------------------------

/**
 * The order the cursor sweeps the teeth. NOT the order they are drawn.
 *
 * The grid always draws both arches in anatomical order, because a chart whose
 * columns move when a setting changes is a chart a clinician has to re-read
 * before every reading. Only the cursor's route through it changes, which is
 * what the Dentally setting actually controls.
 *
 * Both arrays are passed in already filtered to the teeth this chart draws, so
 * this function never has to know what a chartable tooth is.
 */
export function entryToothOrder(
  prefs: ChartEntryPrefs,
  upper: readonly number[],
  lower: readonly number[],
): number[] {
  const face = (arch: readonly number[]): number[] =>
    prefs.direction === "left-to-right" ? [...arch].reverse() : [...arch];
  return prefs.startArch === "lower" ? [...face(lower), ...face(upper)] : [...face(upper), ...face(lower)];
}

// ---------------------------------------------------------------------------
// Cycling a scale — the `f` and `m` keys
// ---------------------------------------------------------------------------

/**
 * Dentally: pressing the key again cycles, and pressing it past the end clears.
 *
 * The scale is an ARGUMENT and its ends are never written here. Hand it the
 * engine's furcation grades and `f` cycles 1·2·3·4·clear; hand it the mobility
 * stages and `m` cycles 1·2·3·clear. If the engine's scale changes, this
 * changes with it and nothing has to be found and edited twice.
 *
 * A `current` that is not on the scale — a stored value from an older scale, or
 * a mis-keyed one — cycles to the FIRST grade rather than to the second, or to
 * nothing. One press then always leaves a value the engine will accept.
 */
export function cycleScale<T>(scale: readonly T[], current: T | null): T | null {
  if (scale.length === 0) return null;
  if (current === null) return scale[0];
  const at = scale.indexOf(current);
  if (at < 0) return scale[0];
  return at === scale.length - 1 ? null : scale[at + 1];
}

/**
 * The ordered values of a scale, taken from the labels that name them.
 *
 * The point is that the caller cannot forget a grade. A `Record<Grade, string>`
 * literal is exhaustive-checked by the compiler, so the day the engine widens
 * furcation from three grades to four, the label map stops compiling until the
 * fourth is written — which is the only mechanism available that makes a
 * hard-coded range impossible rather than merely discouraged.
 *
 * Sorted numerically and explicitly: JavaScript happens to enumerate integer
 * keys in ascending order, but a clinical scale is not a thing to leave to a
 * property of the engine that happens to hold today.
 */
export function scaleFromLabels<T extends number>(labels: Record<T, string>): T[] {
  return Object.keys(labels)
    .map((key) => Number(key))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b) as T[];
}

// ---------------------------------------------------------------------------
// The 24-hour correction window
// ---------------------------------------------------------------------------

/**
 * Dentally lets a saved exam be edited for 24 hours.
 *
 * WE DO NOT EDIT. A correction here is a new record whose `supersedesId` names
 * the one it replaces; the original stays readable for ever, which is what GDC
 * Standard 4.1.5 means by amendments being clearly marked and dated. This
 * constant only decides when the screen offers Dentally's familiar affordance —
 * it never decides whether the record may be amended, because an append-only
 * record may always be amended, and a clinician who has spotted an error at
 * hour 25 must not be told to leave it there.
 */
export const CORRECTION_WINDOW_HOURS = 24;

const HOUR_MS = 3_600_000;

/** Milliseconds between two ISO-8601 instants, or null if either is unreadable.
 *  `Date.parse`, never `new Date()`: no clock is read anywhere in this file. */
function elapsedMs(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/**
 * Is `recordedAt` inside the correction window as at `now`?
 *
 * False for an unreadable instant and false for a record stamped in the future:
 * in both cases we cannot say the window is open, and the fallback is the
 * plainly-labelled amendment, which is never wrong — only less familiar.
 */
export function withinCorrectionWindow(
  recordedAt: string,
  now: string,
  hours: number = CORRECTION_WINDOW_HOURS,
): boolean {
  const elapsed = elapsedMs(recordedAt, now);
  if (elapsed === null) return false;
  return elapsed >= 0 && elapsed <= hours * HOUR_MS;
}

/**
 * Whole hours left in the window, for the sentence on screen. Null when the
 * window does not apply; 0 in the final hour, which reads as "less than an
 * hour left" rather than as "closed".
 */
export function hoursLeftInCorrectionWindow(
  recordedAt: string,
  now: string,
  hours: number = CORRECTION_WINDOW_HOURS,
): number | null {
  if (!withinCorrectionWindow(recordedAt, now, hours)) return null;
  const elapsed = elapsedMs(recordedAt, now);
  if (elapsed === null) return null;
  return Math.floor((hours * HOUR_MS - elapsed) / HOUR_MS);
}
