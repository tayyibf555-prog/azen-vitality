import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// THE DENTALLY REQUEST BUDGET
// ---------------------------------------------------------------------------
//
// WHAT HAPPENED. On 2026-08-20 every Dentally read from production returned
//
//   403 {"error":{"type":"invalid_access_error","message":"Rate limit exceeded"}}
//
// for the whole practice, all day. Dentally's ceiling is 3,600 requests/hour
// (x-ratelimit-limit, recorded in client.ts getInvoice), a FIXED window that
// recovers on the hour. The pre-warm cron (pg_cron job 22, every 15 minutes) was
// recomputing the practice dashboard — three sites x six paged scans x up to 40
// pages of 100 rows over 90 days — plus the outstanding book, FOUR TIMES AN HOUR.
// That is on the order of 2,400 requests/hour on its own, and it left nothing for
// the hourly syncs, the diary, the online-booking calendar or the agent.
//
// The practice could not see its own patients because a CACHE WARMER had eaten
// the quota. Nothing in the platform knew how much of the practice's quota it had
// already spent, and nothing ranked a patient trying to book above a cron job
// refreshing a number nobody was looking at.
//
// WHAT THIS IS. A shared, cross-instance token budget in front of every read the
// platform makes, with PRIORITY CLASSES. Background work is starved FIRST; the
// interactive surfaces the practice actually touches keep going far longer; the
// public booking calendar and the agent go on longest of all. It cannot fix a
// quota that is already gone, but it makes the platform structurally incapable of
// spending it all on itself.
//
// ---------------------------------------------------------------------------
// WHY api_budget AND NOT THE DISPLAY-CACHE TABLE
// ---------------------------------------------------------------------------
//
// Two existing pieces of cross-instance state were candidates.
//
//   dentally_display_cache (migration 0084) is a TTL BLOB store: read-modify-write
//   through the app, no atomicity. Two instances that both read "1,780 used" and
//   both write 1,781 have spent two requests and recorded one. Under Fluid Compute
//   there are many instances, which is the entire reason this problem exists, so a
//   counter that loses concurrent increments is not a counter.
//
//   api_budget + consume_rate_budget(key, limit, window_seconds) (migration 0023,
//   applied in production) is an INSERT ... ON CONFLICT DO UPDATE ... RETURNING in
//   ONE statement: the increment and the check cannot be raced apart. It was built
//   for exactly this shape of problem (bounding public AI spend across the fleet)
//   and it needs no new DDL, so this guard ships atomically with the code rather
//   than sitting inert until a migration is applied.
//
// So: api_budget, reused as-is. Two things are deliberately NOT reused:
//
//   consumeBudget() in @/lib/rate-budget wraps the same RPC but swallows every
//   error and returns TRUE. Unconditional fail-open is right for a cost cap on a
//   public AI endpoint and WRONG here — a bulk background scan that cannot see the
//   budget is precisely the thing that must not run. This module calls the RPC
//   directly so it can apply the asymmetry below.
//
//   A single fixed key with a rolling window. consume_rate_budget resets a key's
//   window when window_start is older than window_seconds, so the window is
//   anchored to the FIRST call after a reset and floats relative to the clock.
//   Dentally's window does not float: it recovers on the hour. A floating window
//   against a fixed one is the classic fixed-window burst — the tail of our window
//   and the head of the next can both land inside ONE of Dentally's hours, letting
//   through up to twice the ceiling in the hour that matters. So the key carries
//   the UTC HOUR (dentally:reads:2026-08-20T13) and our window is phase-locked to
//   theirs: one row per hour, ~24 rows a day, and the arithmetic below is about the
//   same hour Dentally is counting.
//
// ---------------------------------------------------------------------------
// THE PRIORITY SPLIT
// ---------------------------------------------------------------------------
//
// One shared counter, three ceilings. Every class increments the SAME per-hour
// counter, and a class is refused once total consumption for the hour passes ITS
// ceiling. So the classes are strictly nested: background dies first and the
// interactive surfaces carry on spending the headroom background just gave up.
//
//   background   60%  (2,160)  syncs, sweeps, the drain, the pre-warm cron.
//   interactive  90%  (3,240)  a person looking at a screen: dashboards, the
//                              diary, the patient record, reports, the co-pilot.
//   critical     95%  (3,420)  the public booking calendar and the 24/7 agent —
//                              a patient mid-booking, and the read a write is
//                              validated against.
//
// The remaining 5% (180 requests) is a HARD RESERVE the platform never spends. It
// is not slack for a feature to grow into: it absorbs the requests this guard
// cannot see (an in-flight request that started before a refusal, a retry inside
// fetch, a read from a path added without a guard) and leaves the practice's own
// Dentally logins some room if a human is fighting the same ceiling.
//
// ---------------------------------------------------------------------------
// FAIL-SAFE ASYMMETRY
// ---------------------------------------------------------------------------
//
// When the budget store itself is unavailable (Supabase down, the RPC erroring,
// a network blip) the guard cannot know the consumption, and the two directions
// are NOT symmetric:
//
//   interactive / critical  FAIL OPEN. A practice manager, or a patient trying to
//                           book, must not be blocked by our bookkeeping being
//                           down. The blast radius of being wrong is one hour of
//                           slightly-over-budget reads by humans, which is small
//                           because humans are slow.
//
//   background              FAIL CLOSED. A bulk scan is exactly the thing that
//                           empties the quota, it is the thing that caused this
//                           incident, and it loses nothing by waiting: every sweep
//                           and sync here is idempotent and re-runs on the next
//                           tick. Running blind is how the quota disappears; not
//                           running is a delay.
//
// ---------------------------------------------------------------------------
// A REFUSAL IS STICKY
// ---------------------------------------------------------------------------
//
// The RPC increments the counter on the call it REFUSES as well as the ones it
// allows — one atomic increment-and-check, it cannot do otherwise. So a refusal is
// only free if the caller stops asking, and several of ours did not: they swallow
// per-row errors and keep walking. Once a scope has been refused for its own class,
// every later consume in that scope short-circuits WITHOUT touching the store. See
// "Sticky refusal" further down for what it does not do, and
// budget-sticky-refusal.test.ts for the case it closes.
//
// ---------------------------------------------------------------------------

/** Dentally's own ceiling: x-ratelimit-limit 3600, per fixed clock hour. */
export const DENTALLY_HOURLY_LIMIT = 3600;

/** The window we count in, matching Dentally's: one clock hour. */
export const DENTALLY_WINDOW_SECONDS = 3600;

export type DentallyPriority = "critical" | "interactive" | "background";

/**
 * Fraction of DENTALLY_HOURLY_LIMIT each class may consume before it is refused.
 * Nested, not partitioned: they all count the same requests, so background stops
 * at 60% of the WHOLE hour's spend and hands the rest upward.
 */
export const DENTALLY_CEILINGS: Readonly<Record<DentallyPriority, number>> = {
  background: 0.6,
  interactive: 0.9,
  critical: 0.95,
};

/** The absolute request count at which `priority` starts being refused. */
export function dentallyCeiling(priority: DentallyPriority): number {
  return Math.floor(DENTALLY_HOURLY_LIMIT * DENTALLY_CEILINGS[priority]);
}

/** Requests this platform will never spend, whatever the class. */
export const DENTALLY_HARD_RESERVE =
  DENTALLY_HOURLY_LIMIT - dentallyCeiling("critical");

/** The api_budget key for the clock hour `now` falls in (UTC, matching Dentally). */
export function dentallyBudgetKey(now: Date): string {
  return `dentally:reads:${now.toISOString().slice(0, 13)}`;
}

export interface BudgetDecision {
  allowed: boolean;
  priority: DentallyPriority;
  /** The ceiling this decision was taken against. */
  limit: number;
  /**
   * Why the guard answered as it did. `within` / `over` are real answers from the
   * store; `store-unavailable` is the asymmetric fallback; `disabled` means no
   * guard is installed (the VITEST default, see consumeDentallyBudget);
   * `scope-refused` is the STICKY refusal — this execution scope has already been
   * refused, so the answer was given WITHOUT touching the store at all (see
   * "Sticky refusal" below). It is the one reason that costs nothing.
   */
  reason: "within" | "over" | "store-unavailable" | "disabled" | "scope-refused";
}

/** The pluggable consume step. Throws when the store cannot answer. */
export type BudgetConsumer = (
  priority: DentallyPriority,
  limit: number,
  key: string,
) => Promise<boolean>;

/**
 * The real consumer: one atomic increment-and-check against api_budget.
 *
 * The Supabase client is imported LAZILY so that importing this module (and
 * therefore DentallyClient, which every Dentally test constructs) never drags the
 * database client in. It also keeps the guard usable from any runtime that has not
 * configured Supabase — such a call throws, and the asymmetry above decides.
 */
const supabaseConsumer: BudgetConsumer = async (_priority, limit, key) => {
  const { serviceClient } = await import("@/lib/supabase/server");
  const db = serviceClient();
  const { data, error } = await db.rpc("consume_rate_budget", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: DENTALLY_WINDOW_SECONDS,
  });
  // An RPC error is NOT "allowed". Throwing hands the decision to the asymmetry,
  // which is the only place fail-open/fail-closed is decided.
  if (error) throw new Error(`consume_rate_budget failed: ${error.message}`);
  return data === true;
};

/**
 * DISABLED UNDER VITEST BY DEFAULT, exactly like the display cache in
 * dentally/read.ts. The unit suite exercises the reads with fake fetches and no
 * database; a guard that fails closed for background work would otherwise turn
 * every sweep test into a refusal. Tests that want the guard install one with
 * __setDentallyBudgetForTests.
 */
let consumer: BudgetConsumer | null = process.env.VITEST ? null : supabaseConsumer;

/**
 * TEST SEAM. Install a consumer (or null to disable the guard). Mirrors
 * __setDisplayCacheForTests. Only for tests.
 */
export function __setDentallyBudgetForTests(fn: BudgetConsumer | null): void {
  consumer = fn;
}

/**
 * Take one request out of the practice's hourly Dentally budget for `priority`.
 *
 * NEVER THROWS: it returns a decision, so the call site's only job is to obey it.
 * A refusal is final for that request — the caller must ABORT, not retry. A retry
 * loop against a refusal spends real counter increments for requests that were
 * never sent, which is how a guard turns into the outage it was built to prevent.
 *
 * That last sentence used to be a CONTRACT WITH NO ENFORCEMENT, and the callers
 * broke it. See "Sticky refusal" below: this function now enforces it itself.
 */
export async function consumeDentallyBudget(
  priority: DentallyPriority,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const limit = dentallyCeiling(priority);

  // STICKY REFUSAL, CHECKED FIRST. If this execution scope has already been refused
  // for this class, the answer is known and the store must NOT be asked again: the
  // RPC increments whether or not a Dentally request follows, so asking again is a
  // phantom increment against the practice's real quota.
  //
  // Only for the scope's OWN class. A client built with an explicit opts.priority
  // (client.ts) can be a different class from the scope it happens to run inside —
  // a critical read inside a background job — and that read has its own ceiling and
  // its own headroom. Inheriting a background refusal would refuse it wrongly.
  const scope = priorityStore.getStore();
  const sticky = scope !== undefined && scope.priority === priority;
  if (sticky && scope.refusal !== null) {
    return { allowed: false, priority, limit, reason: "scope-refused" };
  }

  const active = consumer;
  if (active === null) return { allowed: true, priority, limit, reason: "disabled" };
  try {
    const within = await active(priority, limit, dentallyBudgetKey(now));
    if (!within && sticky) markScopeRefused(scope, limit, "over");
    return { allowed: within, priority, limit, reason: within ? "within" : "over" };
  } catch {
    // THE ASYMMETRY. Humans and patients keep reading; bulk background work stops.
    const allowed = priority !== "background";
    if (!allowed && sticky) markScopeRefused(scope, limit, "store-unavailable");
    return { allowed, priority, limit, reason: "store-unavailable" };
  }
}

/** What a human needs to see: how much of this hour's quota the platform has spent. */
export interface DentallyConsumption {
  /** The UTC clock hour these figures belong to, e.g. "2026-08-20T13". */
  hour: string;
  /** Requests consumed this hour, as counted by the shared budget. */
  used: number;
  /** Dentally's ceiling for the hour. */
  limit: number;
  /** used/limit as a percentage, rounded to one decimal. */
  pctUsed: number;
  /** Absolute request counts at which each class starts being refused. */
  ceilings: Record<DentallyPriority, number>;
  /** Classes that would still be served at this consumption. */
  serving: DentallyPriority[];
  /** Null when the figure itself could not be read. */
  readable: boolean;
}

/**
 * Read the current consumption WITHOUT consuming any. For the pre-warm cron's
 * response body and for anyone asking "what is the platform doing to our quota".
 * Never throws: an unreadable store reports readable:false rather than pretending
 * the hour is empty, because "0 used" is the one answer that would be acted on.
 */
export async function readDentallyConsumption(
  now: Date = new Date(),
): Promise<DentallyConsumption> {
  const hour = now.toISOString().slice(0, 13);
  const ceilings: Record<DentallyPriority, number> = {
    background: dentallyCeiling("background"),
    interactive: dentallyCeiling("interactive"),
    critical: dentallyCeiling("critical"),
  };
  const blank: DentallyConsumption = {
    hour,
    used: 0,
    limit: DENTALLY_HOURLY_LIMIT,
    pctUsed: 0,
    ceilings,
    serving: [],
    readable: false,
  };
  if (consumer === null) return blank;
  try {
    const { serviceClient } = await import("@/lib/supabase/server");
    const db = serviceClient();
    const { data, error } = await db
      .from("api_budget")
      .select("count")
      .eq("key", dentallyBudgetKey(now))
      .maybeSingle();
    if (error) return blank;
    const used = Number((data as { count?: number } | null)?.count ?? 0);
    if (!Number.isFinite(used)) return blank;
    return {
      hour,
      used,
      limit: DENTALLY_HOURLY_LIMIT,
      pctUsed: Math.round((used / DENTALLY_HOURLY_LIMIT) * 1000) / 10,
      ceilings,
      serving: (["background", "interactive", "critical"] as const).filter(
        (p) => used < ceilings[p],
      ),
      readable: true,
    };
  } catch {
    return blank;
  }
}

// --- Ambient priority ------------------------------------------------------
//
// The class cannot be a property of the client alone. The sweeps do not build
// their own client for most of their reads: they call helpers in dentally/read.ts
// and dashboard/read.ts, which build one from the environment. Tagging the eleven
// construction sites would therefore tag the wrong thing — the same
// dentallyFromEnv() client backs a practice manager's dashboard AND the hourly
// recall sync.
//
// So the class travels with the EXECUTION, in an AsyncLocalStorage scope entered
// at the entry point (a cron route, a webhook, the booking endpoint). Everything
// that scope calls — including the concurrent fan-outs, which inherit it — reads
// the same class, and a helper deep in the stack needs to know nothing about it.
//
// THE DEFAULT IS "interactive", ON PURPOSE. An unclassified read is far more
// likely to be a page someone is waiting on than a bulk sweep, and the failure
// modes are not equal: mis-classing a sweep as interactive costs some headroom,
// while mis-classing a user's dashboard as background makes it go blank at 60%.
// The routes that must be background are pinned by budget-priority-coverage.test.ts
// rather than left to this default.

// --- Sticky refusal --------------------------------------------------------
//
// THE DEFECT THIS CLOSES. consume_rate_budget increments the shared counter on
// EVERY call, including the one it refuses — it has to, it is one atomic
// increment-and-check. So a refusal is only free if the caller stops. Several of
// ours did not: they wrap each read in a try/catch and treat a failure as "skip
// this row and carry on", which is exactly right for a transient 500 and exactly
// wrong for a budget refusal. A single sweep fanning out over its per-run cap of
// patients would take one refusal and then walk the rest of the list, spending a
// real counter increment per patient for requests it never sent. Nothing was read,
// nothing was sent, and the practice's shared hourly counter climbed anyway — past
// the point where the BOOKING CALENDAR would be refused, with real Dentally
// headroom still unspent. The guard would have caused the outage it exists to
// prevent, in a case where having no guard at all would have been fine.
//
// A cadence change cannot close it: the phantom increments come from the sweeps,
// not from how often they run. Auditing every catch cannot close it either — it
// would have to be re-audited on every read added afterwards.
//
// So the refusal is made STICKY, here, at the one place every read passes through.
// The scope carries a mutable flag; the first refusal sets it; every later consume
// for that scope's own class returns `scope-refused` WITHOUT calling the RPC. A
// swallowing caller can now loop as long as it likes and the counter does not move.
//
// WHAT IT DOES NOT DO. It is per SCOPE, not global: a refused background sweep
// leaves interactive and critical scopes completely untouched, which is the whole
// priority design (a sweep dying must never dim the booking calendar). And a
// concurrent fan-out that is already in flight when the first refusal lands still
// costs one increment each — the flag cannot be set before those calls are made.
// The residual is therefore bounded by the scope's CONCURRENCY (8-10 in every pool
// in this repo), not by its item count: tens, not thousands. The remaining bound is
// the reason the callers ALSO stop when they see `dentallyScopeRefused()` rather
// than relying on this alone.

/** The per-execution refusal record, or null while the scope is still spending. */
export interface DentallyScopeRefusal {
  /** The class that was refused — always the scope's own. */
  priority: DentallyPriority;
  /** The ceiling the refusal was taken against. */
  limit: number;
  /** `over` = the hour's ceiling is reached. `store-unavailable` = fail-closed. */
  reason: "over" | "store-unavailable";
}

interface PriorityScope {
  readonly priority: DentallyPriority;
  /** Set ONCE, on the first refusal in this scope. Never cleared: a scope that has
   *  been refused stays refused for its whole run, and the next run gets a new one. */
  refusal: DentallyScopeRefusal | null;
}

function markScopeRefused(
  scope: PriorityScope,
  limit: number,
  reason: DentallyScopeRefusal["reason"],
): void {
  if (scope.refusal !== null) return; // first refusal wins; keep the original reason
  scope.refusal = { priority: scope.priority, limit, reason };
  console.warn(
    `[dentally-budget] ${scope.priority} work REFUSED at ceiling ${limit} of ` +
      `${DENTALLY_HOURLY_LIMIT}/hour (${reason}). This scope will make NO further ` +
      `Dentally requests and NO further budget calls; it should stop now and retry ` +
      `on its next tick.`,
  );
}

const priorityStore = new AsyncLocalStorage<PriorityScope>();

/**
 * Run `fn` with every Dentally read inside it classified as `priority`.
 *
 * A FRESH refusal flag per entry, deliberately. Each call is one unit of work — one
 * cron tick, one request, one detached SWR refresh — and each is entitled to find
 * out for itself whether there is budget. That is also what keeps a nested
 * `runWithDentallyPriority("critical", ...)` inside a refused background sweep able
 * to spend: it is a different scope with a different ceiling.
 */
export function runWithDentallyPriority<T>(
  priority: DentallyPriority,
  fn: () => Promise<T>,
): Promise<T> {
  return priorityStore.run({ priority, refusal: null }, fn);
}

/** The class of the current execution scope; "interactive" outside any scope. */
export function currentDentallyPriority(): DentallyPriority {
  return priorityStore.getStore()?.priority ?? "interactive";
}

/**
 * The refusal this execution scope has already taken, or null.
 *
 * FOR CALLERS THAT SWALLOW. A sweep that catches per-row errors cannot tell a
 * budget refusal from a transient one by looking at the error, and should not have
 * to: it asks here instead. Answering true means every remaining read in this run
 * would be refused, so the honest move is to stop the scan, say so in the log and
 * in the response body, and let the next tick retry — NOT to walk the rest of the
 * list producing nothing.
 *
 * Outside any scope this is always null: an unscoped read is a one-off, there is no
 * run for a refusal to belong to.
 */
export function dentallyScopeRefusal(): DentallyScopeRefusal | null {
  return priorityStore.getStore()?.refusal ?? null;
}

/** `dentallyScopeRefusal() !== null`, for the common `if (...) break` at call sites. */
export function dentallyScopeRefused(): boolean {
  return dentallyScopeRefusal() !== null;
}
