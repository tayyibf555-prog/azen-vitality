// ---------------------------------------------------------------------------
// The pure rules behind the co-pilot's LEAD SIGHT tools.
//
// No I/O, no clock of its own, no imports that reach a database: every function
// here is given its inputs (including `now`) and returns a value. That is what
// makes the rules below assertable one at a time — the tools in tools.ts are a
// thin shell of "read, apply these, answer".
//
// Three families:
//   1. THE WINDOW. "Who filled the assessment today?" is a question about the
//      practice's calendar day in London, not about the last 24 hours, and not
//      about UTC. Getting that wrong does not error — it quietly answers a
//      different question and reads as fact.
//   2. THE STAGES. Which leads count as OPEN, and which ones a nudge refuses.
//   3. THE READ-BACKS. Attempt state and waiting time, derived rather than
//      guessed, so an owner is never told "we've tried twice" by a tool that
//      only counted rows it happened to be handed in order.
// ---------------------------------------------------------------------------

import { londonDayKey } from "@/lib/time/london";
import type { LeadStage } from "@/lib/types";
import type { AssessmentBand } from "@/lib/smile-assessment/scoring";
import type { SpeedToLeadAttempt, SpeedToLeadLead } from "@/lib/speed-to-lead/types";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// 1. The window.
// ---------------------------------------------------------------------------

export interface DaysBound {
  /** Used when the caller said nothing. */
  def: number;
  /** The ceiling on one request. */
  max: number;
}

/** Whether the model actually supplied a value for an optional argument. */
export function wasSupplied(raw: unknown): boolean {
  return raw !== undefined && raw !== null && raw !== "";
}

export type ParsedDays = { ok: true; days: number } | { ok: false; error: string };
export type ParsedLimit = { ok: true; limit: number } | { ok: false; error: string };

/**
 * A whole number from the model, defaulted when absent and REFUSED when out of
 * range.
 *
 * BOUNDED ABOVE AS WELL AS BELOW, and for the reason the drop-off route spells
 * out: `Number.isInteger(1e20)` is true, so a lower bound alone lets an absurd
 * value through to a query that then does far more work than anyone asked for.
 *
 * An absent value is the DEFAULT, not an error. An out-of-range value is an
 * ERROR, not a clamp: silently turning `days: 4000` into 90 would have the model
 * tell an owner it looked at eleven years when it looked at three months.
 */
function parseBounded(raw: unknown, def: number, max: number, label: string): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: def };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { ok: false, error: `${label} must be a whole number between 1 and ${max}.` };
  }
  return { ok: true, value: n };
}

/** Validate a `days` argument from the model. */
export function parseWindowDays(raw: unknown, bound: DaysBound): ParsedDays {
  const r = parseBounded(raw, bound.def, bound.max, "days");
  return r.ok ? { ok: true, days: r.value } : r;
}

/** Validate a `limit` argument from the model. */
export function parseLimit(raw: unknown, bound: DaysBound): ParsedLimit {
  const r = parseBounded(raw, bound.def, bound.max, "limit");
  return r.ok ? { ok: true, limit: r.value } : r;
}

export interface DayWindow {
  /**
   * The London calendar days the answer covers, NEWEST FIRST: `keys[0]` is today.
   * `days: 1` is today alone, which is what "who filled it in today" means.
   */
  keys: string[];
  /** Set form of `keys`, for the row filter. */
  keySet: Set<string>;
  /** The instant to ask the database for. A SUPERSET of the window; see below. */
  sinceIso: string;
}

/**
 * The London calendar days a `days`-long window covers, and the UTC instant a
 * query must start at to be sure of holding all of them.
 *
 * THE DAY KEYS ARE WALKED IN UTC DATE ARITHMETIC, NOT BY SUBTRACTING 24 HOURS
 * FROM `now`. Both look identical for 363 days a year. On the two days the
 * clocks change, a real day is 23 or 25 hours long, so stepping back by 86.4M ms
 * from a time near midnight lands on the wrong side of the boundary: a key is
 * repeated and another is skipped entirely — silently dropping a day of
 * enquiries out of "the last week". Stepping the *date string* (parsed at UTC
 * midnight, where no DST exists) is exact for every day of the year.
 *
 * THE QUERY WINDOW CARRIES A DAY OF SLACK, and it is not defensive padding. The
 * oldest day key's UTC midnight is 01:00 London during BST, so asking the
 * database from that instant would silently exclude anything submitted in the
 * first hour of that London day — including, in summer, "today" between 00:00
 * and 01:00. A whole extra day is cheap, always sufficient (no zone is more than
 * 24 hours from UTC), and the rows it over-fetches are then filtered by
 * `inDayWindow`, which is the authority on what is in the window.
 */
export function londonDayWindow(now: Date, days: number): DayWindow {
  const keys: string[] = [];
  let cursor = Date.parse(`${londonDayKey(now)}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
    cursor -= DAY_MS;
  }
  const oldest = keys[keys.length - 1];
  const sinceIso = new Date(Date.parse(`${oldest}T00:00:00Z`) - DAY_MS).toISOString();
  return { keys, keySet: new Set(keys), sinceIso };
}

/** Whether an ISO instant falls on one of the window's London days. */
export function inDayWindow(iso: string | null | undefined, window: DayWindow): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return window.keySet.has(londonDayKey(d));
}

/**
 * How many of `rows` fall on each London day of the window, newest day first.
 *
 * Every day of the window is present, INCLUDING the ones with nothing on them: a
 * quiet day is an answer ("nobody came in yesterday"), and omitting it would let
 * the model read the gap as missing data rather than as zero.
 */
export function countByLondonDay<T>(
  rows: readonly T[],
  createdAt: (row: T) => string,
  window: DayWindow,
): Array<{ day: string; count: number }> {
  const tally = new Map<string, number>(window.keys.map((k) => [k, 0]));
  for (const row of rows) {
    const iso = createdAt(row);
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const key = londonDayKey(d);
    if (tally.has(key)) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return window.keys.map((day) => ({ day, count: tally.get(day) ?? 0 }));
}

/**
 * Whether a bounded read came back exactly at its limit, i.e. there may be more.
 *
 * CONSERVATIVE AT THE BOUNDARY, the same way readStepEvents is: a result holding
 * precisely `limit` rows reports truncated, because nothing here can tell that
 * case apart from a genuinely longer list. "There may be more" is the safe
 * direction to be wrong in; the opposite hands an owner a partial list as a
 * complete one, which is how "nobody else enquired today" gets said out loud
 * about a day that had fifty more.
 */
export function looksTruncated(rowCount: number, limit: number): boolean {
  return rowCount >= limit;
}

// ---------------------------------------------------------------------------
// 2. The stages.
// ---------------------------------------------------------------------------

/**
 * The stages that mean "this enquiry is still live".
 *
 * DELIBERATELY THE SAME FOUR `findOpenLeadByAddress` USES (speed-to-lead's
 * repository) rather than a second opinion written here: the dedupe's definition
 * of an open lead is the one the pipeline already acts on, and a co-pilot that
 * called a fifth stage "open" would describe a worklist the practice does not
 * have. `nurture_done` is excluded — the cadence finished — which is why the
 * "all" filter exists.
 */
export const OPEN_LEAD_STAGES: LeadStage[] = ["new", "contacting", "contacted", "qualifying"];

/**
 * The stages a nudge refuses, and the wording it refuses with.
 *
 * MIRRORS /api/speed-to-lead/[action] resend EXACTLY — the same two stages, for
 * the same reason. That is the point: the co-pilot and the button in the Leads
 * worklist must not be able to disagree about whether a given lead can be
 * re-contacted, so the co-pilot inherits the route's policy rather than inventing
 * a stricter or looser one of its own. A booked patient must never be re-sent a
 * "we just got your enquiry" text, and a lost lead was retired for a reason
 * (no consent, opted out, undeliverable) that re-sending cannot fix.
 */
export const NUDGE_REFUSED_STAGES: LeadStage[] = ["booked", "lost"];

/** The refusal sentence for a lead that cannot be nudged, or null if it can. */
export function nudgeRefusal(stage: LeadStage): string | null {
  if (!NUDGE_REFUSED_STAGES.includes(stage)) return null;
  return stage === "booked"
    ? "That lead is already booked in, so I have not messaged them again."
    : "That lead was closed as lost (no consent, opted out, or the number could not receive a message), so re-sending would not reach them.";
}

// ---------------------------------------------------------------------------
// 3. The read-backs.
// ---------------------------------------------------------------------------

export interface AttemptSummary {
  /** Every recorded first-contact attempt for this lead. */
  total: number;
  /** How many of them failed to send. */
  failed: number;
  /** The NEWEST attempt's status, or null when there has never been one. */
  lastStatus: "sent" | "failed" | null;
  /** The newest attempt's timestamp, or null. */
  lastAt: string | null;
  /** The newest attempt's channel, or null. */
  lastChannel: string | null;
}

/**
 * Reduce a lead's contact attempts to what an owner needs to decide whether to
 * nudge: how many times we tried, how many of those failed, and what happened
 * last.
 *
 * "LAST" IS THE NEWEST BY TIMESTAMP, NOT THE LAST ELEMENT OF THE ARRAY. The
 * per-lead read happens to return ascending order today, but the batched read
 * that feeds the worklist tool returns one flat result for many leads, and a
 * function that trusted array order would report whichever attempt the database
 * happened to hand back last. Telling an owner "the last one failed" when it
 * succeeded (or the reverse) is the whole value of this summary, inverted.
 *
 * Never mutates `attempts`.
 */
export function summariseAttempts(attempts: readonly SpeedToLeadAttempt[]): AttemptSummary {
  let failed = 0;
  let newest: SpeedToLeadAttempt | null = null;
  for (const a of attempts) {
    if (a.status === "failed") failed += 1;
    if (!newest || a.createdAt > newest.createdAt) newest = a;
  }
  return {
    total: attempts.length,
    failed,
    lastStatus: newest ? newest.status : null,
    lastAt: newest ? newest.createdAt : null,
    lastChannel: newest ? newest.channel : null,
  };
}

/**
 * How long a lead has been waiting for first contact, in whole minutes, or null
 * once they have had it.
 *
 * CLAMPED AT ZERO. A row created a second in the future by clock skew between
 * the database and this process must read as "just now", never as a negative
 * wait that sorts to the top of the urgent list.
 */
export function waitingMinutes(lead: SpeedToLeadLead, now: Date): number | null {
  if (lead.firstResponseAt) return null;
  const created = new Date(lead.createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.round((now.getTime() - created) / 60_000));
}

/** The bands a `band` argument selects, or null for "every band". */
export type ParsedBands =
  | { ok: true; bands: AssessmentBand[] | null }
  | { ok: false; error: string };

const BANDS: readonly AssessmentBand[] = ["high", "medium", "low"];

/**
 * Validate a `band` argument.
 *
 * An unrecognised band is an ERROR, never a silent fall-back to "all bands": a
 * model that asked for `band: "hot"` and was handed every enquiry would report
 * the low scorers as high-intent, which is worse than no answer.
 */
export function parseBand(raw: unknown): ParsedBands {
  if (raw === undefined || raw === null || raw === "") return { ok: true, bands: null };
  const v = String(raw).trim().toLowerCase();
  const match = BANDS.find((b) => b === v);
  if (!match) {
    return { ok: false, error: `I did not recognise the band "${String(raw)}". Use high, medium or low, or leave it out for all of them.` };
  }
  return { ok: true, bands: [match] };
}
