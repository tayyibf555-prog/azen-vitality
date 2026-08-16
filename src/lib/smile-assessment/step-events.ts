// STEP DROP-OFF: what a public caller is allowed to say about a funnel step, and
// what a pile of those rows means once it is said.
//
// PURE. No React, no server imports, no I/O — the flow.ts / palette.ts boundary,
// and here it is load-bearing rather than tidy: the browser-side beacon
// (step-beacon.ts) validates with the SAME functions the public endpoint validates
// with, so the two cannot drift into a state where the client sends something the
// server silently drops. One import of `serviceClient` in this module would put a
// service-role client in the public quiz's bundle graph. step-events.test.ts pins
// that by reading this file's own import list.
//
// NO PII, AND THE SHAPE IS THE GUARANTEE. funnel_event (0042) carries a jsonb
// `meta` bag whose safety rests on a sanitiser function. There is no bag here: the
// batch is four closed fields — two small integers, an opaque nonce and an array of
// ordinals — and `parseStepEventBatch` CONSTRUCTS its result rather than spreading
// the caller's object, so an unknown key cannot survive the parse even by accident.
// The nonce is the only caller-chosen string that reaches the table, which is why
// its charset is closed: an email address, a name or a phone number is not a nonce.
//
// THE NONCE IS NOT A USER ID. The browser mints it per session and forgets it. It
// exists so a session that re-renders step 3 four times counts as ONE view of step
// 3 — the difference between a drop-off funnel and a render counter — and for
// nothing else.

/**
 * The highest ordinal a funnel step may have, 0-based, so 64 screens.
 *
 * Bounded because an unauthenticated caller chooses this number and it becomes a
 * bucket in the aggregation and a bar on a chart. The real ceiling is much lower
 * (flow-validate's rules cap a sane funnel long before this), so this is not the
 * funnel's rule — it is the ANONYMOUS INPUT's rule, and it belongs at the door.
 */
export const MAX_STEP_INDEX = 63;

/**
 * The highest flow_version a caller may claim. flow_version is monotonic and
 * bumped once per save (0078), so a million saves of one funnel is already absurd;
 * the point is only that the int column cannot be handed 2^53.
 */
export const MAX_FLOW_VERSION = 1_000_000;

/**
 * Steps accepted from ONE post. A post is one multi-row insert, so this is the
 * only thing standing between a single request and an arbitrary number of rows.
 * Comfortably above MAX_STEP_INDEX for a normal funnel's whole session in one
 * flush, and small enough that the daily request budget times this number is a
 * row ceiling somebody can reason about.
 */
export const MAX_EVENTS_PER_BATCH = 24;

/** Short enough to collide is not a session id. */
export const NONCE_MIN_LENGTH = 8;
/** Long enough to be a payload is not a nonce. */
export const NONCE_MAX_LENGTH = 64;

/**
 * The closed charset: URL-safe base64 plus the hyphen, which is exactly what
 * `crypto.randomUUID()` and the beacon's fallback produce. No spaces, no dots, no
 * `@`, no punctuation, nothing outside ASCII — so the field cannot hold an email
 * address, a name, a phone number or a sentence.
 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A whole number in [0, max]. The one numeric shape every field here wants. */
function isOrdinal(v: unknown, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

export function isValidStepIndex(v: unknown): v is number {
  return isOrdinal(v, MAX_STEP_INDEX);
}

export function isValidFlowVersion(v: unknown): v is number {
  // 0 is valid and must be: a campaign that has never had a funnel saved carries
  // flow_version 0 (0078), and refusing it would drop every event from the very
  // campaigns most likely to be measured first.
  return isOrdinal(v, MAX_FLOW_VERSION);
}

export function isValidNonce(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= NONCE_MIN_LENGTH &&
    v.length <= NONCE_MAX_LENGTH &&
    NONCE_PATTERN.test(v)
  );
}

/** One session's worth of step views, validated and ready to persist. */
export interface StepEventBatch {
  flowVersion: number;
  nonce: string;
  /** Ascending, de-duplicated, bounded to MAX_EVENTS_PER_BATCH. */
  steps: number[];
}

/**
 * Read a posted body as a batch, or refuse it. null means "nothing usable here",
 * and the caller's contract is to drop it silently — this is telemetry, and a
 * malformed beacon must never become an error a patient's browser reacts to.
 *
 * A BAD STEP IS DROPPED; A BAD BATCH IS REFUSED. The distinction is deliberate.
 * An out-of-range ordinal is survivable — a session that started before a funnel
 * edit will emit an ordinal the new graph no longer has, and failing the whole post
 * would lose the steps that ARE still meaningful. A bad nonce or version is not
 * survivable: without them the rows cannot be de-duplicated or attributed, so they
 * would be noise in the table forever.
 */
export function parseStepEventBatch(raw: unknown): StepEventBatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  if (!isValidFlowVersion(body.flowVersion)) return null;
  if (!isValidNonce(body.nonce)) return null;
  if (!Array.isArray(body.steps)) return null;

  // De-duplicate as we go, so a session that re-rendered a screen six times inside
  // one flush writes one row for it rather than six. The aggregation would have
  // been right either way; the table would have been six times the size.
  const seen = new Set<number>();
  for (const entry of body.steps) {
    if (seen.size >= MAX_EVENTS_PER_BATCH) break;
    if (!isValidStepIndex(entry)) continue;
    seen.add(entry);
  }
  if (seen.size === 0) return null;

  // CONSTRUCTED, never spread: the returned object holds these three keys and no
  // key the caller invented, whatever they named it.
  return {
    flowVersion: body.flowVersion,
    nonce: body.nonce,
    steps: [...seen].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// The aggregation.
// ---------------------------------------------------------------------------

/** One stored event, reduced to the only two fields the tally needs. */
export interface StepEventRow {
  stepIndex: number;
  nonce: string;
}

export interface StepFunnelStep {
  stepIndex: number;
  /** Distinct sessions that reached this step. */
  views: number;
  /**
   * The share of the PREVIOUS step's sessions that did not reach this one, 0-100.
   * null for the first step (nothing before it) and whenever the previous step had
   * no sessions at all — "100% of nobody" is not a fact, and rendering it as 0%
   * would read as "this screen loses nobody", which is the opposite of the truth.
   */
  dropOffPct: number | null;
  /** The share of the FIRST step's sessions still here, 0-100. */
  reachedPct: number;
}

export interface StepFunnel {
  /** Ascending by stepIndex. */
  steps: StepFunnelStep[];
  /** Distinct sessions that reached any step at all. */
  sessions: number;
  /** First step -> last step, 0-100. null when the first step has no sessions. */
  completionPct: number | null;
}

/** One decimal place, decided HERE so two surfaces cannot round differently. */
function pct(part: number, whole: number): number {
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Turn raw step events into a per-step funnel with the drop-off between each pair
 * of consecutive steps.
 *
 * DE-DUPLICATION IS THE WHOLE POINT. A view is a SESSION reaching a step, not a
 * row: the beacon retries, the browser restores pages from bfcache, and a component
 * re-renders. Counting rows would make the busiest screen look like the most
 * popular one. The dedup key is (stepIndex, nonce), which is exactly the natural
 * key the migration deliberately does NOT enforce with a unique index — the read
 * side guarantees it for free, so the write path stays a cheap append.
 *
 * "CONSECUTIVE" MEANS CONSECUTIVE IN THE STEPS THAT EXIST. A funnel is a graph, so
 * a branch can skip an ordinal entirely; with no rows for step 2, the drop-off
 * reported on step 3 is measured against step 1. That is the honest reading of the
 * data this function is given. When the caller knows how long the funnel actually
 * is, `stepCount` fills the missing ordinals with zero-view steps so a screen
 * nobody reached draws as an empty bar rather than vanishing — which is precisely
 * the fault an owner opens this panel to find.
 *
 * Never mutates `rows`.
 */
export function aggregateStepEvents(
  rows: readonly StepEventRow[],
  opts?: { stepCount?: number },
): StepFunnel {
  const perStep = new Map<number, Set<string>>();
  const allSessions = new Set<string>();

  for (const row of rows) {
    if (!isValidStepIndex(row.stepIndex) || typeof row.nonce !== "string" || row.nonce === "") {
      continue;
    }
    let bucket = perStep.get(row.stepIndex);
    if (!bucket) {
      bucket = new Set<string>();
      perStep.set(row.stepIndex, bucket);
    }
    bucket.add(row.nonce);
    allSessions.add(row.nonce);
  }

  // The ordinals to report: every one with rows, plus — when the caller told us
  // how long the funnel is — every ordinal below that length. A union, not a
  // replacement: an ordinal with rows is never dropped just because the current
  // graph is shorter than it was when those rows were written.
  const ordinals = new Set<number>(perStep.keys());
  const stepCount = opts?.stepCount;
  if (typeof stepCount === "number" && Number.isInteger(stepCount) && stepCount > 0) {
    for (let i = 0; i < Math.min(stepCount, MAX_STEP_INDEX + 1); i++) ordinals.add(i);
  }

  const ordered = [...ordinals].sort((a, b) => a - b);
  if (ordered.length === 0) {
    return { steps: [], sessions: 0, completionPct: null };
  }

  const base = perStep.get(ordered[0])?.size ?? 0;
  const steps: StepFunnelStep[] = ordered.map((stepIndex, i) => {
    const views = perStep.get(stepIndex)?.size ?? 0;
    const previous = i === 0 ? null : (perStep.get(ordered[i - 1])?.size ?? 0);
    return {
      stepIndex,
      views,
      // Clamped at zero on purpose. A branch can send more sessions to a later
      // screen than to an earlier one, and a negative drop-off is not a sentence
      // about anybody leaving — it is a chart bar pointing the wrong way.
      dropOffPct:
        previous === null || previous === 0
          ? null
          : Math.min(100, Math.max(0, pct(previous - views, previous))),
      reachedPct: base === 0 ? 0 : Math.min(100, pct(views, base)),
    };
  });

  return {
    steps,
    sessions: allSessions.size,
    completionPct: base === 0 ? null : Math.min(100, pct(steps[steps.length - 1].views, base)),
  };
}
