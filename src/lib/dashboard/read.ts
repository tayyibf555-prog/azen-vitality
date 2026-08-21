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
  normaliseTreatmentPlans,
  type DashboardAccountBalance,
  type DashboardAppointment,
  type DashboardNhsClaim,
  type DashboardPatient,
  type DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import {
  isDayKey,
  londonDayOfIso,
  londonToday,
  periodWindow,
  shiftDayKey,
  DASHBOARD_PERIODS,
  type DashboardPeriod,
  type DayCoverage,
} from "@/lib/dashboard/period";
import { parseAggregateAmountPence } from "@/lib/dashboard/money";
import { takingsWindowKey, type TakingsWindowTotal } from "@/lib/dashboard/takings";
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
// THE FILTERS WORK. THIS FILE USED TO SAY THEY DID NOT, AND THE PRACTICE OWNER
// PAID FOR IT.
//
// What stood here was: "The one thing shaping this file is that Dentally IGNORES
// every date filter on /v1/payments and /v1/nhs_claims and returns both newest
// first ... The only honest method is to page from today backwards and stop once
// past the boundary." Every clause was wrong, and together they justified a
// forty-page-per-site walk whose results were then printed as fact. On site N15 the
// takings strip read £16,997.10 for the last 30 days against Dentally's own
// £27,240.90, and £17,012.10 for the last 90 against £114,429.78 — 38% and 85%
// short. Today and last-7 matched only by luck, because the newest payments happen
// to cluster on page 1.
//
// TWO INDEPENDENT FALSEHOODS, both fixed here, both re-probed live on 2026-08-21
// (read-only GETs; the parameter names and the arithmetic traps are written up on
// listPayments / listNhsClaims / listInvoices in src/lib/dentally/client.ts):
//
//   1. THE ROWS ARE NOT DATE-ORDERED. They are ordered by id, so a backdated
//      payment sits wherever its id falls: N15 page 1 spans 2026-08-11..21, page 20
//      spans 2023-09-14..2026-03-31, page 41 spans 2024-09-20..2025-10-16. A
//      backwards walk therefore stops early AND skips in-window rows deeper in the
//      index — and the coverage span it reported claimed the window was covered.
//
//   2. EVERY ONE OF THESE ENDPOINTS TAKES A DATE FILTER, under a DIFFERENT NAME:
//        /v1/payments      start_date / end_date   (inclusive, on dated_on)
//        /v1/nhs_claims    after / before          (on submitted_date)
//        /v1/invoices      created_after / created_before (on created_at)
//      They are not interchangeable. start_date/end_date on /v1/nhs_claims is
//      ACCEPTED and returns zero rows for every range including 2000..2030 — a trap
//      that would blank the UDA block while looking like a working filter.
//
// AND /v1/payments ANSWERS THE WHOLE QUESTION IN ITS `meta`: `total` (exact row
// count) and `total_amount` (exact decimal sum) for the filtered window. So a
// period total is ONE request with per_page=1, not a forty-page walk — see
// readTakingsWindows. That is both exact and roughly an eighth of the cost.
//
// WHAT SURVIVES. A scan that pages rows still reports how far it got, and nothing
// in this file ever returns an empty array to stand in for a failed read: a failure
// returns null, which the view renders as unavailable with a reason. Where a filter
// gives an exact expected count (`meta.total`), truncation is now DETECTED rather
// than guessed — a scan that fetched fewer rows than Dentally says exist reports
// the panel unavailable instead of totalling a slice.
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
// 873154 pence, last 90 days 75772530) and names the practice's practitioners; with
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

/**
 * THE EXACT TAKINGS READ. One request per site per period; no paging, no ordering
 * assumption, no coverage guess.
 *
 * /v1/payments takes `start_date` and `end_date` — both INCLUSIVE, both on
 * `dated_on`, the bare London calendar day the practice banked the money on — and
 * returns, in `meta`, `total` (the exact number of payments in the window) and
 * `total_amount` (their exact decimal sum). With per_page=1 that is the whole
 * answer in a single response, so "last 90 days" costs exactly what "today" costs.
 * Verified live 2026-08-21: Σ of the individual `amount` values equalled
 * meta.total_amount to the digit on five windows across two sites, and every
 * returned row's dated_on fell inside the window with both boundary days present.
 *
 * THIS IS DELIBERATELY DENTALLY'S OWN ARITHMETIC, NOT OURS. The complaint that
 * started this was "the platform's money does not match Dentally", so the strip now
 * shows the number Dentally itself computes for that window rather than a number we
 * assemble from rows and hope agrees. It also side-steps a real hazard in doing it
 * ourselves: some payments are worth a fraction of a penny (N15 payment 28647 is
 * "0.0015"), and the row-level money grammar correctly refuses to round those, so a
 * row-summed total would silently drop them.
 *
 * A REAL ZERO IS AN ANSWER. A Sunday answers total 0 / total_amount "0.0", which is
 * "no takings", not "unread" — the two are different facts and the map below only
 * omits a key for the second.
 *
 * DELETED PAYMENTS ARE NOW INSIDE THE TOTAL, AND THAT IS DELIBERATE. The row path
 * excluded `deleted: true` rows. This aggregate cannot: `deleted` is not a filterable
 * parameter on /v1/payments (deleted=true and deleted=false both return the
 * unfiltered set), so the only way to exclude them would be to go back to paging
 * every row — the thing that produced the wrong figures. It is also the wrong goal.
 * The complaint that started this was that the platform disagreed with Dentally, and
 * meta.total_amount IS Dentally's own arithmetic for the window, so matching it is
 * the point rather than a compromise. On live this is currently a distinction
 * without a difference: no `deleted: true` row appeared in ~2,000 sampled rows across
 * two sites. On the local mock, where roughly one payment in sixty is voided, it
 * moves the ninety-day figure by about 1.8% — so a dev-only total that shifts by
 * about that much on this change is expected, not a regression.
 *
 * PER SITE, NEVER PRE-SUMMED. The group cell has to be able to tell "all three
 * practices answered" from "two answered", so each site is filed under its own key
 * and computeTakingsStrip refuses to state a group total with one missing.
 */
async function readTakingsWindows(
  siteIds: readonly string[],
  now: Date,
  periods: readonly DashboardPeriod[] = DASHBOARD_PERIODS,
): Promise<{ totals: Map<string, TakingsWindowTotal>; failedSites: string[] }> {
  const client = dentallyFromEnv();
  const totals = new Map<string, TakingsWindowTotal>();
  const failedSites = new Set<string>();

  // ONE SITE AT A TIME ACROSS SITES, ONE PERIOD AT A TIME WITHIN A SITE.
  //
  // Fanning all fifteen reads out at once is the obvious shape and it is the wrong
  // one, for a reason this repo has already been bitten by: when the shared budget
  // guard refuses, every request ALREADY IN FLIGHT has spent a counter increment for
  // a request that will never be sent, and that phantom spend comes out of the
  // practice's real hourly quota (see the 2026-08-20 outage note on budget.ts, and
  // refused-read-never-promoted.test.ts, which bounds it). Sticky refusal
  // short-circuits everything AFTER the first refusal, so a narrower fan-out is a
  // strictly smaller phantom: five sequential rounds of three instead of one round of
  // fifteen. Five extra round trips on a screen cached for fifteen minutes is not a
  // cost worth trading a quota for.
  const reads = siteIds.map(async (siteId) => {
    for (const period of periods) {
      const window = periodWindow(period, now);
      try {
        const res = await client.listPayments({
          siteId: dentallySiteId(siteId),
          from: window.from,
          to: window.to,
          page: 1,
          // ONE ROW, because the rows are not what we came for. per_page cannot be
          // zero and the aggregate is in `meta` either way, so this is the cheapest
          // shape of the request that still carries the answer.
          perPage: 1,
        });
        const total = paymentsWindowTotal(res.meta);
        if (total === null) {
          // The envelope did not carry a readable aggregate. That is a failed read,
          // not an empty window, and it must not be filed as zero.
          console.error(
            `[dashboard] payments aggregate unreadable for site ${siteId} ${period} ` +
              `(${window.from}..${window.to}); reporting the period unavailable`,
          );
          failedSites.add(siteId);
          continue;
        }
        totals.set(takingsWindowKey(siteId, period), total);
      } catch (err) {
        // A REFUSAL IS NOT A FAILED READ. See the header: it propagates so no cache
        // promote can stamp a blank period over the good value already being served.
        rethrowIfBudgetRefused(err);
        console.error(`[dashboard] payments window read failed for site ${siteId} ${period}`, err);
        failedSites.add(siteId);
      }
    }
  });
  await Promise.all(reads);

  // ONE FAILED PERIOD POISONS ITS SITE, NOT JUST ITS CELL — deliberately. If last-30
  // failed for site-rv and every other cell answered, keeping the site's other cells
  // is fine (they are each independently exact), so only the failed key is absent
  // and only that period's group total blanks. Recording the site here is for the
  // caller's disclosure, not for widening the blackout.
  return { totals, failedSites: [...failedSites] };
}

/**
 * Read one payments envelope's `meta` as an exact window total.
 *
 * Refuses anything it does not recognise rather than defaulting: a missing or
 * malformed aggregate has to become "unavailable", because the alternative — a
 * zero — is indistinguishable on screen from a quiet day and is exactly the class
 * of plausible-looking wrong number this whole change exists to remove.
 */
function paymentsWindowTotal(meta: unknown): TakingsWindowTotal | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const rawCount = m["total"];
  const count =
    typeof rawCount === "number"
      ? rawCount
      : typeof rawCount === "string" && /^\d+$/.test(rawCount.trim())
        ? Number(rawCount.trim())
        : null;
  if (count === null || !Number.isSafeInteger(count) || count < 0) return null;
  const totalPence = parseAggregateAmountPence(m["total_amount"]);
  if (totalPence === null) return null;
  return { totalPence, paymentCount: count };
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

/**
 * The claims backing the UDA block, NARROWED to the contract year with
 * `after` / `before`, and COMPLETE or nothing.
 *
 * WHAT IT USED TO DO. It paged /v1/nhs_claims newest-first and stopped at the first
 * row older than 1 April, on the belief that the endpoint would not filter by date
 * and that its rows came back in date order. Neither is true. The index is ordered
 * by id and spans years, so a claim older than the contract year turns up on PAGE
 * ONE — and the walk stopped there, having read about a hundred of this practice's
 * ~7,700 contract-year claims, then reported "coverage reaches 1 April" and let the
 * UDA totals be computed over that 1.3% slice. The panel was not slightly low; it
 * was arbitrary.
 *
 * WHAT IT DOES NOW. `after` and `before` are real filters on `submitted_date`
 * (live-probed 2026-08-21: 30,336 -> 2,024 for after=2026-04-01; they combine). Both
 * edges are padded a day and the client-side window in computeUdaTotals trims, so no
 * boundary claim can be lost to an unstated edge convention.
 *
 * AND COMPLETENESS IS NOW MEASURED, NOT ASSUMED. `meta.total` states exactly how
 * many claims match, so the scan knows whether it read all of them. Fewer rows than
 * meta.total means the panel says the figure is unavailable and why — because this
 * endpoint publishes NO `total_amount`, unlike /v1/payments, so there is no way to
 * get a UDA total without every row.
 *
 * THE PAGE CAP IS A REAL CEILING AND WILL BE REACHED. 4,000 claims a site covers
 * this practice today (largest site 3,390 five months into the year) but a full year
 * at this rate is ~8,600, so from roughly the turn of the year this panel will start
 * reporting itself unavailable rather than short. That is the correct behaviour for
 * a figure that cannot be read completely, and it is the seam where a stored claim
 * rollup belongs — not a reason to go back to printing a slice.
 */
async function scanClaims(
  siteIds: readonly string[],
  today: string,
  contractStart: string,
): Promise<{ rows: DashboardNhsClaim[] | null; dropped: number; truncated: boolean }> {
  const client = dentallyFromEnv();
  // Padded a day at each edge: `before=<today>` was observed to EXCLUDE today's own
  // claims (30,336 -> 30,333), and `after`'s edge convention is unstated. A superset
  // is free here because the UDA window filter runs client-side anyway.
  const after = shiftDayKey(contractStart, -1) ?? contractStart;
  const before = shiftDayKey(today, 1) ?? today;

  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const raw: unknown[] = [];
        let expected: number | null = null;
        for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
          const res = await client.listNhsClaims({
            siteId: dentallySiteId(siteId),
            after,
            before,
            page,
            perPage: PER_PAGE,
          });
          if (page === 1) expected = metaTotal(res.meta);
          const rows = res.nhs_claims ?? [];
          raw.push(...rows);
          if (rows.length < PER_PAGE) break;
        }
        // Dentally told us how many exist. Anything less is a truncated read, and a
        // truncated read cannot state a contract-year total.
        if (expected !== null && raw.length < expected) {
          console.error(
            `[dashboard] NHS claim scan read ${raw.length} of ${expected} contract-year claims ` +
              `for site ${siteId} at ${SCAN_MAX_PAGES} pages; reporting the UDA figures ` +
              `unavailable rather than totalling a slice`,
          );
          return { rows: null, dropped: 0, truncated: true };
        }
        if (expected === null && raw.length >= SCAN_MAX_PAGES * PER_PAGE) {
          // No count to check against AND the walk ran to its cap: it may or may not
          // be whole, and "may" is not good enough for a money figure.
          console.error(
            `[dashboard] NHS claim scan hit the page cap for site ${siteId} with no meta.total ` +
              `to verify against; reporting the UDA figures unavailable`,
          );
          return { rows: null, dropped: 0, truncated: true };
        }
        const { rows, dropped } = normaliseNhsClaims(raw);
        return { rows: rows.map((c) => ({ ...c, siteId })), dropped, truncated: false };
      } catch (err) {
        rethrowIfBudgetRefused(err); // not a failed scan; see the header
        console.error(`[dashboard] NHS claim scan failed for site ${siteId}`, err);
        return { rows: null, dropped: 0, truncated: false };
      }
    }),
  );

  if (perSite.some((s) => s.rows === null)) {
    // Truncation is the WHOLE group's story only if nothing else went wrong: a site
    // that genuinely failed is an outage, and an outage must not be dressed up as
    // "there is too much data", which reads like a smaller problem than it is.
    const truncated = perSite.every((s) => s.rows !== null || s.truncated);
    return { rows: null, dropped: 0, truncated };
  }
  return {
    rows: perSite.flatMap((s) => s.rows ?? []),
    dropped: perSite.reduce((n, s) => n + s.dropped, 0),
    truncated: false,
  };
}

/**
 * `meta.total` — how many rows Dentally says match the query — or null when the
 * envelope does not carry one.
 *
 * It is the difference between "the scan finished" and "the scan stopped", which no
 * amount of looking at the rows can tell you on an index that is not date-ordered.
 * Null is not an error: some endpoints omit it, and a caller then falls back to the
 * older short-page heuristic and says so.
 */
function metaTotal(meta: unknown): number | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>)["total"];
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : null;
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
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
  /** A null above is a scan that STOPPED SHORT, not one that failed. */
  invoicesTruncated: boolean;
  balancesTruncated: boolean;
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
 * TWO reads of the invoice index, because the two panels ask two different
 * questions and one scan cannot honestly answer both.
 *
 *   INVOICED  is a WINDOW question — what was billed in the selected period — and
 *             is narrowed with `created_after` / `created_before`.
 *   ACCOUNTS  is not a window question at all: an invoice raised three years ago
 *             and never settled is still owed today. It is narrowed with
 *             `paid=false` instead.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WORSE THAN IT LOOKED. One unscoped, unfiltered
 * walk of 40 pages served both panels. On this practice that is 4,000 of 34,201
 * invoices — and 30,348 of those 34,201 are already PAID, so the walk spent about
 * nine tenths of its budget on invoices nobody owes anything on and then ranked
 * debtors from the remainder. It also broke out of its page loop with no truncation
 * flag AT ALL: both panels rendered a total over an arbitrary eighth of the index as
 * though it were the whole thing, with nothing on screen to say otherwise. That
 * silent truncation is the same defect as the takings bug, on a different panel.
 *
 * FILTERS VERIFIED LIVE 2026-08-21 (read-only GETs, group totals):
 *   created_after=2026-08-01 -> 597 and created_before=2026-08-01 -> 33,604, which
 *   sum to exactly the unfiltered 34,201 — both edges real, and together a
 *   partition. paid=false -> 3,853 (vs paid=true -> 30,348). site_id -> 22,600 for
 *   N15, so site_id IS honoured here, contrary to what this comment used to claim.
 *   start_date/end_date, from/to, after/before, date_from/date_to and `on` are all
 *   IGNORED on this endpoint — the date parameter is spelled differently on all
 *   three of the endpoints this file reads.
 *
 * BOTH READS ARE NOW COMPLETE OR NULL, checked against `meta.total`. This endpoint
 * publishes no `total_amount`, so unlike takings there is no one-request answer:
 * completeness has to be earned by paging, and where it cannot be, the panel says so.
 *
 * Neither read is site-scoped, deliberately: one group-wide read is cheaper than
 * three site reads of the same rows, and attribution runs through the patient
 * (`siteByPatientId`) exactly as before.
 */
async function scanInvoices(today: string): Promise<InvoiceScan> {
  const client = dentallyFromEnv();
  const from = shiftDayKey(today, -(HISTORY_DAYS - 1)) ?? today;
  // Padded a day at each edge: `created_at` is an ISO instant with an offset, so a
  // bare day boundary is ambiguous by up to an hour of British Summer Time. The
  // per-period filter in buildInvoicedPanel trims the superset exactly.
  const createdAfter = shiftDayKey(from, -1) ?? from;
  const createdBefore = shiftDayKey(today, 1) ?? today;

  const [windowed, unpaid] = await Promise.all([
    pageInvoices(client, { createdAfter, createdBefore }, "invoiced-in-window"),
    pageInvoices(client, { paid: false }, "outstanding-balances"),
  ]);

  const invoices: DashboardInvoice[] | null = windowed.rows === null ? null : [];
  let undated = 0;
  for (const item of windowed.rows ?? []) {
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
    invoices?.push({ id, patientId: str(r["patient_id"]), day, grossPence, outstandingPence });
  }

  if (unpaid.rows === null) {
    return {
      invoices,
      undated,
      balances: null,
      droppedBalances: 0,
      invoicesTruncated: windowed.truncated,
      balancesTruncated: unpaid.truncated,
    };
  }
  const balances = normaliseAccountBalances(unpaid.rows);
  return {
    invoices,
    undated,
    balances: balances.rows,
    droppedBalances: balances.dropped,
    invoicesTruncated: windowed.truncated,
    balancesTruncated: false,
  };
}

/**
 * Page one filtered slice of /v1/invoices to COMPLETION, or return null.
 *
 * `meta.total` is what makes "complete" checkable: it states how many rows match, so
 * a scan that ends with fewer has demonstrably stopped short and says so, instead of
 * handing back a partial array that reads on screen exactly like a whole one. When
 * the envelope carries no meta, it falls back to the short-page heuristic and treats
 * a walk that ran to the page cap as truncated — the pessimistic reading, because
 * the cost of being wrong here is a wrong money figure.
 */
async function pageInvoices(
  client: ReturnType<typeof dentallyFromEnv>,
  filter: { createdAfter?: string; createdBefore?: string; paid?: boolean },
  label: string,
): Promise<{ rows: unknown[] | null; truncated: boolean }> {
  try {
    const raw: unknown[] = [];
    let expected: number | null = null;
    let shortPage = false;
    for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
      const res = await client.listInvoices({ ...filter, page, perPage: PER_PAGE });
      if (page === 1) expected = metaTotal(res.meta);
      const rows = res.invoices ?? [];
      raw.push(...rows);
      if (rows.length < PER_PAGE) {
        shortPage = true;
        break;
      }
    }
    const complete = expected !== null ? raw.length >= expected : shortPage;
    if (!complete) {
      console.error(
        `[dashboard] invoice scan (${label}) read ${raw.length}` +
          `${expected === null ? "" : ` of ${expected}`} rows at ${SCAN_MAX_PAGES} pages; ` +
          `reporting the panel unavailable rather than totalling a slice of the index`,
      );
      return { rows: null, truncated: true };
    }
    return { rows: raw, truncated: false };
  } catch (err) {
    rethrowIfBudgetRefused(err); // not a failed scan; see the header
    console.error(`[dashboard] invoice scan (${label}) failed`, err);
    return { rows: null, truncated: false };
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
    // An EMPTY map, not null: null would fall back to the row path and report the
    // same unavailable cell for a different reason. Empty means "no site answered",
    // which is exactly what a refused assembly is.
    takingsWindowTotals: new Map(),
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
  const [takings, appointments, claims, patients, plans, invoiceScan, activeCounts] =
    await Promise.all([
    readTakingsWindows(siteIds, args.now),
    scanAppointments(siteIds, today, practitionersP),
    scanClaims(siteIds, today, contractStart),
    scanPatients(siteIds, today),
    scanPlans(siteIds, today),
    scanInvoices(today),
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
    // The money on the strip is Dentally's own per-window aggregate, not a total we
    // assemble from rows — see readTakingsWindows. `payments` stays empty and
    // `paymentsCoverage` null on purpose: there is no scanned row set any more, and
    // a coverage span invented to look reassuring would be the same class of claim
    // that produced the wrong figures in the first place.
    payments: [],
    paymentsCoverage: null,
    takingsWindowTotals: takings.totals,
    droppedPayments: 0,
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
    invoicesTruncated: invoiceScan.invoicesTruncated,
    balances,
    droppedBalances: invoiceScan.droppedBalances,
    balancesTruncated: invoiceScan.balancesTruncated,
    siteByPatientId,
    claims: claims.rows,
    droppedClaims: claims.dropped,
    claimsTruncated: claims.truncated,
    udaTargets: configuredUdaTargets(),
  });
}
