import { serviceClient } from "@/lib/supabase/server";
import type { StepEventRow } from "./step-events";

// Server-only persistence for assessment_step_event (migration 0080). Kept OUT of
// step-events.ts on purpose: that module holds the rules and is imported by the
// browser-side beacon's sibling, so a `serviceClient` import there would drag a
// service-role client into the public quiz's bundle graph. Same split the charter
// asks for everywhere — pure rules in one file, I/O in another.
//
// The write path is fed by an UNAUTHENTICATED endpoint. Everything a caller chose
// has already been through parseStepEventBatch by the time it reaches insertStepEvents;
// the client and campaign ids are resolved server-side and never read off the body.

/** Migration 0080 has not been applied to this database yet. */
export class StepEventTableMissingError extends Error {
  constructor() {
    super("Step drop-off needs migration 0080_assessment_step_events.sql to be applied.");
    this.name = "StepEventTableMissingError";
  }
}

/**
 * Postgres/PostgREST both have a way of saying "no such table". Catch either.
 *
 * The message-text fallback is narrowed to this table's name so it cannot swallow
 * a genuine typo elsewhere in the same query — the same shape campaign-repository's
 * isMissingColumn uses for 0078/0079.
 */
function isMissingTable(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  // 42P01 undefined_table; PGRST205 is PostgREST's "table not found in schema cache".
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .*assessment_step_event.* does not exist/i.test(error.message ?? "");
}

export interface StepEventInsert {
  clientId: string;
  campaignId: string;
  flowVersion: number;
  stepIndex: number;
  nonce: string;
}

/**
 * Append step events. Throws on failure; the public route swallows it, because
 * telemetry must never become an error a patient's browser reacts to.
 *
 * One INSERT for the whole batch. The batch is bounded upstream
 * (MAX_EVENTS_PER_BATCH), so this cannot become an unbounded write.
 */
export async function insertStepEvents(rows: StepEventInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const db = serviceClient();
  const { error } = await db.from("assessment_step_event").insert(
    rows.map((r) => ({
      client_id: r.clientId,
      campaign_id: r.campaignId,
      flow_version: r.flowVersion,
      step_index: r.stepIndex,
      session_nonce: r.nonce,
    })),
  );
  if (error) {
    if (isMissingTable(error)) throw new StepEventTableMissingError();
    throw error;
  }
}

/**
 * The two fields the aggregation needs, for one campaign + flow version over a
 * date range, plus whether the scan hit its ceiling.
 */
export interface StepEventScan {
  rows: StepEventRow[];
  /**
   * True when MAX_SCAN_ROWS was reached and older events were not read.
   *
   * Deliberately CONSERVATIVE at the exact boundary: a range holding precisely
   * MAX_SCAN_ROWS rows reports truncated, because the last page came back full and
   * the scan stops without asking again. "There may be more" is the safe direction
   * to be wrong in — the opposite would present a partial tally as a complete one.
   */
  truncated: boolean;
}

/** PostgREST's default page cap, so a short page is a reliable "no more rows". */
const SCAN_PAGE = 1000;

/**
 * The hard ceiling on one report's scan.
 *
 * funnelSummary (funnel/events.ts) deliberately pages to an exact head-count and
 * is correct at any scale. This one takes the other trade, because it is fed by a
 * public endpoint rather than by our own pages: the daily budget guard caps a
 * campaign at DAILY_BUDGET_LIMIT posts of up to MAX_EVENTS_PER_BATCH rows, so a
 * determined flood plus a wide date range is a scan nobody should be able to make
 * a signed-in owner's request perform. 200k rows is far past any honest campaign's
 * traffic and still a bounded amount of work.
 */
const MAX_SCAN_ROWS = 200_000;

/** One page's cursor: the last row read, in the scan's own sort order. */
interface ScanCursor {
  createdAt: string;
  id: string;
}

/**
 * The characters a cursor value may contain.
 *
 * Both values come out of our own table — a timestamptz and a uuid — so this can
 * only ever fire on something that is not a cursor at all. It exists because the
 * values are interpolated into a PostgREST filter string below, and a value
 * carrying a quote or a backslash could break out of the quoting that makes that
 * string safe. Belt and braces on a query built from data rather than from input.
 */
const CURSOR_SAFE = /^[A-Za-z0-9:.+-]+$/;

/**
 * "Strictly after this row, in (created_at desc, id desc) order", as a PostgREST
 * `or` filter: an older timestamp, OR the same timestamp with a lower id.
 *
 * The values are double-quoted because a timestamptz literal contains `.`, `:` and
 * `+`, all of which are structural characters in PostgREST's filter grammar.
 */
function keysetFilter(c: ScanCursor): string {
  return `created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt."${c.id}")`;
}

/**
 * Read the raw events for one campaign + flow version.
 *
 * NEWEST FIRST, which matters only when the ceiling is hit: a truncated scan then
 * holds the most RECENT window rather than the oldest, which is the half an owner
 * asked about. The aggregation is order-independent (it de-duplicates into sets),
 * so this costs nothing when the ceiling is not hit.
 *
 * KEYSET PAGED, NOT OFFSET PAGED, and the difference is correctness rather than
 * speed. An OFFSET walk re-runs the whole filter and counts past N rows on every
 * page, so a row inserted during the walk — and this table's whole job is to be
 * written to constantly by a public endpoint — shifts every later page down by
 * one: page 2 re-reads a row page 1 already had, and one row is silently never
 * read at all. On a de-duplicating aggregation the double-count is harmless and
 * the SKIP is not: it is a session quietly dropped from a step's tally. Carrying
 * the last row's (created_at, id) instead means each page asks for "strictly older
 * than the row I stopped at", which no concurrent insert can move. It also stops
 * the scan getting quadratically slower as it deepens, but that is the bonus.
 *
 * (created_at, id) TOGETHER, because neither is enough alone: created_at is not
 * unique on a table that ingests whole batches inside one millisecond, and id is a
 * random uuid with no time order. Both are KEY columns of 0080's read-path index —
 * the last two — so the index's own order is this query's order: the scan needs no
 * sort, the cursor lands by seek, and the index-only scan the migration was shaped
 * around is intact (step_index and session_nonce ride along in the INCLUDE list).
 *
 * SCOPED BY campaign_id AND flow_version, never by client alone. A drop-off number
 * is about one version of one funnel: mixing versions averages the funnel an owner
 * just fixed with the one they fixed it from (0080's header, reason 2).
 */
export async function readStepEvents(args: {
  campaignId: string;
  flowVersion: number;
  fromIso: string;
  toIso: string;
}): Promise<StepEventScan> {
  const db = serviceClient();
  const rows: StepEventRow[] = [];
  let cursor: ScanCursor | null = null;

  for (let scanned = 0; scanned < MAX_SCAN_ROWS; scanned += SCAN_PAGE) {
    const want = Math.min(SCAN_PAGE, MAX_SCAN_ROWS - scanned);

    let query = db
      .from("assessment_step_event")
      // id and created_at are read for the cursor, not for the tally. Both are in
      // the read-path index (0080), so selecting them costs no heap access.
      .select("id, created_at, step_index, session_nonce")
      .eq("campaign_id", args.campaignId)
      .eq("flow_version", args.flowVersion)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso);
    if (cursor) query = query.or(keysetFilter(cursor));

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(want);
    if (error) {
      if (isMissingTable(error)) throw new StepEventTableMissingError();
      throw error;
    }

    const page = (data ?? []) as Array<{
      id: string;
      created_at: string;
      step_index: number;
      session_nonce: string;
    }>;
    for (const r of page) rows.push({ stepIndex: r.step_index, nonce: r.session_nonce });

    // A short page is the reliable "no more rows": it is compared against what this
    // page ASKED for, not against SCAN_PAGE, so the final part-page of the ceiling
    // cannot be misread as the end of the data.
    if (page.length < want) return { rows, truncated: false };

    const last = page[page.length - 1];
    if (!CURSOR_SAFE.test(String(last.created_at)) || !CURSOR_SAFE.test(String(last.id))) {
      // Cannot build a cursor we trust, so stop and SAY the tally is partial rather
      // than page on a filter string we did not mean to write.
      return { rows, truncated: true };
    }
    cursor = { createdAt: last.created_at, id: last.id };
  }

  return { rows, truncated: true };
}
