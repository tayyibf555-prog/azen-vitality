// ---------------------------------------------------------------------------
// Variant A ("Quiet"): the footnote apparatus, and the date range at the foot.
//
// The screen this replaces carried five caveat chips in a row across the foot,
// three of them amber, so it read as five problems before a figure had been
// read. Nothing here deletes a caveat: honesty about a figure is a correctness
// rule, not a style one. What changes is the FORM.
//
// A caveat that qualifies a figure becomes a numbered FOOTNOTE, set the way a
// financial statement sets one: a small grey superscript beside the figure, and
// the sentence in full at the foot of that figure's own panel. It is attached to
// what it concerns rather than shouted across the screen, and it carries no
// warning colour, because a warning colour on an explanation teaches people to
// ignore warning colours.
//
// A caveat that merely explains (how a period is sourced, what a balance means)
// is not attached to any one figure and becomes background: one quiet grey
// sentence at the foot of the band, which is the one line Dentally itself runs.
//
// Pure functions: no React, no clock, no I/O.
// ---------------------------------------------------------------------------

/** The minimum a caveat has to be for this file to sort it. */
export interface NoteSource {
  /** The whole sentence, verbatim. Never trimmed here. */
  text: string;
  /** True when it qualifies a figure that could not be counted in full. */
  material: boolean;
}

/** One numbered footnote. `n` is the superscript printed beside the figure. */
export interface PanelNote {
  n: number;
  text: string;
}

/**
 * Number a panel's footnotes from 1.
 *
 * Numbering restarts per panel deliberately: a panel is the unit a reader takes
 * in, and "Accounts, note 1" is easier to find than "note 7 of the screen".
 * Empty and blank-only strings are dropped rather than printed as a bare number.
 */
export function numberNotes(texts: readonly (string | null | undefined)[]): PanelNote[] {
  const out: PanelNote[] = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    out.push({ n: out.length + 1, text: trimmed });
  }
  return out;
}

export interface NoteSplit {
  /** Qualifies a figure: printed as a numbered footnote on that figure's panel. */
  attached: PanelNote[];
  /** Explains rather than qualifies: printed once, quietly, at the foot of the band. */
  background: string[];
}

/**
 * Sort one panel's caveats into the two tiers.
 *
 * Order within each tier is the order given, because the caveat builders already
 * emit them in the order the panels are read.
 */
export function splitNotes(caveats: readonly NoteSource[]): NoteSplit {
  const attached = numberNotes(caveats.filter((c) => c.material).map((c) => c.text));
  const background: string[] = [];
  for (const c of caveats) {
    if (c.material) continue;
    const trimmed = c.text.trim();
    if (trimmed.length > 0 && !background.includes(trimmed)) background.push(trimmed);
  }
  return { attached, background };
}

// --- The window at the foot -------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  year: string;
  month: number;
  day: number;
}

/**
 * Split a `YYYY-MM-DD` key without going near Date.
 *
 * Parsing a day key into a Date and formatting it back is how a London day ends
 * up printed as the day before: the parse lands on UTC midnight and any
 * formatter running behind UTC walks it backwards. The key is already the London
 * calendar day, so it is read as text.
 */
function parts(day: string): Parts | null {
  const m = DAY_KEY.exec(day);
  if (m === null) return null;
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  return { year: m[1], month, day: dayOfMonth };
}

/** "31 Jul 2026". Returns the key unchanged when it is not a day key. */
export function formatDay(day: string): string {
  const p = parts(day);
  if (p === null) return day;
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/**
 * The selected window, set the way a report header sets one.
 *
 * Repeated parts are printed once: "1 to 31 Jul 2026" rather than
 * "1 Jul 2026 to 31 Jul 2026". Shorter, and it makes the part that actually
 * varies the part the eye lands on.
 */
export function formatDayRange(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  if (a === null || b === null) return from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`;
  if (from === to) return formatDay(from);
  if (a.year === b.year && a.month === b.month) {
    return `${a.day} to ${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${MONTHS[a.month - 1]} to ${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
  }
  return `${formatDay(from)} to ${formatDay(to)}`;
}
