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

/** Site's practitioners, id → display name, across every site in scope. */
async function readPractitioners(siteIds: readonly string[]): Promise<PractitionerRef[]> {
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
