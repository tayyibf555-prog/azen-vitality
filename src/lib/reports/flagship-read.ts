import "server-only";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { dentallySiteId } from "@/lib/mock/clients";
import {
  isDayKey,
  londonDayOfIso,
  londonToday,
  coversWindow,
  type DayCoverage,
  type DayWindow,
} from "@/lib/dashboard/period";
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
import { intersectCoverage, scanBackwards, REPORTS_PER_PAGE } from "@/lib/reports/scan";

// ---------------------------------------------------------------------------
// The server read for the two flagship reports.
//
// Both sources (nhs_claims, payments) are the same date-unfilterable, newest-first
// endpoints the dashboard reads, so both are assembled by paging each site
// backwards to the window's first day and reporting how far the scan reached. A
// window a scan could not fully cover is reported UNAVAILABLE with a reason — the
// report she pays dentists from must never show a total quietly missing its first
// days. One dead site fails the whole scope, on the same all-or-nothing reasoning
// the takings strip uses: a group total silently missing a site is worse than a
// blank one.
// ---------------------------------------------------------------------------

export interface PractitionerRef {
  id: string;
  name: string;
}

const SCAN_UNAVAILABLE =
  "Unavailable: the live scan did not reach the start of this period. Dentally does not filter these endpoints by date, so a long window is served by paging back from today, and this one ran past the page budget. Choose a shorter period.";

const SCAN_FAILED =
  "Unavailable: a live read failed for one of the sites in scope, so the total cannot be shown honestly for the whole group.";

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

export async function readNhsBandReport(args: {
  siteIds: readonly string[];
  window: DayWindow;
  now: Date;
}): Promise<NhsBandReadResult> {
  const { siteIds, window } = args;
  const today = londonToday(args.now);
  const client = dentallyFromEnv();

  const [practitioners, scans] = await Promise.all([
    readPractitioners(siteIds),
    Promise.all(
      siteIds.map(async (siteId) => {
        try {
          const { raw, coverage } = await scanBackwards(
            (page) =>
              client
                .listNhsClaims({ siteId: dentallySiteId(siteId), page, perPage: REPORTS_PER_PAGE })
                .then((res) => res.nhs_claims ?? []),
            (row) => {
              const v = (row as Record<string, unknown>)?.["submitted_date"];
              return isDayKey(v) ? v : londonDayOfIso(v);
            },
            window.from,
            today,
          );
          const { rows, dropped } = normaliseReportNhsClaims(raw);
          return { rows: rows.map((c) => ({ ...c, siteId })), coverage, dropped, ok: true };
        } catch (err) {
          console.error(`[reports] NHS claim scan failed for site ${siteId}`, err);
          return { rows: [], coverage: null as DayCoverage | null, dropped: 0, ok: false };
        }
      }),
    ),
  ]);

  if (scans.some((s) => !s.ok)) {
    return { window, report: null, practitioners, coverage: null, unavailableReason: SCAN_FAILED, droppedClaims: 0 };
  }

  const coverage = scans.reduce<DayCoverage | null>(
    (acc, s, i) => (i === 0 ? s.coverage : intersectCoverage(acc, s.coverage)),
    null,
  );
  if (!coversWindow(coverage, window)) {
    return { window, report: null, practitioners, coverage, unavailableReason: SCAN_UNAVAILABLE, droppedClaims: 0 };
  }

  const claims = scans.flatMap((s) => s.rows);
  const report = computeNhsBandReport({ claims, window });
  return {
    window,
    report,
    practitioners,
    coverage,
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
 * Report B. The payments scan is unchanged — the same backwards paging and the
 * same all-or-nothing coverage discipline as Report A, with both SCAN_* reasons
 * byte-identical. On top of it, the allocation pass reads each settled invoice and
 * attributes the money by its LINES (see allocation-read.ts). The window is capped
 * first, before a single request is made, because a longer one cannot be read
 * inside one request and a truncated attribution is a wrong wage.
 */
export async function readPaymentAllocation(args: {
  siteIds: readonly string[];
  window: DayWindow;
  siteId: string | null;
  now: Date;
}): Promise<PaymentAllocationReadResult> {
  const { siteIds, window, siteId } = args;
  const today = londonToday(args.now);
  const client = dentallyFromEnv();

  if (allocationWindowTooLong(window)) {
    return {
      window,
      report: null,
      practitioners: [],
      coverage: null,
      unavailableReason: ALLOCATION_WINDOW_UNAVAILABLE,
      droppedPayments: 0,
      multiSite: siteIds.length > 1,
      invoicesRequested: 0,
      invoicesRead: 0,
      invoicesUnreadable: 0,
    };
  }

  const [practitioners, scans] = await Promise.all([
    readPractitioners(siteIds),
    Promise.all(
      siteIds.map(async (site) => {
        try {
          const { raw, coverage } = await scanBackwards(
            (page) =>
              client
                .listPayments({ siteId: dentallySiteId(site), page, perPage: REPORTS_PER_PAGE })
                .then((res) => res.payments ?? []),
            (row) => {
              const v = (row as Record<string, unknown>)?.["dated_on"];
              return isDayKey(v) ? v : null;
            },
            window.from,
            today,
          );
          // Rows stay RAW here: the allocation pass has its own normaliser, which
          // reads explanations[] as well. The site we asked for is authoritative
          // (live returns a Dentally uuid, not our internal key), so it is stamped
          // on before normalising — exactly as this read has always done.
          const rows = raw.map((row) =>
            row !== null && typeof row === "object" && !Array.isArray(row)
              ? { ...(row as Record<string, unknown>), site_id: site }
              : row,
          );
          return { rows, coverage, ok: true };
        } catch (err) {
          console.error(`[reports] payment scan failed for site ${site}`, err);
          return { rows: [] as unknown[], coverage: null as DayCoverage | null, ok: false };
        }
      }),
    ),
  ]);

  if (scans.some((s) => !s.ok)) {
    return {
      window,
      report: null,
      practitioners,
      coverage: null,
      unavailableReason: SCAN_FAILED,
      droppedPayments: 0,
      multiSite: siteIds.length > 1,
      invoicesRequested: 0,
      invoicesRead: 0,
      invoicesUnreadable: 0,
    };
  }

  const coverage = scans.reduce<DayCoverage | null>(
    (acc, s, i) => (i === 0 ? s.coverage : intersectCoverage(acc, s.coverage)),
    null,
  );
  if (!coversWindow(coverage, window)) {
    return {
      window,
      report: null,
      practitioners,
      coverage,
      unavailableReason: SCAN_UNAVAILABLE,
      droppedPayments: 0,
      multiSite: siteIds.length > 1,
      invoicesRequested: 0,
      invoicesRead: 0,
      invoicesUnreadable: 0,
    };
  }

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
    coverage,
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
  "Unavailable: this period holds more treatment-plan items than a single run can read. Dentally serves this endpoint newest-first with no server-side band or completion filter, so a long window is paged live and this one ran past the page budget. Choose a shorter period.";

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
): Promise<unknown[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.listTreatmentPlanItemsByPractitioner({
        practitionerId: args.practitionerId,
        updatedSince: args.updatedSince,
        page: args.page,
        perPage: REPORTS_PER_PAGE,
      });
      return res.treatment_plan_items ?? [];
    } catch (err) {
      if (attempt === 0) continue;
      throw err;
    }
  }
  return [];
}

/**
 * Page ONE clinician's window (per_page=100) until a short page or the budget.
 * `overBudget` true means more rows remained — the caller must not total a
 * truncated scan, so it returns the window UNAVAILABLE instead.
 */
async function pagePractitioner(
  client: ReturnType<typeof dentallyFromEnv>,
  practitionerId: string,
  updatedSince: string,
): Promise<{ raw: unknown[]; overBudget: boolean }> {
  const raw: unknown[] = [];
  for (let page = 1; page <= CLINICAL_PER_PRACTITIONER_MAX_PAGES; page += 1) {
    const rows = await itemsPageOnce(client, { practitionerId, updatedSince, page });
    raw.push(...rows);
    if (rows.length < REPORTS_PER_PAGE) return { raw, overBudget: false };
  }
  return { raw, overBudget: true };
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
      if (results.some((r) => r.overBudget)) return empty(CLINICAL_WINDOW_TOO_LARGE, "practitioner");
      return finalize(results.flatMap((r) => r.raw), "practitioner");
    } catch (err) {
      console.error("[reports] clinical per-practitioner scan failed", err);
      return empty(CLINICAL_SCAN_FAILED, "practitioner");
    }
  }

  // FALLBACK (probe === "regressed"): pull the whole-group updated_since slice and
  // filter it to the roster client-side. It must be read IN FULL — a slice cut off
  // by the budget might miss a roster row, so an over-budget slice is UNAVAILABLE.
  try {
    const rosterIds = new Set(practitioners.map((p) => p.id));
    const raw: unknown[] = [];
    let overBudget = true;
    for (let page = 1; page <= CLINICAL_GROUP_SLICE_MAX_PAGES; page += 1) {
      const rows = await itemsPageOnce(client, { updatedSince: window.from, page });
      raw.push(...rows);
      if (rows.length < REPORTS_PER_PAGE) {
        overBudget = false;
        break;
      }
    }
    if (overBudget) return empty(CLINICAL_WINDOW_TOO_LARGE, "group-slice");
    const filtered = raw.filter((row) => {
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
