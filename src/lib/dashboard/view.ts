// ---------------------------------------------------------------------------
// The practice-manager dashboard's view model.
//
// One pure function turns everything fetched from Dentally into everything the
// screen renders. No I/O, no clock reads, no React: the caller passes the rows
// and `now`, so the whole screen's arithmetic is unit tested in plain .ts.
//
// Two shapes run through all of it:
//
//   Metric      { value, reason }. A null value ALWAYS carries a plain British
//               English reason, and the panel prints the reason instead of the
//               number. Nothing here ever substitutes a zero for a figure it
//               could not source: on a takings dashboard a plausible zero is
//               worse than a blank, because a blank gets questioned.
//
//   ScopeView   one site, or the whole group. Every scope is computed up front
//               so the period cells and the all-sites toggle switch instantly
//               rather than costing a round trip. The panels are a few dozen
//               numbers each, so this is cheap.
//
// The takings strip drives the panels below it: each scope holds a full set of
// panels per period, and the screen shows the selected one.
// ---------------------------------------------------------------------------

import {
  computeInvoicedTotals,
  computeOutstandingAccounts,
  type RankedAccount,
} from "@/lib/dashboard/accounts";
import { computeOutcomeSplit, classifyState, type OutcomeBucket } from "@/lib/dashboard/appointments";
import { UDA_TARGET_UNAVAILABLE } from "@/lib/dashboard/contract";
import type {
  DashboardAccountBalance,
  DashboardAppointment,
  DashboardNhsClaim,
  DashboardPatient,
  DashboardPayment,
  DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import { computePatientCounts, computeTreatmentPlanCounts } from "@/lib/dashboard/patients";
import {
  coversWindow,
  isDayInWindow,
  londonToday,
  periodWindow,
  DASHBOARD_PERIODS,
  type DashboardPeriod,
  type DayCoverage,
  type DayWindow,
} from "@/lib/dashboard/period";
import {
  computeTakingsStrip,
  computeTakingsStripFromRollup,
  type DashboardRollupDay,
  type TakingsStrip,
  type TakingsWindowTotals,
} from "@/lib/dashboard/takings";
import {
  computeUdaByPractitioner,
  computeUdaProgress,
  computeUdaTotals,
  nhsContractYear,
  type ContractYear,
  type UdaProgress,
} from "@/lib/dashboard/uda";

// --- Metrics ---------------------------------------------------------------

/** A figure, or the reason it is not available. Never both, never neither. */
export interface Metric {
  value: number | null;
  reason: string | null;
}

/** A sourced figure. A genuinely empty window is a 0 here, which is not a null. */
export function metric(value: number | null, reason: string): Metric {
  return value === null ? { value: null, reason } : { value, reason: null };
}

const UNAVAILABLE = {
  appointments: "Unavailable: the appointment scan does not reach back this far.",
  appointmentsFailed: "Unavailable: appointments could not be read from Dentally.",
  patientsFailed: "Unavailable: the patient list could not be read from Dentally.",
  registrationDate: "Unavailable: no patient record carries a registration date.",
  activeFlag: "Unavailable: no patient record carries an active flag.",
  plansFailed: "Unavailable: treatment plans could not be read from Dentally.",
  planStart: "Unavailable: no plan carries a start date.",
  planFinish: "Unavailable: this source does not record when a plan finished.",
  invoicesFailed: "Unavailable: invoices could not be read from Dentally.",
  invoiceDates: "Unavailable: no invoice carries a date, so a window cannot be totalled.",
  balancesFailed: "Unavailable: account balances could not be read from Dentally.",
  claimsFailed: "Unavailable: NHS claims could not be read from Dentally.",
  patientsTruncated:
    "Unavailable: the patient scan ran out of page budget, so a count would be short.",
  activeCountUnsourced:
    "Unavailable: the nightly patient count has not recorded a figure for this site.",
  plansTruncated:
    "Unavailable: the treatment plan scan ran out of page budget, so a count would be short.",
  // A SCAN THAT STOPPED SHORT IS NOT AN OUTAGE, AND MUST NOT READ LIKE ONE. Dentally
  // states how many rows match a filtered query (meta.total), so these three scans
  // now KNOW when they read fewer than exist. "Could not be read" would send someone
  // looking for a broken connection; the truth is that there is more data here than
  // one page budget can carry, and the figure is withheld rather than shortened.
  claimsTruncated:
    "Unavailable: there are more NHS claims this contract year than one read can cover, so a UDA total would be short.",
  invoicesTruncated:
    "Unavailable: there are more invoices in this period than one read can cover, so a total would be short.",
  balancesTruncated:
    "Unavailable: there are more unpaid invoices than one read can cover, so a balance would be short.",
  planOpenWindowed:
    "Unavailable: the plan scan reads recent changes only, so it cannot see plans left open before that.",
} as const;

// --- Panels ----------------------------------------------------------------

/** The donut: completed, cancelled, missed, and the total in the centre. */
export interface AppointmentsPanel {
  completed: Metric;
  cancelled: Metric;
  dna: Metric;
  /** Neither finished nor lost: still ahead of itself, or in the chair. */
  other: Metric;
  total: Metric;
  /** Dentally states we did not recognise, for calibration. Never filed in a slice. */
  unknownStates: string[];
}

export interface InvoicedPanel {
  totalPence: Metric;
  paidPence: Metric;
  unpaidPence: Metric;
  invoiceCount: Metric;
  /** Invoices carrying no date, which cannot be placed in a window. Disclosed, not hidden. */
  undatedInvoices: number;
  /**
   * Invoices the row grammar could not read at all, so they are in NO period.
   *
   * Separate from `undatedInvoices` because they are separate facts: an undated bill
   * was read and could not be placed, an unread one never became a bill. Both are
   * money missing from this total, and both say so on the screen — which is what
   * makes it safe to tighten the grammar this panel parses with.
   */
  droppedInvoices: number;
}

export interface PatientsPanel {
  newCount: Metric;
  seenCount: Metric;
  activeCount: Metric;
}

export interface PlansPanel {
  started: Metric;
  finished: Metric;
  open: Metric;
}

export interface PractitionerUdaRow {
  practitionerId: string | null;
  name: string;
  completedUda: number;
  invalidUda: number;
}

/** UDAs claimed inside the selected period. */
export interface UdaWindowPanel {
  completedUda: Metric;
  invalidUda: Metric;
  byPractitioner: PractitionerUdaRow[];
  /** Claims whose status matched neither the valid nor the invalid set. */
  unrecognisedClaimCount: number;
  unknownStatuses: string[];
}

/** The ten patients who owe most, plus the headline balance. A snapshot, not a window. */
export interface AccountsPanel {
  /** Every balance summed, credits included. Shown as a negative, as Dentally does. */
  netBalancePence: Metric;
  totalOwedPence: Metric;
  patientsInDebt: Metric;
  top: RankedAccount[];
  /** Balance rows the normaliser could not read. */
  dropped: number;
  /**
   * Unpaid invoices that exist in this Dentally account but are NOT in this balance,
   * because the read that produced it is scoped to this client's sites and they carry
   * no site or another practice's. Null means the reconciliation was not made — see
   * pageUnpaidInvoices in src/lib/dashboard/read.ts, which also explains why the
   * caveat names both causes and commits to neither.
   *
   * Disclosure only. It never changes a figure; it says what a figure leaves out.
   */
  unattributedUnpaid: number | null;
  /**
   * The scope this panel was built for: null for the whole group, else a site id.
   *
   * IT IS HERE SO THE DISCLOSURE ABOVE CAN BE WORDED HONESTLY WITHOUT THE CALLER
   * BEING TRUSTED TO SAY WHICH SCOPE IT IS RENDERING. `unattributedUnpaid` is a
   * GROUP-level count, and what it leaves out of a SINGLE practice's balance is a
   * different and larger set — the sibling practices in this group are excluded from
   * that figure too. A caveat that cannot tell the two apart names two causes as if
   * they were exhaustive; see accountsCaveats.
   */
  siteId: string | null;
}

/**
 * Progress against the annual contract, contract year to date.
 *
 * The one addition the owner approved on this panel. It is deliberately NOT
 * period scoped: a year-to-date position is the only version of this figure that
 * means anything, and it is labelled as such on the screen.
 */
export interface UdaProgressPanel {
  contractYear: ContractYear;
  completedUda: Metric;
  invalidUda: Metric;
  targetUda: Metric;
  progress: UdaProgress | null;
  reason: string | null;
}

export interface PeriodPanels {
  period: DashboardPeriod;
  window: DayWindow;
  appointments: AppointmentsPanel;
  invoiced: InvoicedPanel;
  patients: PatientsPanel;
  plans: PlansPanel;
  uda: UdaWindowPanel;
}

/** Where a takings cell's figure came from, which the panel states. */
export type TakingsSource = "live" | "rollup";

export interface ScopeView {
  /** Null for the whole group. */
  siteId: string | null;
  label: string;
  strip: TakingsStrip;
  /** Per period, the source of the money figure. Absent when the cell is blank. */
  stripSources: Partial<Record<DashboardPeriod, TakingsSource>>;
  accounts: AccountsPanel;
  udaProgress: UdaProgressPanel;
  periods: Record<DashboardPeriod, PeriodPanels>;
  /** Payments with no site id, excluded from a per-site total rather than folded in. */
  unattributedPayments: number;
  /**
   * Sites whose takings read did not answer AND THAT THIS SCOPE CAN SEE, by id.
   *
   * IT LIVES ON THE SCOPE BECAUSE THE SCOPING IS THE POINT. The list used to be a
   * single group-level field on the view, and every consumer was then responsible for
   * narrowing it to the scope it was rendering. Exactly one did — practice-dashboard
   * did the filter in a `useMemo` — so a manager looking at N15 alone was told her
   * blank was caused by N17, a practice not on her screen whose failure blanks nothing
   * she can see. The next consumer (the co-pilot's narration, the owner overview)
   * would have started from the same unscoped field and made the same mistake, and
   * nothing in the types would have stopped it. So the narrowing happens ONCE, here,
   * and the unscoped list is no longer reachable from PracticeDashboardView at all.
   *
   * Disclosure only. Whether a cell is blank is decided solely by a missing key in
   * `takingsWindowTotals`, inside computeTakingsStrip; this list never widens or
   * narrows that. Empty on every healthy assembly.
   */
  takingsFailedSites: string[];
}

// --- The appointment list ---------------------------------------------------

/** One appointment as fetched, before display formatting. */
export interface AppointmentSource {
  id: string;
  /** Full ISO instant of the start. */
  startIso: string;
  durationMin: number | null;
  patientId: string | null;
  patientName: string | null;
  siteId: string | null;
  practitionerId: string | null;
  practitionerName: string | null;
  reason: string | null;
  /** Free text typed onto the booking. Absent on most rows. */
  note: string | null;
  state: string;
}

/** One rendered row of the appointment list. */
export interface AppointmentRow {
  id: string;
  day: string;
  /** "Thu 30 Jul", shown only when the selected window spans more than one day. */
  dayLabel: string;
  /** London wall clock, "09:30". */
  time: string;
  durationMin: number | null;
  patientId: string | null;
  patientName: string;
  initials: string;
  siteId: string | null;
  siteName: string | null;
  practitionerId: string | null;
  practitionerName: string | null;
  reason: string | null;
  note: string | null;
  /** Raw Dentally state, kept verbatim. */
  state: string;
  /** The raw state tidied for display, never re-worded. */
  stateLabel: string;
  bucket: OutcomeBucket;
  recognisedState: boolean;
  /** Still to be completed: the default filter she reads in Dentally. */
  remaining: boolean;
  /** Stable key for the appointment type colour bar. */
  typeKey: string;
}

// --- The whole view ---------------------------------------------------------

export interface SiteRef {
  id: string;
  name: string;
}

export interface PractitionerRef {
  id: string;
  name: string;
}

export interface PracticeDashboardView {
  /** ISO instant the figures were assembled. */
  generatedAt: string;
  /** "Stats updated 09:42", the line she already expects, bottom right of the band. */
  generatedAtLabel: string;
  today: string;
  sites: SiteRef[];
  practitioners: PractitionerRef[];
  scopes: ScopeView[];
  appointments: AppointmentRow[];
  /** True when the list was capped, so the panel says so instead of implying it is whole. */
  appointmentsCapped: boolean;
  appointmentsInWindow: number;
  /**
   * How far back the live payment scan genuinely reached.
   *
   * FIXTURE PATH ONLY, and permanently null on the live one. The live takings figure
   * is Dentally's own per-window aggregate (readTakingsWindows), so there is no
   * scanned row set and therefore no coverage span; inventing one to fill this field
   * would be the same reassuring-looking claim that produced the wrong figures in the
   * first place. It is kept, not deleted, because computeTakingsStrip's ROW path is
   * still real code with real callers — the fixtures in _finance-fixtures.test.ts and
   * dashboard-chrome.test.ts drive the whole screen through it, and the stored-rollup
   * seam will want it back — and a field that is null on one path is honest, while a
   * missing one would force those callers to fake a live shape.
   */
  paymentsCoverage: DayCoverage | null;
  appointmentsCoverage: DayCoverage | null;
  /** Payment rows the normaliser could not read at all. FIXTURE PATH ONLY: the live
   *  path totals no rows, so it drops none — see paymentsCoverage. */
  droppedPayments: number;
  // NO GROUP-LEVEL `takingsFailedSites` HERE, DELIBERATELY. It was a whole-group list
  // on the view that every reader had to remember to narrow, and a reader who forgot
  // named a practice that is not on the screen. It is now per scope
  // (ScopeView.takingsFailedSites), already narrowed, so the unscoped list cannot be
  // reached and the mistake cannot be made a second time.
  /** Claim rows the normaliser could not read at all. */
  droppedClaims: number;
}

export interface BuildViewInput {
  now: Date;
  sites: readonly SiteRef[];
  practitioners: readonly PractitionerRef[];

  payments: readonly DashboardPayment[];
  paymentsCoverage: DayCoverage | null;
  droppedPayments?: number;
  /**
   * EXACT per-site, per-period takings from Dentally's own aggregate. When present
   * this is what the strip's money is, and `payments`/`paymentsCoverage` are not
   * consulted for it. See src/lib/dashboard/takings.ts for why there are two paths
   * and which one the live dashboard uses.
   */
  takingsWindowTotals?: TakingsWindowTotals | null;
  /**
   * Site ids whose takings read did not answer, as the READ layer saw them: the whole
   * group, unnarrowed. buildScope splits it per scope on the way in, and only the
   * narrowed lists come out (ScopeView.takingsFailedSites).
   *
   * DISCLOSURE ONLY: it names the practices in the caveat and NEVER decides whether a
   * cell is blank — that stays the missing-key test inside computeTakingsStrip, so
   * there is exactly one rule about when a total may be stated.
   */
  takingsFailedSites?: readonly string[];
  /**
   * TRUE when the platform's own budget guard refused the assembly, so no takings
   * read was made. Distinguishes "we chose not to spend the quota" from "a practice
   * could not be read", which are different sentences and different actions.
   */
  takingsRefused?: boolean;
  /** Stored daily rollup rows, for periods the live scan cannot reach. */
  rollups?: readonly DashboardRollupDay[] | null;

  /** Null when appointments could not be read at all. */
  appointments: readonly DashboardAppointment[] | null;
  appointmentsCoverage: DayCoverage | null;
  /** The same appointments, carrying what the list needs to render. */
  appointmentRows: readonly AppointmentSource[];

  patients: readonly DashboardPatient[] | null;
  /**
   * ACTIVE patients per site id, from the nightly whole-book count
   * (/api/sync/patient-count -> patient_count), NOT from `patients`.
   *
   * "How many active patients are on the books" is a WHOLE-BOOK question, and the
   * dashboard's patient scan is a bounded, window-narrowed read: counting active
   * flags over it produced a confident number derived from whichever few thousand
   * rows the page budget happened to reach. The nightly job pages the entire book
   * off-hours and is the only honest source. A site missing from this map reports
   * the count unavailable rather than falling back to the partial scan.
   */
  activeCounts?: ReadonlyMap<string, number> | null;
  plans: readonly DashboardTreatmentPlan[] | null;
  /**
   * True when the plan scan was narrowed to recently-updated plans. The window
   * counts (started / finished) are still exact — a plan that started or finished
   * inside the window was necessarily updated inside it — but OPEN is not: a plan
   * opened years ago and still open was not updated recently and is not in the set.
   * So `open` reports itself unavailable rather than counting only recent plans.
   */
  plansWindowed?: boolean;

  /** Invoices already reduced to gross, outstanding, day and patient. */
  invoices: readonly DashboardInvoice[] | null;
  /**
   * True when a null above is a scan that STOPPED SHORT rather than one that failed.
   * Dentally publishes meta.total on a filtered query, so the reads genuinely know
   * the difference; saying "could not be read" for a page-budget truncation would
   * send someone hunting a broken connection instead of a data volume.
   */
  invoicesTruncated?: boolean;
  balancesTruncated?: boolean;
  claimsTruncated?: boolean;
  /** Invoices read but carrying no date, so unplaceable in a window. */
  undatedInvoices?: number;
  /** Invoices the row grammar REFUSED — no id, or an amount it will not parse. In no
   *  period total, and disclosed rather than skipped: see InvoiceScan.dropped. */
  droppedInvoices?: number;

  balances: readonly DashboardAccountBalance[] | null;
  droppedBalances?: number;
  /**
   * Unpaid invoices the site-scoped balance read could not see. DISCLOSURE ONLY: it
   * never blanks a panel and never moves a total. Absent or null means the read layer
   * did not check, which is different from checking and finding none.
   */
  unattributedUnpaidInvoices?: number | null;
  /** Patient id to site id, so an invoice balance can be attributed to a site. */
  siteByPatientId?: ReadonlyMap<string, string> | null;

  claims: readonly DashboardNhsClaim[] | null;
  droppedClaims?: number;
  /** Annual contracted UDA per site id. A site absent here has no target. */
  udaTargets?: Readonly<Record<string, number>>;

  /** Most rows the appointment list will carry. */
  appointmentRowCap?: number;
}

/** An invoice reduced to what the INVOICED panel needs. */
export interface DashboardInvoice {
  id: string;
  patientId: string | null;
  /** London day the invoice was raised. */
  day: string;
  grossPence: number;
  outstandingPence: number;
}

const DEFAULT_ROW_CAP = 500;

function londonTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function londonDayLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

/** Two initials for the avatar. Falls back to a dash rather than inventing letters. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

/** Tidy a raw Dentally state for display without re-wording it. */
export function stateLabelOf(state: string): string {
  const cleaned = state.trim().replace(/[_-]+/g, " ");
  if (cleaned.length === 0) return "Unknown";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** A stable key for the appointment type colour bar. */
export function typeKeyOf(reason: string | null): string {
  const key = (reason ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return key.length > 0 ? key : "unspecified";
}

/** Build one display row. Exported for the tests that pin the time zone handling. */
export function toAppointmentRow(
  source: AppointmentSource,
  siteNameById: ReadonlyMap<string, string>,
): AppointmentRow | null {
  const start = new Date(source.startIso);
  if (Number.isNaN(start.getTime())) return null;
  const { bucket, recognised } = classifyState(source.state);
  const patientName = source.patientName?.trim() || "Unknown patient";
  return {
    id: source.id,
    day: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(start),
    dayLabel: londonDayLabel(start),
    time: londonTime(start),
    durationMin: source.durationMin,
    patientId: source.patientId,
    patientName,
    initials: initialsOf(patientName),
    siteId: source.siteId,
    siteName: source.siteId === null ? null : siteNameById.get(source.siteId) ?? null,
    practitionerId: source.practitionerId,
    practitionerName: source.practitionerName,
    reason: source.reason,
    note: source.note,
    state: source.state,
    stateLabel: stateLabelOf(source.state),
    bucket,
    recognisedState: recognised,
    remaining: bucket === "other",
    typeKey: typeKeyOf(source.reason),
  };
}

/**
 * Merge the live strip with the rollup strip.
 *
 * A cell takes the live figure when the live read genuinely produced one, then the
 * rollup, then nothing. The source is recorded so the panel can say which, rather
 * than presenting two different freshnesses as one number.
 *
 * THE ROLLUP IS NO LONGER THE PLAN FOR THE LONG PERIODS. This used to read "the
 * longer periods are meant to come from the stored daily rollup, because Dentally
 * ignores every date filter on /v1/payments and paging ninety days back on a page
 * load is not acceptable". Dentally does NOT ignore the filter: start_date +
 * end_date returns the exact windowed total in meta, in one request, so ninety days
 * costs the same as today (verified live 2026-08-21 — see listPayments in
 * src/lib/dentally/client.ts). Every period is now live and exact. The rollup seam
 * stays because it is a genuine fallback for an upstream outage, but nothing is
 * waiting on it any more.
 */
function mergeStrips(
  live: TakingsStrip,
  rollup: TakingsStrip | null,
): { strip: TakingsStrip; sources: Partial<Record<DashboardPeriod, TakingsSource>> } {
  const sources: Partial<Record<DashboardPeriod, TakingsSource>> = {};
  const rollupByPeriod = new Map((rollup?.cells ?? []).map((c) => [c.period, c]));

  const cells = live.cells.map((cell) => {
    if (cell.totalPence !== null) {
      sources[cell.period] = "live";
      return cell;
    }
    const fromRollup = rollupByPeriod.get(cell.period);
    if (fromRollup && fromRollup.totalPence !== null) {
      sources[cell.period] = "rollup";
      // Keep the live appointment count when the live scan had one: appointments
      // and payments are separate sources and can be available separately.
      return cell.appointmentCount !== null
        ? { ...fromRollup, appointmentCount: cell.appointmentCount, appointmentUnavailableReason: null }
        : fromRollup;
    }
    return cell;
  });

  return { strip: { ...live, cells }, sources };
}

function buildAppointmentsPanel(
  appointments: readonly DashboardAppointment[] | null,
  coverage: DayCoverage | null,
  window: DayWindow,
  siteId: string | null,
): AppointmentsPanel {
  const reason = appointments === null ? UNAVAILABLE.appointmentsFailed : UNAVAILABLE.appointments;
  if (appointments === null || !coversWindow(coverage, window)) {
    return {
      completed: metric(null, reason),
      cancelled: metric(null, reason),
      dna: metric(null, reason),
      other: metric(null, reason),
      total: metric(null, reason),
      unknownStates: [],
    };
  }
  const split = computeOutcomeSplit({ appointments, window, siteId });
  return {
    completed: metric(split.completed, reason),
    cancelled: metric(split.cancelled, reason),
    dna: metric(split.dna, reason),
    other: metric(split.other, reason),
    total: metric(split.total, reason),
    unknownStates: split.unknownStates,
  };
}

function buildInvoicedPanel(
  invoices: readonly DashboardInvoice[] | null,
  undated: number,
  dropped: number,
  window: DayWindow,
  siteByPatientId: ReadonlyMap<string, string> | null,
  siteId: string | null,
  unreadableReason: string,
): InvoicedPanel {
  if (invoices === null) {
    const reason = unreadableReason;
    return {
      totalPence: metric(null, reason),
      paidPence: metric(null, reason),
      unpaidPence: metric(null, reason),
      invoiceCount: metric(null, reason),
      undatedInvoices: undated,
      droppedInvoices: dropped,
    };
  }
  // Every invoice read carried no date: a window total would be a fabrication.
  if (invoices.length === 0 && undated > 0) {
    const reason = UNAVAILABLE.invoiceDates;
    return {
      totalPence: metric(null, reason),
      paidPence: metric(null, reason),
      unpaidPence: metric(null, reason),
      invoiceCount: metric(null, reason),
      undatedInvoices: undated,
      droppedInvoices: dropped,
    };
  }

  const scoped = invoices.filter((inv) => {
    if (!isDayInWindow(inv.day, window)) return false;
    if (siteId === null) return true;
    // Invoices carry no site, so attribution comes from the patient. A patient we
    // cannot place is excluded, never assigned to the selected site.
    const patientSite = inv.patientId === null ? null : siteByPatientId?.get(inv.patientId) ?? null;
    return patientSite === siteId;
  });

  const totals = computeInvoicedTotals({
    invoices: scoped.map((inv) => ({
      grossPence: inv.grossPence,
      outstandingPence: inv.outstandingPence,
    })),
  });
  const reason = UNAVAILABLE.invoicesFailed;
  return {
    totalPence: metric(totals.totalPence, reason),
    paidPence: metric(totals.paidPence, reason),
    unpaidPence: metric(totals.unpaidPence, reason),
    invoiceCount: metric(totals.invoiceCount, reason),
    undatedInvoices: undated,
    droppedInvoices: dropped,
  };
}

/**
 * `activeCounts` is site id -> active patients from the nightly whole-book count.
 * For a single site that is its own row; for the GROUP scope it is the sum over
 * `siteIds`, and the sum is only stated when EVERY site has a row — a group total
 * missing one practice is not a group total.
 */
function activeFromCounts(
  activeCounts: ReadonlyMap<string, number> | null | undefined,
  siteId: string | null,
  siteIds: readonly string[],
): number | null {
  if (!activeCounts) return null;
  if (siteId !== null) return activeCounts.get(siteId) ?? null;
  let sum = 0;
  for (const id of siteIds) {
    const n = activeCounts.get(id);
    if (n === undefined) return null;
    sum += n;
  }
  return sum;
}

function buildPatientsPanel(
  patients: readonly DashboardPatient[] | null,
  appointments: readonly DashboardAppointment[] | null,
  appointmentsCoverage: DayCoverage | null,
  window: DayWindow,
  siteId: string | null,
  activeCounts: ReadonlyMap<string, number> | null | undefined,
  siteIds: readonly string[],
): PatientsPanel {
  const appointmentsUsable = appointments !== null && coversWindow(appointmentsCoverage, window);
  const counts = computePatientCounts({
    patients,
    appointments: appointmentsUsable ? appointments : null,
    window,
    siteId,
  });
  const patientReason = patients === null ? UNAVAILABLE.patientsFailed : UNAVAILABLE.registrationDate;
  const seenReason =
    appointments === null ? UNAVAILABLE.appointmentsFailed : UNAVAILABLE.appointments;
  // The nightly whole-book count WINS whenever it has a figure. It is the only
  // source that has actually seen every patient; the scan's own active tally is
  // kept solely as the fallback for a deployment where the nightly job has never
  // run, and is what the `activeCounts` input exists to retire.
  const sourcedActive = activeFromCounts(activeCounts, siteId, siteIds);
  const activeReason =
    activeCounts != null
      ? UNAVAILABLE.activeCountUnsourced
      : patients === null
        ? UNAVAILABLE.patientsFailed
        : UNAVAILABLE.activeFlag;
  return {
    newCount: metric(counts.newCount, patientReason),
    seenCount: metric(counts.seenCount, seenReason),
    activeCount: metric(
      activeCounts != null ? sourcedActive : counts.activeCount,
      activeReason,
    ),
  };
}

function buildPlansPanel(
  plans: readonly DashboardTreatmentPlan[] | null,
  window: DayWindow,
  siteId: string | null,
  plansWindowed: boolean,
): PlansPanel {
  const counts = computeTreatmentPlanCounts({ plans, window, siteId });
  const startReason = plans === null ? UNAVAILABLE.plansFailed : UNAVAILABLE.planStart;
  const finishReason = plans === null ? UNAVAILABLE.plansFailed : UNAVAILABLE.planFinish;
  return {
    started: metric(counts.started, startReason),
    finished: metric(counts.finished, finishReason),
    // A windowed plan read cannot answer OPEN, and a number that only counts the
    // recently-touched plans is worse than a stated gap: it would read as "the
    // practice has 40 open plans" to someone deciding whether to chase them.
    open: plansWindowed
      ? metric(null, UNAVAILABLE.planOpenWindowed)
      : metric(counts.open, finishReason),
  };
}

function buildUdaWindowPanel(
  claims: readonly DashboardNhsClaim[] | null,
  window: DayWindow,
  siteId: string | null,
  practitionerNameById: ReadonlyMap<string, string>,
  unreadableReason: string,
): UdaWindowPanel {
  if (claims === null) {
    const reason = unreadableReason;
    return {
      completedUda: metric(null, reason),
      invalidUda: metric(null, reason),
      byPractitioner: [],
      unrecognisedClaimCount: 0,
      unknownStatuses: [],
    };
  }
  const totals = computeUdaTotals({ claims, window, siteId });
  const byPractitioner = computeUdaByPractitioner({ claims, window, siteId }).map((row) => ({
    practitionerId: row.practitionerId,
    name:
      row.practitionerId === null
        ? "Not attributed"
        : practitionerNameById.get(row.practitionerId) ?? row.practitionerId,
    completedUda: row.completedUda,
    invalidUda: row.invalidUda,
  }));
  const reason = UNAVAILABLE.claimsFailed;
  return {
    completedUda: metric(totals.completedUda, reason),
    invalidUda: metric(totals.invalidUda, reason),
    byPractitioner,
    unrecognisedClaimCount: totals.unrecognisedClaimCount,
    unknownStatuses: totals.unknownStatuses,
  };
}

function buildAccountsPanel(
  balances: readonly DashboardAccountBalance[] | null,
  dropped: number,
  siteByPatientId: ReadonlyMap<string, string> | null,
  siteId: string | null,
  unreadableReason: string,
  unattributedUnpaid: number | null,
): AccountsPanel {
  if (balances === null) {
    const reason = unreadableReason;
    return {
      netBalancePence: metric(null, reason),
      totalOwedPence: metric(null, reason),
      patientsInDebt: metric(null, reason),
      top: [],
      dropped,
      // Nothing to qualify: there is no balance on the screen for rows to be missing
      // from, and a count of omissions beside the word "Unavailable" says nothing.
      unattributedUnpaid: null,
      siteId,
    };
  }
  const accounts = computeOutstandingAccounts({ balances, dropped, siteByPatientId, siteId });
  const reason = UNAVAILABLE.balancesFailed;
  return {
    netBalancePence: metric(accounts.netBalancePence, reason),
    totalOwedPence: metric(accounts.totalOwedPence, reason),
    patientsInDebt: metric(accounts.patientsInDebt, reason),
    top: accounts.top,
    dropped: accounts.dropped,
    // ON EVERY SCOPE, group and single-site alike, and that is deliberate. An unpaid
    // invoice carrying no site could belong to a patient of ANY of these practices —
    // balances are attributed by patient, not by the invoice's own site — so there is
    // no scope it is safely irrelevant to. It cannot be apportioned between them
    // either, so it is stated as what it is: a group-level omission — which is
    // exactly why the scope travels with it.
    unattributedUnpaid,
    siteId,
  };
}

function buildUdaProgressPanel(
  claims: readonly DashboardNhsClaim[] | null,
  siteIdsInScope: readonly string[],
  siteId: string | null,
  targets: Readonly<Record<string, number>>,
  now: Date,
  unreadableReason: string,
): UdaProgressPanel {
  const contractYear = nhsContractYear(now);
  if (claims === null) {
    const reason = unreadableReason;
    return {
      contractYear,
      completedUda: metric(null, reason),
      invalidUda: metric(null, reason),
      targetUda: metric(null, reason),
      progress: null,
      reason,
    };
  }

  const yearWindow: DayWindow = { from: contractYear.start, to: londonToday(now) };
  const totals = computeUdaTotals({ claims, window: yearWindow, siteId });

  let targetUda: number | null = 0;
  for (const site of siteIdsInScope) {
    const target = targets[site];
    if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
      targetUda = null;
      break;
    }
    targetUda += target;
  }
  if (siteIdsInScope.length === 0) targetUda = null;

  const progress =
    targetUda === null
      ? null
      : computeUdaProgress({ completedUda: totals.completedUda, targetUda, now, contractYear });

  return {
    contractYear,
    completedUda: metric(totals.completedUda, UNAVAILABLE.claimsFailed),
    invalidUda: metric(totals.invalidUda, UNAVAILABLE.claimsFailed),
    targetUda: metric(targetUda, UDA_TARGET_UNAVAILABLE),
    progress,
    reason: progress === null ? UDA_TARGET_UNAVAILABLE : null,
  };
}

function buildScope(
  input: BuildViewInput,
  siteId: string | null,
  label: string,
  siteIdsInScope: readonly string[],
  practitionerNameById: ReadonlyMap<string, string>,
): ScopeView {
  const siteByPatientId = input.siteByPatientId ?? null;
  // A claim scan that stopped short and a claim scan that failed both hand us null.
  // Only the caller knows which, so it says, and the panels quote it verbatim.
  const claimsReason =
    input.claimsTruncated === true ? UNAVAILABLE.claimsTruncated : UNAVAILABLE.claimsFailed;

  const live = computeTakingsStrip({
    payments: input.payments,
    paymentsCoverage: input.paymentsCoverage,
    paymentsDropped: input.droppedPayments ?? 0,
    appointments: input.appointments,
    appointmentsCoverage: input.appointmentsCoverage,
    now: input.now,
    siteId,
    windowTotals: input.takingsWindowTotals ?? null,
    // A platform-side refusal, not a practice-side outage. Passed straight through
    // so the strip can say which it was; see TakingsStripInput.refused.
    refused: input.takingsRefused === true,
    // The scope's own site list, so a group total can tell a site that took nothing
    // from a site that could not be read. buildScope already computes it for the
    // rollup path; the exact path needs exactly the same list.
    siteIdsInScope,
  });
  const rollupRows = input.rollups ?? null;
  const rollup =
    rollupRows === null
      ? null
      : computeTakingsStripFromRollup({
          rollups: rollupRows,
          siteIds: siteIdsInScope,
          now: input.now,
          siteId,
        });
  const { strip, sources } = mergeStrips(live, rollup);

  const periods = {} as Record<DashboardPeriod, PeriodPanels>;
  for (const period of DASHBOARD_PERIODS) {
    const window = periodWindow(period, input.now);
    periods[period] = {
      period,
      window,
      appointments: buildAppointmentsPanel(
        input.appointments,
        input.appointmentsCoverage,
        window,
        siteId,
      ),
      invoiced: buildInvoicedPanel(
        input.invoices,
        input.undatedInvoices ?? 0,
        input.droppedInvoices ?? 0,
        window,
        siteByPatientId,
        siteId,
        input.invoicesTruncated === true ? UNAVAILABLE.invoicesTruncated : UNAVAILABLE.invoicesFailed,
      ),
      patients: buildPatientsPanel(
        input.patients,
        input.appointments,
        input.appointmentsCoverage,
        window,
        siteId,
        input.activeCounts,
        input.sites.map((s) => s.id),
      ),
      plans: buildPlansPanel(input.plans, window, siteId, input.plansWindowed === true),
      uda: buildUdaWindowPanel(input.claims, window, siteId, practitionerNameById, claimsReason),
    };
  }

  return {
    siteId,
    label,
    strip,
    stripSources: sources,
    accounts: buildAccountsPanel(
      input.balances,
      input.droppedBalances ?? 0,
      siteByPatientId,
      siteId,
      input.balancesTruncated === true ? UNAVAILABLE.balancesTruncated : UNAVAILABLE.balancesFailed,
      input.unattributedUnpaidInvoices ?? null,
    ),
    udaProgress: buildUdaProgressPanel(
      input.claims,
      siteIdsInScope,
      siteId,
      input.udaTargets ?? {},
      input.now,
      claimsReason,
    ),
    periods,
    unattributedPayments: live.unattributedPayments,
    // NARROWED HERE, ONCE. A scope names only failures inside itself; the all-sites
    // scope covers every site and so keeps the whole list.
    takingsFailedSites: (input.takingsFailedSites ?? []).filter((id) =>
      siteIdsInScope.includes(id),
    ),
  };
}

/**
 * Assemble the whole screen.
 *
 * Scopes come out all-sites first, then one per site in the order given, which
 * is the order the toggle renders them in.
 */
export function buildDashboardView(input: BuildViewInput): PracticeDashboardView {
  const siteNameById = new Map(input.sites.map((s) => [s.id, s.name]));
  const practitionerNameById = new Map(input.practitioners.map((p) => [p.id, p.name]));
  const allSiteIds = input.sites.map((s) => s.id);

  const scopes: ScopeView[] = [
    buildScope(input, null, "All sites", allSiteIds, practitionerNameById),
    ...input.sites.map((site) =>
      buildScope(input, site.id, site.name, [site.id], practitionerNameById),
    ),
  ];

  // The list is ordered newest first so today and yesterday are always present
  // even when a long window has to be capped.
  const rows = input.appointmentRows
    .map((source) => toAppointmentRow(source, siteNameById))
    .filter((row): row is AppointmentRow => row !== null)
    .sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const cap = input.appointmentRowCap ?? DEFAULT_ROW_CAP;

  return {
    generatedAt: input.now.toISOString(),
    generatedAtLabel: londonTime(input.now),
    today: londonToday(input.now),
    sites: [...input.sites],
    practitioners: [...input.practitioners],
    scopes,
    appointments: rows.slice(0, cap),
    appointmentsCapped: rows.length > cap,
    appointmentsInWindow: rows.length,
    paymentsCoverage: input.paymentsCoverage,
    appointmentsCoverage: input.appointmentsCoverage,
    droppedPayments: input.droppedPayments ?? 0,
    droppedClaims: input.droppedClaims ?? 0,
  };
}
