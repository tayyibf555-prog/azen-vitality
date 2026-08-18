import "server-only";
import { dentallyFromEnv, cachedRead, writeDisplayCache } from "@/lib/dentally/read";
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

async function scanPatients(siteIds: readonly string[]): Promise<DashboardPatient[] | null> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE });
          const rows = res.patients ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) break;
        }
        return normalisePatients(raw).rows.map((p) => ({ ...p, siteId }));
      } catch (err) {
        console.error(`[dashboard] patient scan failed for site ${siteId}`, err);
        return null;
      }
    }),
  );
  if (perSite.some((s) => s === null)) return null;
  return perSite.flatMap((s) => s ?? []);
}

async function scanPlans(siteIds: readonly string[]): Promise<DashboardTreatmentPlan[] | null> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listTreatmentPlans({
            siteId: dentallySiteId(siteId),
            page,
            perPage: PER_PAGE,
          });
          const rows = res.treatment_plans ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) break;
        }
        return normaliseTreatmentPlans(raw).rows.map((p) => ({ ...p, siteId }));
      } catch (err) {
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
    console.error("[dashboard] invoice scan failed", err);
    return { invoices: null, undated: 0, balances: null, droppedBalances: 0 };
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
  return cachedRead(
    args.clientId,
    DASHBOARD_CACHE_KEY,
    () => buildPracticeDashboard(args),
    DASHBOARD_TTL_MS,
  );
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
const DASHBOARD_TTL_MS = 60_000;

/**
 * PRE-WARM the practice dashboard for one client: recompute it fresh (a true cold
 * assembly, bypassing the read path) and stamp it into L2 under DASHBOARD_CACHE_KEY
 * with `ttlMs`. `clientId` is the tenancy key, so the pre-warm can only ever write
 * this client's own row. Called only by the pre-warm cron; a no-op when the cache is
 * disabled (VITEST default), because writeDisplayCache is.
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

  // Independent reads, so one slow endpoint does not stack behind another and a
  // dead one costs only its own panel.
  const [payments, appointments, claims, patients, plans, invoiceScan] = await Promise.all([
    scanPayments(siteIds, today),
    scanAppointments(siteIds, today, practitionersP),
    scanClaims(siteIds, today, contractStart),
    scanPatients(siteIds),
    scanPlans(siteIds),
    scanInvoices(),
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
    plans,
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
