import "server-only";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { dentallySiteId } from "@/lib/mock/clients";
import { shiftDayKey, type DayCoverage, type DayWindow } from "@/lib/dashboard/period";
import {
  computeNhsBandReport,
  normaliseReportNhsClaims,
  type NhsBandReport,
} from "@/lib/reports/nhs-activity";
import {
  computeNhsClinicalReport,
  type NhsClinicalReport,
} from "@/lib/reports/nhs-clinical-activity";
import {
  allocationWindowTooLong,
  ALLOCATION_WINDOW_UNAVAILABLE,
  type AllocationReport,
} from "@/lib/reports/allocation-report";
import { readAllocationPass } from "@/lib/reports/allocation-read";
import { pageAll, REPORTS_PER_PAGE, REPORTS_SCAN_MAX_PAGES } from "@/lib/reports/scan";

// ---------------------------------------------------------------------------
// The server read for the three flagship reports.
//
// THE ENDPOINTS FILTER BY DATE. THIS FILE USED TO SAY THEY DID NOT.
//
// What stood here was: "Both sources (nhs_claims, payments) are the same
// date-unfilterable, newest-first endpoints the dashboard reads, so both are
// assembled by paging each site backwards to the window's first day and reporting
// how far the scan reached." Both halves were false, proven against live Dentally
// by read-only probe on 2026-08-21, and the identical premise had already cost the
// practice owner a takings strip that read £17,012.10 for ninety days against
// Dentally's own £114,429.78 — 85% short — before it was corrected on the dashboard
// (src/lib/dashboard/read.ts). These reports were built on the same sand:
//
//   1. THE ROWS ARE NOT DATE-ORDERED. They are ordered by id, so a claim submitted
//      today for a course closed last year, or a payment entered today for work done
//      in 2023, sits wherever its id falls. On site N15, /v1/payments page 1 spans
//      2026-08-11..21 and page 20 spans 2023-09-14..2026-03-31. "Page back until you
//      pass the boundary" therefore stopped on page one AND skipped in-window rows
//      further in — and then reported coverage that claimed the window was covered.
//      On a report the practice pays dentists from, that is the worst possible
//      failure: a wrong number wearing a complete number's clothes.
//
//   2. EACH ENDPOINT TAKES A DATE FILTER, UNDER ITS OWN NAME:
//        /v1/payments    start_date / end_date  — INCLUSIVE both edges, on dated_on
//        /v1/nhs_claims  after / before         — on submitted_date
//      They are NOT interchangeable. start_date/end_date on /v1/nhs_claims is
//      ACCEPTED and returns zero rows for every range, 2000..2030 included, so
//      copying the payments parameters onto the claims read would blank Report A
//      while looking like a working filter. The parameter tables live on
//      listPayments / listNhsClaims in src/lib/dentally/client.ts.
//
// WHAT SURVIVES, BECAUSE IT WAS THE RIGHT INSTINCT ON A WRONG PREMISE: a window
// that cannot be read IN FULL is reported UNAVAILABLE with a reason, never totalled
// from what happened to arrive. The difference is that completeness is now MEASURED
// against Dentally's own `meta.total` (see pageAll in ./scan.ts) instead of guessed
// from where a walk stopped — the one thing an id-ordered index can never tell you.
// One dead site still fails the whole scope, on the same all-or-nothing reasoning
// the takings strip uses: a group total silently missing a practice is worse than a
// blank one.
//
// COST. Narrowing at the server made these reads CHEAPER, not dearer: Report A over
// a month now pages the month's claims rather than walking 60 pages a site hoping to
// reach its first day, and Report B pages only the window it attributes. These are
// display reads on a page a person is looking at, so they run at the default
// `interactive` Dentally priority (src/lib/dentally/budget.ts) and nothing here
// pre-warms or runs on a cron. They do not participate in the display cache: a
// report is read fresh, so there is no stale row for a failed read to be promoted
// over.
// ---------------------------------------------------------------------------

export interface PractitionerRef {
  id: string;
  name: string;
}

const SCAN_FAILED =
  "Unavailable: a live read failed for one of the sites in scope, so the total cannot be shown honestly for the whole group.";

const CLAIMS_INCOMPLETE =
  "Unavailable: this period holds more NHS claims than a single run can read. Dentally publishes no UDA total on this endpoint — unlike payments, where the envelope carries the sum — so every claim in the window has to be paged, and this window holds more than the page budget allows. The figures are not shown from a partial read. Choose a shorter period.";

const PAYMENTS_INCOMPLETE =
  "Unavailable: this period holds more payments than a single run can read, so the money received in it cannot be attributed in full. The figures are not shown from a partial read. Choose a shorter period.";

/**
 * Site's practitioners, id → display name, across every site in scope. EXPORTED
 * because Report C scans by practitioner (the treatment_plan_item carries no
 * site_id, so the roster IS the per-site scope) and must use the exact same
 * active-clinician set this returns.
 */
export async function readPractitioners(siteIds: readonly string[]): Promise<PractitionerRef[]> {
  const client = dentallyFromEnv();
  const byId = new Map<string, string>();
  await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const res = await client.listPractitioners(dentallySiteId(siteId));
        for (const item of res.practitioners ?? []) {
          if (item === null || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          if (r["active"] !== true) continue;
          const id = typeof r["id"] === "string" ? r["id"] : typeof r["id"] === "number" ? String(r["id"]) : null;
          if (id === null) continue;
          const user = (r["user"] && typeof r["user"] === "object" ? r["user"] : {}) as Record<string, unknown>;
          const first = typeof user["first_name"] === "string" ? user["first_name"].trim() : "";
          const last = typeof user["last_name"] === "string" ? user["last_name"].trim() : "";
          const name = [first, last].filter((p) => p.length > 0).join(" ") ||
            (typeof user["name"] === "string" ? user["name"] : "") || id;
          byId.set(id, name);
        }
      } catch (err) {
        console.error(`[reports] practitioner read failed for site ${siteId}`, err);
      }
    }),
  );
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// --- Report A: NHS band activity --------------------------------------------

export interface NhsBandReadResult {
  window: DayWindow;
  report: NhsBandReport | null;
  practitioners: PractitionerRef[];
  coverage: DayCoverage | null;
  unavailableReason: string | null;
  droppedClaims: number;
}

/**
 * One site's claims for the window, narrowed at the server and read to the end.
 *
 * BOTH EDGES ARE PADDED A DAY, on purpose. `before=<today>` was observed to EXCLUDE
 * that day's own claims (live: 30,336 -> 30,333) and `after`'s edge convention is
 * unstated, so the request asks for a superset and computeNhsBandReport trims to the
 * window client-side on `submitted_date`. A superset costs at most one extra day of
 * rows; a missing boundary day would silently drop a clinician's work.
 *
 * `submitted_date` arrives as a full ISO instant with an offset on live
 * ("2026-08-21T12:55:02.776+01:00") and as a bare day key in the fixtures, which is
 * why the trimming is done by the normaliser (londonDayOfIso) and not by comparing
 * strings here.
 */
async function readWindowClaims(
  client: ReturnType<typeof dentallyFromEnv>,
  siteId: string,
  window: DayWindow,
) {
  const after = shiftDayKey(window.from, -1) ?? window.from;
  const before = shiftDayKey(window.to, 1) ?? window.to;
  return pageAll(
    (page) =>
      client
        .listNhsClaims({
          siteId: dentallySiteId(siteId),
          after,
          before,
          page,
          perPage: REPORTS_PER_PAGE,
        })
        .then((res) => ({ rows: res.nhs_claims ?? [], meta: res.meta })),
    REPORTS_SCAN_MAX_PAGES,
  );
}

export async function readNhsBandReport(args: {
  siteIds: readonly string[];
  window: DayWindow;
  /** Kept for signature parity with the other reports; the window fully determines
   *  the read now that the server does the narrowing. */
  now: Date;
}): Promise<NhsBandReadResult> {
  const { siteIds, window } = args;
  const client = dentallyFromEnv();

  const [practitioners, scans] = await Promise.all([
    readPractitioners(siteIds),
    Promise.all(
      siteIds.map(async (siteId) => {
        try {
          const { raw, complete } = await readWindowClaims(client, siteId, window);
          if (!complete) {
            console.error(
              `[reports] NHS claim read incomplete for site ${siteId} over ${window.from}..${window.to}; ` +
                `reporting the band report unavailable rather than totalling a slice`,
            );
            return { rows: [], dropped: 0, ok: true, complete: false };
          }
          const { rows, dropped } = normaliseReportNhsClaims(raw);
          return { rows: rows.map((c) => ({ ...c, siteId })), dropped, ok: true, complete: true };
        } catch (err) {
          console.error(`[reports] NHS claim scan failed for site ${siteId}`, err);
          return { rows: [], dropped: 0, ok: false, complete: false };
        }
      }),
    ),
  ]);

  const empty = (unavailableReason: string): NhsBandReadResult => ({
    window,
    report: null,
    practitioners,
    coverage: null,
    unavailableReason,
    droppedClaims: 0,
  });

  // A GENUINE OUTAGE OUTRANKS "too much data". They send someone looking in
  // different places — one at a broken connection, the other at the period picker —
  // and dressing an outage up as a volume problem makes it look smaller than it is.
  if (scans.some((s) => !s.ok)) return empty(SCAN_FAILED);
  if (scans.some((s) => !s.complete)) return empty(CLAIMS_INCOMPLETE);

  const claims = scans.flatMap((s) => s.rows);
  const report = computeNhsBandReport({ claims, window });
  return {
    window,
    report,
    practitioners,
    // Every site answered in full for the whole window, which is the only shape of
    // coverage this read can now produce: it is complete or it is unavailable.
    coverage: { from: window.from, to: window.to },
    unavailableReason: null,
    droppedClaims: scans.reduce((n, s) => n + s.dropped, 0),
  };
}

// --- Report B: payment allocation -------------------------------------------

export interface PaymentAllocationReadResult {
  window: DayWindow;
  report: AllocationReport | null;
  practitioners: PractitionerRef[];
  coverage: DayCoverage | null;
  unavailableReason: string | null;
  droppedPayments: number;
  /** True when the group covers more than one site. */
  multiSite: boolean;
  /** How the invoice fan-out went, for the run's own disclosure line. */
  invoicesRequested: number;
  invoicesRead: number;
  invoicesUnreadable: number;
}

/**
 * Report B. The payments read asks /v1/payments for exactly the window —
 * `start_date` and `end_date` are inclusive on `dated_on` — and pages it to
 * `meta.total`, so the set it attributes is the whole set. Unlike the takings strip
 * it cannot stop at the envelope's `total_amount`: this report has to attribute the
 * money LINE BY LINE, and `explanations[]` lives on the rows. The aggregate is the
 * right answer to "what came in"; it says nothing about who earned it.
 *
 * On top of that the allocation pass reads each settled invoice and attributes by
 * its lines (see allocation-read.ts). The window is capped first, before a single
 * request is made, because a longer one cannot be read inside one request and a
 * truncated attribution is a wrong wage.
 */
export async function readPaymentAllocation(args: {
  siteIds: readonly string[];
  window: DayWindow;
  siteId: string | null;
  /** Kept for signature parity; see readNhsBandReport. */
  now: Date;
}): Promise<PaymentAllocationReadResult> {
  const { siteIds, window, siteId } = args;
  const client = dentallyFromEnv();

  const blank = (
    practitioners: PractitionerRef[],
    unavailableReason: string,
  ): PaymentAllocationReadResult => ({
    window,
    report: null,
    practitioners,
    coverage: null,
    unavailableReason,
    droppedPayments: 0,
    multiSite: siteIds.length > 1,
    invoicesRequested: 0,
    invoicesRead: 0,
    invoicesUnreadable: 0,
  });

  if (allocationWindowTooLong(window)) return blank([], ALLOCATION_WINDOW_UNAVAILABLE);

  const [practitioners, scans] = await Promise.all([
    readPractitioners(siteIds),
    Promise.all(
      siteIds.map(async (site) => {
        try {
          const { raw, complete } = await pageAll(
            (page) =>
              client
                .listPayments({
                  siteId: dentallySiteId(site),
                  // Both edges INCLUSIVE, on `dated_on` — the bare London day the
                  // practice banked the money on. No padding needed or wanted: the
                  // edges are known, and the allocation pass spends one live invoice
                  // read per in-scope payment, so an overshoot costs real requests.
                  from: window.from,
                  to: window.to,
                  page,
                  perPage: REPORTS_PER_PAGE,
                })
                .then((res) => ({ rows: res.payments ?? [], meta: res.meta })),
            REPORTS_SCAN_MAX_PAGES,
          );
          if (!complete) {
            console.error(
              `[reports] payment read incomplete for site ${site} over ${window.from}..${window.to}; ` +
                `reporting the allocation unavailable rather than attributing a slice`,
            );
            return { rows: [] as unknown[], ok: true, complete: false };
          }
          // Rows stay RAW here: the allocation pass has its own normaliser, which
          // reads explanations[] as well. The site we asked for is authoritative
          // (live returns a Dentally uuid, not our internal key), so it is stamped
          // on before normalising — exactly as this read has always done.
          const rows = raw.map((row) =>
            row !== null && typeof row === "object" && !Array.isArray(row)
              ? { ...(row as Record<string, unknown>), site_id: site }
              : row,
          );
          return { rows, ok: true, complete: true };
        } catch (err) {
          console.error(`[reports] payment scan failed for site ${site}`, err);
          return { rows: [] as unknown[], ok: false, complete: false };
        }
      }),
    ),
  ]);

  if (scans.some((s) => !s.ok)) return blank(practitioners, SCAN_FAILED);
  if (scans.some((s) => !s.complete)) return blank(practitioners, PAYMENTS_INCOMPLETE);

  // When one site is selected, scope to it; for "all sites" the report totals the
  // group. The allocation pass reads each settled invoice and attributes by line.
  const pass = await readAllocationPass({
    rawPayments: scans.flatMap((s) => s.rows),
    window,
    siteId,
  });

  return {
    window,
    report: pass.report,
    practitioners,
    // The PAYMENTS read's own coverage, which is what this field has always meant:
    // every site answered in full for the whole window. It stays stated even when
    // the allocation pass itself declines (an over-budget invoice fan-out, a failed
    // identity) — those are different facts, each with their own reason on screen.
    coverage: { from: window.from, to: window.to },
    unavailableReason: pass.unavailableReason,
    droppedPayments: pass.droppedPayments,
    multiSite: siteIds.length > 1,
    invoicesRequested: pass.invoicesRequested,
    invoicesRead: pass.invoicesRead,
    invoicesUnreadable: pass.invoicesUnreadable,
  };
}

// --- Report C: NHS clinical completion (completed vs pending, per band) ------
//
// A SIBLING of Report A on a DIFFERENT source. Report A reads /v1/nhs_claims (the
// claim lifecycle); this reads /v1/treatment_plan_items (the clinical `completed`
// flag) — the only endpoint that can answer "band ones still pending treatment".
//
// SCANNED BY PRACTITIONER, not by site, because the item carries no site_id: the
// active-clinician roster IS the per-site scope. The scan lever is the
// practitioner_id filter, which WORKED on 2026-08-14 but 500'd on 2026-08-03, so
// it is treated as volatile — re-probed once at run time, with a documented
// whole-group-slice fallback filtered to the roster if it regresses. Either way,
// a window that cannot be read in full returns UNAVAILABLE, never a truncated
// total: the NO-COUNT-VANISHES invariant then reconciles what WAS read.
//
// COMPLETENESS IS MEASURED HERE TOO. This path never had the backwards-walk bug —
// it is narrowed by `updated_since` and windowed client-side — but it did decide it
// was finished on a short page alone, which on an index that is not date-ordered
// proves nothing. `meta.total` IS published on this endpoint, so pageAll now checks
// the walk against it and an under-read is reported unavailable like any other.

/** Which read path produced the figures — surfaced so a regression is visible. */
export type ClinicalFilterPath = "practitioner" | "group-slice";

export interface NhsClinicalReadResult {
  window: DayWindow;
  report: NhsClinicalReport | null;
  practitioners: PractitionerRef[];
  unavailableReason: string | null;
  droppedItems: number;
  /** null when the report is unavailable before a path was chosen. */
  filterPathUsed: ClinicalFilterPath | null;
}

/** Rows a single clinician's window scan may pull before it is "too large". */
const CLINICAL_PER_PRACTITIONER_MAX_PAGES = 40; // 4,000 items — covers a busy month
/** Whole-group fallback-slice page budget. A long window overflows this by design. */
const CLINICAL_GROUP_SLICE_MAX_PAGES = 80; // 8,000 items
/** Per-clinician scans in flight at once. Well under the 3,600/hour rate limit. */
const CLINICAL_SCAN_CONCURRENCY = 6;

const CLINICAL_ROSTER_UNAVAILABLE =
  "Unavailable: the clinicians for this practice could not be read, so a per-clinician completion breakdown cannot be shown honestly. This is a live read failing, not an empty practice.";

const CLINICAL_SCAN_FAILED =
  "Unavailable: a live read of the treatment records failed for a clinician in scope, so the completion totals cannot be shown honestly for the whole group.";

const CLINICAL_WINDOW_TOO_LARGE =
  "Unavailable: this period holds more treatment-plan items than a single run can read. Dentally offers no server-side band or completion filter on this endpoint, so a long window is paged live and this one either ran past the page budget or came back with fewer rows than Dentally says exist. Choose a shorter period.";

const CLINICAL_IDENTITY_UNAVAILABLE =
  "Unavailable: this run's item counts did not reconcile — the band cells plus the excluded rows did not add back up to the items scanned. A total that does not reconcile is not shown.";

/** Run `work` over `items`, at most `limit` at a time. Rejects if any work rejects. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One treatment_plan_items page, retried exactly once on a transient failure. */
async function itemsPageOnce(
  client: ReturnType<typeof dentallyFromEnv>,
  args: { practitionerId?: string; updatedSince: string; page: number },
): Promise<{ rows: unknown[]; meta: unknown }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.listTreatmentPlanItemsByPractitioner({
        practitionerId: args.practitionerId,
        updatedSince: args.updatedSince,
        page: args.page,
        perPage: REPORTS_PER_PAGE,
      });
      return { rows: res.treatment_plan_items ?? [], meta: res.meta };
    } catch (err) {
      if (attempt === 0) continue;
      throw err;
    }
  }
  return { rows: [], meta: null };
}

/**
 * Page ONE clinician's window (per_page=100) to Dentally's own `meta.total` or the
 * budget. `incomplete` true means rows were missing — the caller must not total a
 * partial scan, so it returns the window UNAVAILABLE instead.
 */
async function pagePractitioner(
  client: ReturnType<typeof dentallyFromEnv>,
  practitionerId: string,
  updatedSince: string,
): Promise<{ raw: unknown[]; incomplete: boolean }> {
  const read = await pageAll(
    (page) => itemsPageOnce(client, { practitionerId, updatedSince, page }),
    CLINICAL_PER_PRACTITIONER_MAX_PAGES,
  );
  return { raw: read.raw, incomplete: !read.complete };
}

/**
 * Probe the practitioner_id filter ONCE (the volatility guard). Returns "ok" when
 * it works, "regressed" when it 500s as it did on 2026-08-03, or "failed" for any
 * other error after a retry (a genuine read failure, surfaced loudly rather than
 * silently degraded).
 */
async function probePractitionerFilter(
  client: ReturnType<typeof dentallyFromEnv>,
  practitionerId: string,
  updatedSince: string,
): Promise<"ok" | "regressed" | "failed"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.listTreatmentPlanItemsByPractitioner({
        practitionerId,
        updatedSince,
        page: 1,
        perPage: 1,
      });
      return "ok";
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 500) return "regressed";
      if (attempt === 0) continue;
      console.error("[reports] clinical practitioner-filter probe failed", err);
      return "failed";
    }
  }
  return "failed";
}

/**
 * Report C. Reads the clinical completed/pending signal per clinician × band over
 * the window, choosing the practitioner-filter path when it works and the
 * whole-group-slice fallback when it has regressed.
 */
export async function readNhsClinicalReport(args: {
  siteIds: readonly string[];
  window: DayWindow;
  now: Date;
}): Promise<NhsClinicalReadResult> {
  const { siteIds, window } = args;
  const client = dentallyFromEnv();
  const practitioners = await readPractitioners(siteIds);

  const empty = (unavailableReason: string | null, filterPathUsed: ClinicalFilterPath | null) => ({
    window,
    report: null as NhsClinicalReport | null,
    practitioners,
    unavailableReason,
    droppedItems: 0,
    filterPathUsed,
  });

  // An empty roster on a non-empty scope is a FAILED read, not an empty practice —
  // never a confident "0 courses". readPractitioners logs the underlying error.
  if (practitioners.length === 0) {
    if (siteIds.length > 0) return empty(CLINICAL_ROSTER_UNAVAILABLE, null);
    return empty(null, null); // genuinely no scope in view
  }

  const finalize = (
    raw: readonly unknown[],
    filterPathUsed: ClinicalFilterPath,
  ): NhsClinicalReadResult => {
    const report = computeNhsClinicalReport({ items: raw, window });
    if (!report.balanced) {
      console.error("[reports] clinical identity failed", {
        totalItemsScanned: report.totalItemsScanned,
        completed: report.grandTotal.completed.items,
        pending: report.grandTotal.pending.items,
      });
      return { ...empty(CLINICAL_IDENTITY_UNAVAILABLE, filterPathUsed) };
    }
    return {
      window,
      report,
      practitioners,
      unavailableReason: null,
      droppedItems: report.droppedUnreadable,
      filterPathUsed,
    };
  };

  const probe = await probePractitionerFilter(client, practitioners[0].id, window.from);
  if (probe === "failed") return empty(CLINICAL_SCAN_FAILED, null);

  if (probe === "ok") {
    // PRIMARY: cheap per-clinician, date-bounded fan-out.
    try {
      const results = await mapWithConcurrency(practitioners, CLINICAL_SCAN_CONCURRENCY, (p) =>
        pagePractitioner(client, p.id, window.from),
      );
      if (results.some((r) => r.incomplete)) return empty(CLINICAL_WINDOW_TOO_LARGE, "practitioner");
      return finalize(results.flatMap((r) => r.raw), "practitioner");
    } catch (err) {
      console.error("[reports] clinical per-practitioner scan failed", err);
      return empty(CLINICAL_SCAN_FAILED, "practitioner");
    }
  }

  // FALLBACK (probe === "regressed"): pull the whole-group updated_since slice and
  // filter it to the roster client-side. It must be read IN FULL — a slice cut off
  // by the budget, or short of meta.total, might miss a roster row, so an incomplete
  // slice is UNAVAILABLE.
  try {
    const rosterIds = new Set(practitioners.map((p) => p.id));
    const slice = await pageAll(
      (page) => itemsPageOnce(client, { updatedSince: window.from, page }),
      CLINICAL_GROUP_SLICE_MAX_PAGES,
    );
    if (!slice.complete) return empty(CLINICAL_WINDOW_TOO_LARGE, "group-slice");
    const filtered = slice.raw.filter((row) => {
      const pid = (row as Record<string, unknown>)?.["practitioner_id"];
      const id = typeof pid === "string" ? pid : typeof pid === "number" ? String(pid) : null;
      return id !== null && rosterIds.has(id);
    });
    return finalize(filtered, "group-slice");
  } catch (err) {
    console.error("[reports] clinical group-slice fallback failed", err);
    return empty(CLINICAL_SCAN_FAILED, "group-slice");
  }
}
