import "server-only";
import { dentallyFromEnv, cachedRead, writeDisplayCache } from "@/lib/dentally/read";
import { DentallyBudgetExceededError, rethrowIfBudgetRefused } from "@/lib/dentally/client";
import { dentallySiteId, getSites } from "@/lib/mock/clients";
import { configuredUdaTargets } from "@/lib/dashboard/contract";
import {
  normaliseAccountBalances,
  normaliseAppointments,
  normaliseNhsClaims,
  normalisePatients,
  normalisePayments,
  normaliseTreatmentPlans,
  type DashboardAccountBalance,
  type DashboardAppointment,
  type DashboardNhsClaim,
  type DashboardPatient,
  type DashboardPayment,
  type DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import {
  isDayKey,
  londonDayOfIso,
  londonToday,
  shiftDayKey,
  type DayCoverage,
} from "@/lib/dashboard/period";
import { nhsContractYear } from "@/lib/dashboard/uda";
import { getPatientCounts } from "@/lib/patient-count/repository";
import {
  buildDashboardView,
  type AppointmentSource,
  type DashboardInvoice,
  type PracticeDashboardView,
  type PractitionerRef,
} from "@/lib/dashboard/view";

// ---------------------------------------------------------------------------
// Fetching everything the practice-manager dashboard renders.
//
// The one thing shaping this file is that Dentally IGNORES every date filter on
// /v1/payments and /v1/nhs_claims and returns both newest first. There is no way
// to ask it for "last 30 days of takings". The only honest method is to page
// from today backwards and stop once past the boundary, and the only honest way
// to report a scan that ran out of budget first is to say how far back it
// genuinely reached and let the aggregator blank anything longer.
//
// So every scan here returns a COVERAGE span alongside its rows, and a scan that
// truncated narrows its own coverage rather than handing back a short set that
// looks complete. Nothing in this file ever returns an empty array to stand in
// for a failed read: a failure returns null, which the view renders as
// unavailable with a reason.
//
// Everything is best effort and independent, so one dead endpoint costs its own
// panel and not the page.
//
// WITH ONE EXCEPTION, AND IT IS NOT AN UPSTREAM FAILURE. A read the shared budget
// guard REFUSED (DentallyBudgetExceededError, src/lib/dentally/budget.ts) is not
// best-effort material: it is the platform declining to spend the practice's quota,
// and every scan below is refused at the same instant, so absorbing it produces a
// uniformly blank assembly rather than one blank panel. That blank was then stamped
// into the shared L2 cache as a fresh 15-minute answer ON TOP of the perfectly good
// value that cache was serving a moment earlier - both by the pre-warm cron and by a
// reader's own stale-while-revalidate refresh. Measured on the local mock: with
// budget available the assembly sources every period of the takings strip (today
// 873154 pence, last 90 days 74435269) and names the practice's practitioners; with
// background exhausted the SAME assembly gave a null total, "Takings unavailable for
// this period." on every period and no practitioners at all - and THAT is what got
// stamped over the good value, with a fresh fifteen-minute expiry.
// src/lib/dashboard/budget-refusal-not-cached.test.ts holds both halves.
//
// So a refusal PROPAGATES out of every scan here and out of buildPracticeDashboard.
// Both promote paths then skip: prewarmPracticeDashboard never reaches its write, and
// display-cache's scheduleRefresh catch declines to promote, so the good stale row
// survives untouched and keeps being served. A genuine Dentally failure still
// degrades to the unavailable panel exactly as before - the only behaviour that
// changes is the refusal's. The precedent is src/lib/reports/allocation-read.ts,
// which already branches on this error class for the same reason at the other end
// (a refusal must not be retried; here, a refusal must not be cached).
// ---------------------------------------------------------------------------

const PER_PAGE = 100;

/** Page budget per site for the newest-first scans. 100 rows a page, so 40 pages
 *  is 4,000 rows per site, the same bound the outstanding-invoice scan uses. */
const SCAN_MAX_PAGES = 40;

/** The longest window the strip asks for. */
const HISTORY_DAYS = 90;

/** The narrower of two coverage spans; null when either is null. */
function intersectCoverage(a: DayCoverage | null, b: DayCoverage | null): DayCoverage | null {
  if (a === null || b === null) return null;
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

/**
 * Page a newest-first, unfilterable endpoint backwards until the boundary day is
 * passed, and report how far back the scan actually got.
 *
 * `dayOf` reads the row's own day. A page budget exhausted on full pages means
 * the scan stopped mid-history: coverage then starts the day AFTER the oldest
 * row seen, because the oldest day itself may be half collected and half totalled
 * is worse than not totalled.
 */
async function scanBackwards(
  fetchPage: (page: number) => Promise<unknown[]>,
  dayOf: (raw: unknown) => string | null,
  boundaryDay: string,
  today: string,
): Promise<{ raw: unknown[]; coverage: DayCoverage | null }> {
  const raw: unknown[] = [];
  let oldestSeen: string | null = null;
  let exhausted = false;
  let passedBoundary = false;

  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const rows = await fetchPage(page);
    raw.push(...rows);
    for (const row of rows) {
      const day = dayOf(row);
      if (day === null) continue;
      if (oldestSeen === null || day < oldestSeen) oldestSeen = day;
    }
    if (rows.length < PER_PAGE) {
      exhausted = true;
      break;
    }
    if (oldestSeen !== null && oldestSeen < boundaryDay) {
      passedBoundary = true;
      break;
    }
  }

  // Ran out of data, or walked past the boundary: everything back to the
  // boundary is genuinely covered.
  if (exhausted || passedBoundary) return { raw, coverage: { from: boundaryDay, to: today } };
  // Budget exhausted mid-history.
  if (oldestSeen === null) return { raw, coverage: null };
  const from = shiftDayKey(oldestSeen, 1);
  if (from === null || from > today) return { raw, coverage: null };
  return { raw, coverage: { from, to: today } };
}

// --- Payments ---------------------------------------------------------------

async function scanPayments(
  siteIds: readonly string[],
  today: string,
): Promise<{ rows: DashboardPayment[]; coverage: DayCoverage | null; dropped: number }> {
  const client = dentallyFromEnv();
  const boundary = shiftDayKey(today, -(HISTORY_DAYS - 1)) ?? today;

  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const { raw, coverage } = await scanBackwards(
          (page) =>
            client
              .listPayments({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE })
              .then((res) => res.payments ?? []),
          (row) => {
            const value = (row as Record<string, unknown>)?.["dated_on"];
            return isDayKey(value) ? value : null;
          },
          boundary,
          today,
        );
        const { rows, dropped } = normalisePayments(raw);
        // The site we ASKED for is authoritative: on live, site_id comes back as a
        // Dentally uuid, and every other panel keys on our internal site id.
        return { rows: rows.map((r) => ({ ...r, siteId })), coverage, dropped };
      } catch (err) {
        // A REFUSAL IS NOT A FAILED SCAN. See the header: it propagates so no cache
        // promote can stamp a blank period over the good value already being served.
        rethrowIfBudgetRefused(err);
        console.error(`[dashboard] payments scan failed for site ${siteId}`, err);
        return { rows: [] as DashboardPayment[], coverage: null, dropped: 0 };
      }
    }),
  );

  return {
    rows: perSite.flatMap((s) => s.rows),
    // The group is only covered as far back as its WORST covered site: one site
    // missing a fortnight would otherwise understate the group total in silence.
    coverage: perSite.reduce<DayCoverage | null>(
      (acc, s, i) => (i === 0 ? s.coverage : intersectCoverage(acc, s.coverage)),
      null,
    ),
    dropped: perSite.reduce((n, s) => n + s.dropped, 0),
  };
}

// --- Appointments -----------------------------------------------------------

interface AppointmentScan {
  normalised: DashboardAppointment[] | null;
  rows: AppointmentSource[];
  coverage: DayCoverage | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toAppointmentSource(
  raw: unknown,
  siteId: string,
  practitionerNameById: ReadonlyMap<string, string>,
): AppointmentSource | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r["id"]);
  const startIso = str(r["start_time"]);
  if (id === null || startIso === null) return null;
  const practitionerId = str(r["practitioner_id"]);
  const durationRaw = r["duration"];
  return {
    id,
    startIso,
    durationMin: typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : null,
    patientId: str(r["patient_id"]),
    patientName: str(r["patient_name"]),
    siteId,
    practitionerId,
    practitionerName:
      str(r["practitioner"]) ??
      (practitionerId === null ? null : practitionerNameById.get(practitionerId) ?? null),
    reason: str(r["reason"]),
    // Field name unverified against live Dentally. Read defensively: an absent
    // note renders as no note, never as an empty line.
    note: str(r["notes"]) ?? str(r["note"]),
    state: typeof r["state"] === "string" ? r["state"] : "",
  };
}

async function scanAppointments(
  siteIds: readonly string[],
  today: string,
  practitionersP: Promise<PractitionerRef[]>,
): Promise<AppointmentScan> {
  const client = dentallyFromEnv();
  const from = shiftDayKey(today, -(HISTORY_DAYS - 1)) ?? today;

  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        let truncated = true;
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listAppointments({
            siteId: dentallySiteId(siteId),
            fromDate: from,
            toDate: today,
            page,
            perPage: PER_PAGE,
          });
          const rows = res.appointments ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) {
            truncated = false;
            break;
          }
        }
        if (truncated) {
          // A window scan cannot be narrowed honestly: the API returns the range,
          // not a day-ordered stream, so a truncated read leaves unknown holes.
          console.error(`[dashboard] appointment scan truncated for site ${siteId}`);
          return { raw: [] as unknown[], siteId, ok: false };
        }
        return { raw, siteId, ok: true };
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed scan; see the header
        console.error(`[dashboard] appointment scan failed for site ${siteId}`, err);
        return { raw: [] as unknown[], siteId, ok: false };
      }
    }),
  );

  if (perSite.some((s) => !s.ok)) {
    return { normalised: null, rows: [], coverage: null };
  }

  // The practitioner read was started ALONGSIDE this scan, not before it, and its
  // names are only needed now — to fill an appointment row that did not carry its
  // practitioner's name inline. Awaiting the promise here, after the appointment
  // paging, overlaps the two reads instead of serialising the whole dashboard
  // behind the practitioner read. The name map is otherwise built and used exactly
  // as before, so every row resolves the same name it did when the map was passed
  // in ready-made.
  const practitionerNameById = new Map((await practitionersP).map((p) => [p.id, p.name]));

  const normalised: DashboardAppointment[] = [];
  const rows: AppointmentSource[] = [];
  for (const site of perSite) {
    const batch = normaliseAppointments(site.raw);
    normalised.push(...batch.rows.map((a) => ({ ...a, siteId: site.siteId })));
    for (const raw of site.raw) {
      const row = toAppointmentSource(raw, site.siteId, practitionerNameById);
      if (row !== null) rows.push(row);
    }
  }
  return { normalised, rows, coverage: { from, to: today } };
}

// --- NHS claims -------------------------------------------------------------

async function scanClaims(
  siteIds: readonly string[],
  today: string,
  contractStart: string,
): Promise<{ rows: DashboardNhsClaim[] | null; dropped: number }> {
  const client = dentallyFromEnv();

  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const { raw, coverage } = await scanBackwards(
          (page) =>
            client
              .listNhsClaims({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE })
              .then((res) => res.nhs_claims ?? []),
          (row) => {
            const value = (row as Record<string, unknown>)?.["submitted_date"];
            return isDayKey(value) ? value : londonDayOfIso(value);
          },
          contractStart,
          today,
        );
        // The UDA figures are measured against the whole contract year. A scan that
        // did not reach 1 April cannot state them, so the panel says so rather than
        // reporting a total that is quietly missing its first months.
        if (coverage === null || coverage.from > contractStart) {
          console.error(`[dashboard] NHS claim scan did not reach the contract year for ${siteId}`);
          return { rows: null, dropped: 0 };
        }
        const { rows, dropped } = normaliseNhsClaims(raw);
        return { rows: rows.map((c) => ({ ...c, siteId })), dropped };
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed scan; see the header
        console.error(`[dashboard] NHS claim scan failed for site ${siteId}`, err);
        return { rows: null, dropped: 0 };
      }
    }),
  );

  if (perSite.some((s) => s.rows === null)) return { rows: null, dropped: 0 };
  return {
    rows: perSite.flatMap((s) => s.rows ?? []),
    dropped: perSite.reduce((n, s) => n + s.dropped, 0),
  };
}

// --- Patients and treatment plans -------------------------------------------

/**
 * Patients, NARROWED to the window with `updated_after`.
 *
 * WHAT THIS SCAN IS FOR. Exactly one figure on the screen comes from it: how many
 * patients REGISTERED in the selected period (at most the 90 days HISTORY_DAYS
 * covers). `updated_after` is a sound superset for that question — a patient
 * created on or after `from` cannot have an updated_at before `from` — so the
 * client-side `createdDay in window` filter downstream returns exactly the same
 * set it did when the whole book was paged. The "seen" figure comes from the
 * appointment scan, not this one.
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS WRONG. It paged the ENTIRE patient book per
 * site, unfiltered, bounded at SCAN_MAX_PAGES. On this practice — ~51,000 patients
 * across three sites — that is ~170 pages a site of which it read 40, and it then
 * counted registration dates AND active flags over the 4,000 rows it happened to
 * reach and printed both as fact. The rows are not date-ordered, so the "new
 * patients" figure was a count over an arbitrary quarter of one site's book, and
 * "active patients" was a fraction of the truth rendered as the truth. It also cost
 * 120 upstream requests every time the dashboard was assembled, for one number.
 *
 * TRUNCATION IS NOW REPORTED, NOT ABSORBED. If even the narrowed scan exhausts its
 * page budget the site returns null and the panel says the count is unavailable.
 * A short count on a takings screen is acted on; a stated gap is questioned.
 */
async function scanPatients(
  siteIds: readonly string[],
  today: string,
): Promise<DashboardPatient[] | null> {
  const client = dentallyFromEnv();
  const from = shiftDayKey(today, -(HISTORY_DAYS - 1)) ?? today;
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        let truncated = true;
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listPatients({
            siteId: dentallySiteId(siteId),
            updatedAfter: from,
            page,
            perPage: PER_PAGE,
          });
          const rows = res.patients ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) {
            truncated = false;
            break;
          }
        }
        if (truncated) {
          console.error(
            `[dashboard] patient scan truncated for site ${siteId} at ${SCAN_MAX_PAGES} pages; ` +
              `reporting the patient counts unavailable rather than counting a partial book`,
          );
          return null;
        }
        return normalisePatients(raw).rows.map((p) => ({ ...p, siteId }));
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed scan; see the header
        console.error(`[dashboard] patient scan failed for site ${siteId}`, err);
        return null;
      }
    }),
  );
  if (perSite.some((s) => s === null)) return null;
  return perSite.flatMap((s) => s ?? []);
}

/**
 * Treatment plans, NARROWED to the window with `updated_after`.
 *
 * The panel shows three figures: plans STARTED in the period, plans FINISHED in the
 * period, and plans left OPEN. The first two are window questions and `updated_after
 * = window start` is a sound superset for both — a plan that started or finished
 * inside the window was necessarily written inside it. OPEN is not a window
 * question: a plan opened three years ago and never closed is still open today and
 * has not been touched since, so it is not in this set. That is why the caller
 * passes `plansWindowed` to the view, which then reports OPEN unavailable.
 *
 * IT IS ALSO WHAT THE FIGURES DESERVE. Unfiltered, this scan paged the practice's
 * whole plan index — on the order of 85,000 rows (see the retired /api/sync/dentally
 * route, which failed for the same reason) — bounded at 40 pages, and Dentally's
 * plan index is NOT date-ordered. All three figures were therefore computed over an
 * arbitrary ~5% slice and printed as fact, at a cost of 120 upstream requests per
 * dashboard assembly. A stated gap on OPEN and exact numbers on the other two is
 * strictly more truthful than three confident numbers that were none of them right.
 */
async function scanPlans(
  siteIds: readonly string[],
  today: string,
): Promise<DashboardTreatmentPlan[] | null> {
  const client = dentallyFromEnv();
  const from = shiftDayKey(today, -(HISTORY_DAYS - 1)) ?? today;
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        let truncated = true;
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listTreatmentPlans({
            siteId: dentallySiteId(siteId),
            updatedAfter: from,
            page,
            perPage: PER_PAGE,
          });
          const rows = res.treatment_plans ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) {
            truncated = false;
            break;
          }
        }
        if (truncated) {
          console.error(
            `[dashboard] treatment plan scan truncated for site ${siteId} at ${SCAN_MAX_PAGES} pages; ` +
              `reporting the plan counts unavailable rather than counting a partial index`,
          );
          return null;
        }
        return normaliseTreatmentPlans(raw).rows.map((p) => ({ ...p, siteId }));
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed scan; see the header
        console.error(`[dashboard] treatment plan scan failed for site ${siteId}`, err);
        return null;
      }
    }),
  );
  if (perSite.some((s) => s === null)) return null;
  return perSite.flatMap((s) => s ?? []);
}

// --- Invoices: the INVOICED panel and the ACCOUNTS ranking ------------------

interface InvoiceScan {
  invoices: DashboardInvoice[] | null;
  undated: number;
  balances: DashboardAccountBalance[] | null;
  droppedBalances: number;
}

function invoiceDay(r: Record<string, unknown>): string | null {
  for (const key of ["date", "created_at", "issued_at", "dated_on"]) {
    const value = r[key];
    const day = isDayKey(value) ? value : londonDayOfIso(value);
    if (day !== null) return day;
  }
  return null;
}

function pence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  return null;
}

/**
 * One scan of the invoice index serves both panels: INVOICED totals what was
 * billed in the window, ACCOUNTS ranks who still owes. Real Dentally may ignore
 * site_id here and return the whole group per site, so this scans ONCE, unscoped,
 * and attributes to a site through the patient.
 */
async function scanInvoices(): Promise<InvoiceScan> {
  const client = dentallyFromEnv();
  try {
    const raw: unknown[] = [];
    for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
      const res = await client.listInvoices({ page, perPage: PER_PAGE });
      const rows = res.invoices ?? [];
      raw.push(...rows);
      if (rows.length < PER_PAGE) break;
    }

    const invoices: DashboardInvoice[] = [];
    let undated = 0;
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = str(r["id"]);
      const grossPence = pence(r["amount"] ?? r["total"] ?? r["gross"]);
      const outstandingPence = pence(r["amount_outstanding"] ?? r["outstanding"]);
      if (id === null || grossPence === null || outstandingPence === null) continue;
      const day = invoiceDay(r);
      if (day === null) {
        undated += 1;
        continue;
      }
      invoices.push({ id, patientId: str(r["patient_id"]), day, grossPence, outstandingPence });
    }

    const balances = normaliseAccountBalances(raw);
    return {
      invoices,
      undated,
      balances: balances.rows,
      droppedBalances: balances.dropped,
    };
  } catch (err) {
    rethrowIfBudgetRefused(err); // not a failed scan; see the header
    console.error("[dashboard] invoice scan failed", err);
    return { invoices: null, undated: 0, balances: null, droppedBalances: 0 };
  }
}

// --- Active patients: the nightly whole-book count --------------------------

/**
 * ACTIVE patients per site, read from the stored nightly count, NOT from Dentally.
 *
 * /api/sync/patient-count pages the entire book off-hours (03:15, MAX_PAGES 400)
 * and writes the exact total and active figures per site. That is the only source
 * in this platform that has actually counted every patient. The dashboard's own
 * patient scan is bounded and window-narrowed and cannot answer it, so it asks the
 * count instead: zero Dentally requests, and an exact number instead of a partial
 * one.
 *
 * Best effort. A failure — or a site the nightly job has never reached — yields a
 * map without that site, and the panel says the figure is unavailable. It never
 * substitutes the partial scan's tally, because that is the number this change
 * exists to stop printing.
 */
async function readActiveCounts(
  siteIds: readonly string[],
): Promise<ReadonlyMap<string, number> | null> {
  try {
    const rows = await getPatientCounts([...siteIds]);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (Number.isFinite(row.active)) map.set(row.siteId, row.active);
    }
    return map;
  } catch (err) {
    // No rethrowIfBudgetRefused here, deliberately: this reads OUR OWN table, not
    // Dentally, so it cannot be refused by the Dentally budget and has no refusal to
    // separate out. Its failure is a genuine failure and degrades as it always did.
    console.error("[dashboard] nightly patient count read failed", err);
    return new Map<string, number>();
  }
}

// --- Practitioners ----------------------------------------------------------

async function readPractitioners(siteIds: readonly string[]): Promise<PractitionerRef[]> {
  const client = dentallyFromEnv();
  const byId = new Map<string, string>();
  await Promise.all(
    siteIds.map(async (siteId) => {
      const siteUuid = dentallySiteId(siteId);
      try {
        const res = await client.listPractitioners(siteUuid);
        for (const item of res.practitioners ?? []) {
          if (item === null || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          if (r["active"] !== true) continue;
          const id = str(r["id"]);
          if (id === null) continue;
          const user = (r["user"] && typeof r["user"] === "object" ? r["user"] : {}) as Record<string, unknown>;
          const name =
            [str(user["first_name"]), str(user["last_name"])].filter((p) => p !== null).join(" ") ||
            str(user["name"]) ||
            id;
          byId.set(id, name);
        }
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed read; see the header
        console.error(`[dashboard] practitioner read failed for site ${siteId}`, err);
      }
    }),
  );
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// --- The one entry point ----------------------------------------------------

export interface ReadDashboardArgs {
  clientId: string;
  now: Date;
}

/**
 * Everything the practice-manager dashboard renders, for every site the client
 * runs, in one serialisable object.
 *
 * Every scope is computed here rather than per navigation, because the takings
 * strip drives the panels below it and the all-sites toggle drives all of them:
 * a round trip per click on a screen read between phone calls is the wrong
 * trade, and the whole payload is a few dozen numbers per scope plus a capped
 * appointment list.
 *
 * NOT wired: the stored daily rollup (supabase/migrations/0062, unapplied). The
 * seam is the `rollups` input on buildDashboardView; until it is populated, any
 * period the live scan cannot reach reports itself unavailable rather than
 * totalling a truncated scan.
 */
export async function readPracticeDashboard(args: ReadDashboardArgs): Promise<PracticeDashboardView> {
  // Through the SHARED L2 (src/lib/dentally/display-cache.ts), not a per-instance
  // Map. The Map made this fast only on a WARM instance: under Fluid Compute a COLD
  // instance re-ran all six 90-day scans (~40s) on the practice manager's home page,
  // and every cold instance re-paid it. Keyed by clientId as the tenant, it now
  // dedups across the whole fleet AND gets stale-while-revalidate for free — an
  // expired dashboard is served instantly while it re-warms behind the response, so
  // no one waits — AND becomes pre-warmable (the cron writes this exact key). The
  // view is JSON-serialisable (it already crosses the RSC boundary to the dashboard
  // client component), so it survives the jsonb round trip; a round-trip test pins
  // that. `now` is not part of the key (the assembled figures carry their own
  // "Stats updated" stamp), matching the old Map which keyed on clientId alone.
  try {
    return await cachedRead(
      args.clientId,
      DASHBOARD_CACHE_KEY,
      () => buildPracticeDashboard(args),
      DASHBOARD_TTL_MS,
    );
  } catch (err) {
    // ONLY reachable on a TRUE COLD read (no row in either cache layer) whose
    // assembly was refused: a stale row is served without calling the assembly at
    // all, and the background refresh's own failure is swallowed inside
    // display-cache. So there is nothing better to serve and nobody's good value to
    // protect — but there is also nothing to gain from a 500 on the practice
    // manager's home page, so the refusal is turned into the honest unavailable view
    // right here, OUTSIDE the cache, and is therefore never promoted.
    //
    // The distinction the whole change rests on is preserved: buildPracticeDashboard
    // still THREW, so cachedRead never reached its promote and the L2 row (if one
    // ever appears) is not this blank.
    if (!(err instanceof DentallyBudgetExceededError)) throw err;
    console.warn(
      `[dashboard] the shared Dentally budget refused a cold assembly for ${args.clientId}; ` +
        `serving the unavailable view WITHOUT caching it, so the next read retries.`,
    );
    return refusedDashboardView(args);
  }
}

/**
 * The dashboard as it renders when the platform declined to spend the quota to
 * assemble it: every panel unavailable, with the practice's own sites and UDA targets
 * still named so the screen is recognisably theirs.
 *
 * It makes ZERO Dentally requests — it is buildDashboardView over nulls, the same
 * pure function the real assembly ends with, so an unavailable panel here is the
 * identical unavailable panel a genuine outage produces. Deliberately NOT cached by
 * any caller: see readPracticeDashboard.
 */
function refusedDashboardView(args: ReadDashboardArgs): PracticeDashboardView {
  return buildDashboardView({
    now: args.now,
    sites: getSites(args.clientId).map((s) => ({ id: s.id, name: s.name })),
    practitioners: [],
    payments: [],
    paymentsCoverage: null,
    rollups: null,
    appointments: null,
    appointmentsCoverage: null,
    appointmentRows: [],
    patients: null,
    activeCounts: null,
    plans: null,
    plansWindowed: true,
    invoices: null,
    balances: null,
    claims: null,
    udaTargets: configuredUdaTargets(),
  });
}

/**
 * The L2 key + user-facing TTL for the assembled dashboard.
 *
 * Assembling this screen is six paged scans of a source that will not filter by
 * date, so it is expensive by construction. A minute of staleness is exactly what
 * the "Stats updated" line exists to declare, so nothing is hidden by it. The
 * pre-warm writes this SAME key with a longer ttl so the row stays fresh between
 * cron runs; see prewarmPracticeDashboard.
 */
export const DASHBOARD_CACHE_KEY = "dashboard:v1";

/**
 * How long an assembled dashboard counts as FRESH — and therefore how often a
 * reader's stale-while-revalidate refresh re-pays the assembly.
 *
 * IT WAS 60 SECONDS, AND THAT WAS A TREADMILL WITH A CRON HOLDING IT STILL. An SWR
 * refresh re-stamps the row with THIS ttl, so once the pre-warm's longer stamp
 * lapsed for any reason — a skipped tick, a held lease, a disabled job — the shared
 * row expired every minute and every instance being read re-paged the practice's
 * whole book to re-stamp another minute. Sixty assemblies an hour against a
 * 3,600/hour ceiling is the ceiling. The job that emptied the quota on 2026-08-20
 * was the visible half of this; the 60-second re-arm was the trap underneath it.
 *
 * Fifteen minutes is not a freshness regression: with the pre-warm running every
 * fifteen minutes and stamping twenty, what a reader actually saw was already up to
 * fifteen minutes old. It
 * is the same picture, now stated by one constant instead of held in place by a
 * cron job. The figures carry their own "Stats updated" stamp, so the age is on the
 * screen either way, and the diary, booking availability and every write-confirming
 * read are uncached and unaffected.
 */
export const DASHBOARD_TTL_MS = 15 * 60_000;

/**
 * PRE-WARM the practice dashboard for one client: recompute it fresh (a true cold
 * assembly, bypassing the read path) and stamp it into L2 under DASHBOARD_CACHE_KEY
 * with `ttlMs`. `clientId` is the tenancy key, so the pre-warm can only ever write
 * this client's own row. Called only by the pre-warm cron; a no-op when the cache is
 * disabled (VITEST default), because writeDisplayCache is.
 *
 * IT WRITES UNCONDITIONALLY, AND THAT IS ONLY SAFE BECAUSE A REFUSAL THROWS. This
 * runs inside runWithDentallyPriority("background"), the class refused FIRST at 60%
 * of the hour, so a refused run is the NORMAL outcome of a busy hour — not an edge
 * case. While the scans absorbed the refusal, this line stamped an all-unavailable
 * dashboard over the good row with a fresh 15-minute expiry, four times a day, every
 * busy afternoon: the cache warmer blanking the screen it exists to keep fast.
 *
 * Now the assembly throws before this line is reached, the cron's allSettled records
 * the rejection, and the existing row is left exactly as it was — still served, still
 * carrying its own honest "Stats updated" stamp. There is deliberately no try/catch
 * here: an early return would be a second place to keep in step with the scans, and
 * "the write is unreachable" is a stronger guarantee than "the write is skipped".
 */
export async function prewarmPracticeDashboard(
  clientId: string,
  now: Date,
  ttlMs: number,
): Promise<void> {
  const view = await buildPracticeDashboard({ clientId, now });
  await writeDisplayCache(clientId, DASHBOARD_CACHE_KEY, view, ttlMs);
}

async function buildPracticeDashboard(args: ReadDashboardArgs): Promise<PracticeDashboardView> {
  const sites = getSites(args.clientId).map((s) => ({ id: s.id, name: s.name }));
  const siteIds = sites.map((s) => s.id);
  const today = londonToday(args.now);
  const contractStart = nhsContractYear(args.now).start;

  // The practitioner read is STARTED here but not awaited: it used to block every
  // scan below it, adding a whole round trip to the front of a cold dashboard load
  // for a read that only the appointment panel consumes. It is now handed to
  // scanAppointments as a promise and awaited there, after that panel's own paging,
  // so it overlaps the six scans instead of preceding them.
  const practitionersP = readPractitioners(siteIds);
  // MARK IT HANDLED THE INSTANT IT EXISTS. readPractitioners can now REJECT (a budget
  // refusal propagates out of it) and its first `await` is deep inside
  // scanAppointments, after that panel's own paging — many ticks later, and skipped
  // entirely when the appointment scan returns early. A rejection in that gap would
  // be reported as an unhandled rejection, which on Node is a process-level event and
  // on Vercel is a noisy log for a case the code handles perfectly well. Attaching a
  // no-op handler to a DERIVED promise marks the original handled without consuming
  // it: every `await practitionersP` below still sees the same rejection.
  void practitionersP.catch(() => {});

  // Independent reads, so one slow endpoint does not stack behind another and a
  // dead one costs only its own panel.
  const [payments, appointments, claims, patients, plans, invoiceScan, activeCounts] =
    await Promise.all([
    scanPayments(siteIds, today),
    scanAppointments(siteIds, today, practitionersP),
    scanClaims(siteIds, today, contractStart),
    scanPatients(siteIds, today),
    scanPlans(siteIds, today),
    scanInvoices(),
    readActiveCounts(siteIds),
  ]);
  const practitioners = await practitionersP;

  const siteByPatientId = new Map<string, string>();
  const patientNameById = new Map<string, string>();
  for (const p of patients ?? []) {
    if (p.siteId !== null) siteByPatientId.set(p.id, p.siteId);
  }
  // Names come from the patient list, because an invoice carries none. A patient
  // we cannot name is still ranked, and the panel links by id and says so.
  for (const row of appointments.rows) {
    if (row.patientId !== null && row.patientName !== null) {
      patientNameById.set(row.patientId, row.patientName);
    }
  }

  const balances =
    invoiceScan.balances === null
      ? null
      : invoiceScan.balances.map((b) => ({
          ...b,
          patientName: b.patientName ?? patientNameById.get(b.patientId) ?? null,
        }));

  return buildDashboardView({
    now: args.now,
    sites,
    practitioners,
    payments: payments.rows,
    paymentsCoverage: payments.coverage,
    droppedPayments: payments.dropped,
    rollups: null,
    appointments: appointments.normalised,
    appointmentsCoverage: appointments.coverage,
    appointmentRows: appointments.rows,
    patients,
    activeCounts,
    plans,
    // The plan scan is narrowed to `updated_after`, so the OPEN count is not
    // answerable from it. Stated here, once, at the seam that made it true.
    plansWindowed: true,
    invoices: invoiceScan.invoices,
    undatedInvoices: invoiceScan.undated,
    balances,
    droppedBalances: invoiceScan.droppedBalances,
    siteByPatientId,
    claims: claims.rows,
    droppedClaims: claims.dropped,
    udaTargets: configuredUdaTargets(),
  });
}
