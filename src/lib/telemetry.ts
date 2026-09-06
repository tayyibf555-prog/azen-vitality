import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";
import { OVERVIEW_SURFACE } from "@/lib/telemetry-surface";

// Product usage telemetry (usage_event, migration 0055). The write seam for the
// route + the action-event call sites, and the ONE grouped read the owner Usage
// view uses. Privacy by construction: only a module-family surface, an internal
// actor (email/role off the verified session) and an action NAME are ever stored
// — never patient data, never free text, never a full URL/id (see sanitiseSurface).

// The allowlist of storable page-view surfaces: every client module slug, with the
// empty Overview slug represented as "overview". Built once. This is what keeps URL
// ids and unknown/spoofed families out of usage_event by construction.
const KNOWN_SURFACES: ReadonlySet<string> = new Set(
  CLIENT_MODULE_SLUGS.map((s) => (s === "" ? OVERVIEW_SURFACE : s)),
);

/**
 * Validate a page-view surface against the nav-slug allowlist. Returns the
 * canonical surface, or null when it is not a known module family — the route then
 * silently no-ops, so nothing outside the allowlist is ever stored.
 */
export function sanitiseSurface(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const surface = s === "" ? OVERVIEW_SURFACE : s;
  return KNOWN_SURFACES.has(surface) ? surface : null;
}

// Trusted-literal normaliser for action surfaces / names: the call sites pass short
// constants, so this is not allowlist-gated (an action can originate from a flow
// that is not a 1:1 nav slug, e.g. "landing"). It only guarantees a small, safe,
// PII-free token.
function safeToken(raw: string, max = 64): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

export interface UsageActor {
  clientId: string;
  userEmail?: string | null;
  role?: string | null;
}

type UsageEventKind = "page_view" | "action";

// The single insert. Private; both public writers funnel through here so the row
// shape lives in exactly one place.
async function insertUsageEvent(row: {
  clientId: string;
  userEmail: string | null;
  role: string | null;
  event: UsageEventKind;
  surface: string;
  detail: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("usage_event").insert({
    client_id: row.clientId,
    user_email: row.userEmail,
    role: row.role,
    event: row.event,
    surface: row.surface,
    detail: row.detail,
  });
  if (error) throw error;
}

/**
 * Record a page view of a (pre-sanitised) surface. Fire-and-forget: it swallows
 * every error, so a telemetry failure can never break the request that triggered
 * it. The surface must already have passed sanitiseSurface.
 */
export async function recordPageView(input: {
  clientId: string;
  surface: string;
  userEmail?: string | null;
  role?: string | null;
}): Promise<void> {
  try {
    await insertUsageEvent({
      clientId: input.clientId,
      userEmail: input.userEmail ?? null,
      role: input.role ?? null,
      event: "page_view",
      surface: input.surface,
      detail: null,
    });
  } catch {
    // Telemetry must never surface an error.
  }
}

/**
 * Record an internal action event. ONE server-side seam, callable from an API route
 * with a single line: `void recordUsage("outreach", "campaign_launch", { clientId,
 * userEmail: auth?.email, role: auth?.role })`. `action` is stored as `detail` — the
 * action NAME only, never free text, a note body or an id. Fire-and-forget.
 */
export async function recordUsage(surface: string, action: string, ctx: UsageActor): Promise<void> {
  try {
    await insertUsageEvent({
      clientId: ctx.clientId,
      userEmail: ctx.userEmail ?? null,
      role: ctx.role ?? null,
      event: "action",
      surface: safeToken(surface),
      detail: safeToken(action),
    });
  } catch {
    // Telemetry must never surface an error.
  }
}

export interface UsageSurfaceCount {
  surface: string;
  views: number;
}

export interface UsageSummary {
  windowDays: number;
  /**
   * Page views tallied in the window. A FLOOR rather than a total when `capped`
   * is true — read it with `capped`, never on its own.
   */
  totalViews: number;
  /** Page-view counts per surface, most-used first. */
  surfaces: UsageSurfaceCount[];
  /** The internal user with the most page views in the window, or null. */
  mostActiveUser: { email: string; views: number } | null;
  /**
   * The window held more rows than the scan would read, so every figure here is
   * "at least" rather than "exactly" (charter §0/5, ruling W3/11). False on the
   * ordinary path, and false on a failed read — there was no scan to have
   * capped; `readError` is what says that read did not happen.
   */
  capped: boolean;
  /**
   * THE READ FAILED, AND THIS IS THE SENTENCE THAT SAYS SO. Null on every path
   * where the read actually happened, including a genuinely empty window.
   *
   * Without it this summary had no way to tell those two apart: the catch below
   * returned `{ totalViews: 0, surfaces: [], mostActiveUser: null, capped: false }`,
   * byte-identical to the summary a quiet thirty days produces, and the Reports
   * panel — whose only branch is `surfaces.length === 0` — drew "No usage
   * recorded yet / As your team moves around the platform, the modules they use
   * appear here". That is a positive claim about the practice made off a read
   * that never ran, which is precisely what the honest-numbers rule forbids
   * (charter §0/5, ruling W3/11; Home's OS band states it as "a failed read
   * never wears a number's clothes… an empty table and an unreachable one are
   * different facts", src/lib/home/os-band.ts). The same defect was closed one
   * directory over by `assembleSyncStatus`, which returns `counts: null` plus a
   * `ledgerError` sentence (src/lib/dentally/sync-status.ts) — this is that
   * field, in this module's words, and the panel prints it INSTEAD of the empty
   * state.
   */
  readError: string | null;
}

/**
 * The sentence a failed usage read puts on the owner's Reports page.
 *
 * Exported because it is the contract between this module and the one panel
 * that renders it: the copy lives HERE, beside the branch that decides it, so a
 * screen can never invent a cheerier version of the same fact. Owner-facing
 * copy — no patient ever reads it.
 */
export const USAGE_READ_ERROR =
  "Your team's activity could not be read just now, so this panel cannot show it. That is a fault with " +
  "this page, not a statement that nobody has been using the platform.";

// PAGE SIZE, KEPT ONE ROW UNDER THE SERVER'S OWN CEILING (programme ruling W3/32).
//
// Supabase applies a max-rows ceiling to every REST request, measured on this
// project at 1,000 (limit=1500 and limit=2001 both returned exactly a thousand
// rows, `content-range: 0-999/*`, no error — see POSTGREST_MAX_ROWS in
// src/lib/test-support/fake-supabase.ts). A page size of exactly 1,000 therefore
// sits ON that ceiling, where a full page and a CLIPPED page are the same
// observation: the loop can never tell "you asked for a thousand and there were a
// thousand" from "you asked for a thousand and the server stopped you". At 999
// the two are distinguishable again — a short page means the rows ran out, and
// nothing this loop asks for can ever be trimmed on the way back.
//
// That distinction used to be prudence rather than load-bearing — the tally was
// anchored to the exact head-count below and advanced by rows.length, which is
// exactly why the constant could sit on the ceiling for so long without anything
// going red. The keyset walk below now DOES read a short page as "the rows ran
// out" (there is no offset to run off the end of any more), so the width is the
// thing that makes that signal true. Pinned by name in telemetry.test.ts.
const SUMMARY_PAGE = 999;

/** Where one page of the usage scan stopped, in its own (created_at desc, id asc) order. */
interface UsageCursor {
  createdAt: string;
  id: string;
}

/**
 * The characters a cursor value may hold.
 *
 * Both values come straight out of this table — a timestamptz and a uuid — so this
 * can only fire on something that is not a cursor at all. It exists because the
 * values are interpolated into the PostgREST filter string below, and a value
 * carrying a quote or a backslash could break out of the quoting that makes that
 * string safe. Same belt-and-braces as the interest scan
 * (src/lib/triage/repository.ts) and the step-event scan
 * (src/lib/smile-assessment/step-events-repository.ts).
 */
const USAGE_CURSOR_SAFE = /^[A-Za-z0-9:.+-]+$/;

/**
 * "Strictly after this row, in (created_at desc, id asc) order": an older
 * timestamp, OR the same timestamp with a higher id.
 *
 * The values are double-quoted because a timestamptz literal contains `.`, `:` and
 * `+`, every one of which is a structural character in PostgREST's filter grammar.
 */
function usageKeysetFilter(c: UsageCursor): string {
  return `created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.gt."${c.id}")`;
}

/**
 * The most rows one summary will scan.
 *
 * A bound on work, not a total: past it the per-surface breakdown is built from
 * the first USAGE_SCAN_CAP rows in the window and the figure that reaches the
 * screen is a FLOOR. `UsageSummary.capped` says so, and the Reports panel prints
 * "at least N" (charter §0/5, ruling W3/11) — a truncated read never wears a
 * complete number's clothes.
 */
export const USAGE_SCAN_CAP = 50_000;

/**
 * The scan bound one call will use.
 *
 * A test may LOWER the bound so the "at least N" path is provable without seeding
 * fifty thousand rows; it may never RAISE it. Exported because that one-way
 * property is arithmetic, and proving it through `usageSummary` would cost a
 * 50,001-row fixture to observe a `Math.min` — the same reason
 * `createFakeSupabase`'s ceiling clamp is pinned on the clamp itself.
 */
export function resolveScanCap(requested: number | undefined): number {
  if (requested === undefined) return USAGE_SCAN_CAP;
  return Math.max(1, Math.min(Math.floor(requested), USAGE_SCAN_CAP));
}

/**
 * ONE grouped read for the owner Usage view: per-surface page-view counts and the
 * most-active internal user for a client over a window. The aggregation happens
 * here, server-side — raw rows never reach the client. Never throws: on any error
 * it returns a summary carrying no figures AND a `readError` sentence, so
 * telemetry can never break the Reports page and can never be mistaken for a
 * quiet one either.
 */
export async function usageSummary(args: {
  clientId: string;
  sinceIso: string;
  windowDays?: number;
  /**
   * LOWER the scan cap for a test, so the "at least N" path can be proven
   * without seeding fifty thousand rows. Clamped so it can never RAISE it — the
   * same one-way option `createFakeSupabase({ maxRows })` takes, and for the same
   * reason: an option that could loosen a bound is the bound coming back through
   * the door marked exit. No product code passes it.
   */
  scanCap?: number;
}): Promise<UsageSummary> {
  const windowDays = args.windowDays ?? 30;
  const scanCap = resolveScanCap(args.scanCap);
  try {
    const db = serviceClient();

    // Exact total first (head-count, transfers no rows): the ground truth for when
    // the page loop is done, correct even if the server caps pages lower.
    const { count, error: countError } = await db
      .from("usage_event")
      .select("*", { count: "exact", head: true })
      .eq("client_id", args.clientId)
      .eq("event", "page_view")
      .gte("created_at", args.sinceIso);
    if (countError) throw countError;
    // The head-count is the TRUE total (PostgREST reports it in `content-range`
    // even on a clipped body), so `capped` is decided against it and not against
    // how many rows the loop happened to see.
    const available = count ?? 0;
    const total = Math.min(available, scanCap);
    // Starts as "the window held more than the bound", and the walk below may only
    // ever turn it ON: any way the scan stops short of the head-count it is
    // anchored to leaves floors behind, and a floor must never reach the screen
    // wearing a total's clothes (charter §0/5, ruling W3/11).
    let capped = available > scanCap;

    // KEYSET PAGED, NOT OFFSET PAGED.
    //
    // This walk runs inside the owner Reports page's own server render — an async
    // server component awaited inline, in a tree that has no loading.tsx and may
    // never get one (the hydration bug, feb8677), so there is no skeleton and no
    // Suspense boundary behind which any of it can hide. Its query shape IS the
    // page's time to first byte. Two things were wrong with the
    // `.range(scanned, …)` walk this replaces, and they are the same two the
    // interest scan was rewritten for one directory over (see the long note above
    // `countInterestByTreatmentDetailed` in src/lib/triage/repository.ts):
    //
    //  1. OFFSET MOVES UNDER A TABLE THAT IS BEING WRITTEN TO, and this table is
    //     written by every page view in the building — the beacon inserts while
    //     the scan is running. The order is `created_at desc`, so a new row lands
    //     at position 0 and shifts the whole result set DOWN: the next offset page
    //     hands back a row the previous page already tallied. Unlike the interest
    //     scan there are no sets here to swallow the repeat — this is a raw tally,
    //     so a shifted page DOUBLE-COUNTS the surface and the user it lands on.
    //     A concurrent delete shifts the other way and drops a view outright.
    //     Carrying the last row's (created_at, id) and asking for "strictly older
    //     than the row I stopped at" is what fixes it: no concurrent write can
    //     move that boundary. The `id asc` tiebreak stays load-bearing — several
    //     views can share an instant, so `created_at` alone is not a cursor.
    //  2. DEEP OFFSET GETS SLOWER AS IT DEEPENS. 0055 indexes
    //     `(client_id, created_at desc)`, so page 40 of an offset walk re-scanned
    //     the whole prefix to throw the first 39,000 rows away — 51 sequential
    //     round trips at the cap, all of it in front of the owner's page. A keyset
    //     page carries its own `created_at <` predicate, so it starts where the
    //     last one stopped and the work does not grow with the depth.
    //
    // Every number this returns is unchanged: `total` is still anchored to the
    // exact head-count, the last page is still narrowed to what is still wanted so
    // a capped scan stops ON the cap, and `capped` still means "these are floors".
    const bySurface = new Map<string, number>();
    const byUser = new Map<string, number>();
    let scanned = 0;
    let cursor: UsageCursor | null = null;
    while (scanned < total) {
      // Narrowed to what is still wanted, so a capped scan stops ON the cap:
      // "at least 50,000" has to be a number the loop actually reached, not the
      // cap plus whatever the final page overshot by.
      const want = Math.min(SUMMARY_PAGE, total - scanned);
      let q = db
        .from("usage_event")
        // id and created_at are read for the cursor, not for the tally.
        .select("id, created_at, surface, user_email")
        .eq("client_id", args.clientId)
        .eq("event", "page_view")
        .gte("created_at", args.sinceIso);
      if (cursor) q = q.or(usageKeysetFilter(cursor));
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(want);
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string;
        created_at: string;
        surface: string;
        user_email: string | null;
      }>;
      for (const r of rows) {
        bySurface.set(r.surface, (bySurface.get(r.surface) ?? 0) + 1);
        if (r.user_email) byUser.set(r.user_email, (byUser.get(r.user_email) ?? 0) + 1);
      }
      scanned += rows.length;
      // A short page is the end of the rows — measured against what this page
      // ASKED for, not against SUMMARY_PAGE, so the narrowed last page of a capped
      // scan cannot be misread as the data running out. This also subsumes the old
      // empty-page safety break: the loop cannot spin, because every iteration
      // either advances by a full `want` rows or leaves here.
      if (rows.length < want) break;
      const last = rows[rows.length - 1];
      if (!USAGE_CURSOR_SAFE.test(String(last.created_at)) || !USAGE_CURSOR_SAFE.test(String(last.id))) {
        // No cursor we trust, so stop rather than page on a filter string we did
        // not mean to write — and SAY the figures are floors, because the scan
        // ended above the head-count it was anchored to. Fails closed: the Reports
        // panel prints "at least N" instead of a total it did not finish reading.
        capped = true;
        break;
      }
      cursor = { createdAt: last.created_at, id: last.id };
    }

    const surfaces = [...bySurface.entries()]
      .map(([surface, views]) => ({ surface, views }))
      .sort((a, b) => b.views - a.views);
    let mostActiveUser: UsageSummary["mostActiveUser"] = null;
    for (const [email, views] of byUser) {
      if (!mostActiveUser || views > mostActiveUser.views) mostActiveUser = { email, views };
    }
    return { windowDays, totalViews: scanned, surfaces, mostActiveUser, capped, readError: null };
  } catch (err) {
    // SAID OUT LOUD, IN BOTH DIRECTIONS. Every other degrading read in this
    // programme logs before it returns its honest empty (`assembleSyncStatus`,
    // src/lib/dentally/sync-status.ts); this one swallowed silently, so a
    // revoked grant on `usage_event` or a PostgREST blip left no trace anywhere
    // — not on the screen, which drew "No usage recorded yet", and not in the
    // server logs either. The two swallows above (recordPageView, recordUsage)
    // stay silent on purpose: they are fire-and-forget WRITES on the request
    // path of a page that must not care. This is the READ, and it is the one
    // that reaches a person.
    console.error(`[telemetry] could not read usage_event for ${args.clientId}`, err);
    return {
      windowDays,
      totalViews: 0,
      surfaces: [],
      mostActiveUser: null,
      capped: false,
      readError: USAGE_READ_ERROR,
    };
  }
}
