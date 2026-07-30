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
  /** How far back the live payment scan genuinely reached. */
  paymentsCoverage: DayCoverage | null;
  appointmentsCoverage: DayCoverage | null;
  /** Payment rows the normaliser could not read at all. */
  droppedPayments: number;
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
  /** Stored daily rollup rows, for periods the live scan cannot reach. */
  rollups?: readonly DashboardRollupDay[] | null;

  /** Null when appointments could not be read at all. */
  appointments: readonly DashboardAppointment[] | null;
  appointmentsCoverage: DayCoverage | null;
  /** The same appointments, carrying what the list needs to render. */
  appointmentRows: readonly AppointmentSource[];

  patients: readonly DashboardPatient[] | null;
  plans: readonly DashboardTreatmentPlan[] | null;

  /** Invoices already reduced to gross, outstanding, day and patient. */
  invoices: readonly DashboardInvoice[] | null;
  /** Invoices read but carrying no date, so unplaceable in a window. */
  undatedInvoices?: number;

  balances: readonly DashboardAccountBalance[] | null;
  droppedBalances?: number;
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
 * Today and yesterday come from a cheap live scan; the longer periods are meant
 * to come from the stored daily rollup, because Dentally ignores every date
 * filter on /v1/payments and paging ninety days back on a page load is not
 * acceptable. A cell takes the live figure when the live scan genuinely covered
 * it, then the rollup, then nothing. The source is recorded so the panel can say
 * which, rather than presenting two different freshnesses as one number.
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
  window: DayWindow,
  siteByPatientId: ReadonlyMap<string, string> | null,
  siteId: string | null,
): InvoicedPanel {
  if (invoices === null) {
    const reason = UNAVAILABLE.invoicesFailed;
    return {
      totalPence: metric(null, reason),
      paidPence: metric(null, reason),
      unpaidPence: metric(null, reason),
      invoiceCount: metric(null, reason),
      undatedInvoices: undated,
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
  };
}

function buildPatientsPanel(
  patients: readonly DashboardPatient[] | null,
  appointments: readonly DashboardAppointment[] | null,
  appointmentsCoverage: DayCoverage | null,
  window: DayWindow,
  siteId: string | null,
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
  return {
    newCount: metric(counts.newCount, patientReason),
    seenCount: metric(counts.seenCount, seenReason),
    activeCount: metric(
      counts.activeCount,
      patients === null ? UNAVAILABLE.patientsFailed : UNAVAILABLE.activeFlag,
    ),
  };
}

function buildPlansPanel(
  plans: readonly DashboardTreatmentPlan[] | null,
  window: DayWindow,
  siteId: string | null,
): PlansPanel {
  const counts = computeTreatmentPlanCounts({ plans, window, siteId });
  const startReason = plans === null ? UNAVAILABLE.plansFailed : UNAVAILABLE.planStart;
  const finishReason = plans === null ? UNAVAILABLE.plansFailed : UNAVAILABLE.planFinish;
  return {
    started: metric(counts.started, startReason),
    finished: metric(counts.finished, finishReason),
    open: metric(counts.open, finishReason),
  };
}

function buildUdaWindowPanel(
  claims: readonly DashboardNhsClaim[] | null,
  window: DayWindow,
  siteId: string | null,
  practitionerNameById: ReadonlyMap<string, string>,
): UdaWindowPanel {
  if (claims === null) {
    const reason = UNAVAILABLE.claimsFailed;
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
): AccountsPanel {
  if (balances === null) {
    const reason = UNAVAILABLE.balancesFailed;
    return {
      netBalancePence: metric(null, reason),
      totalOwedPence: metric(null, reason),
      patientsInDebt: metric(null, reason),
      top: [],
      dropped,
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
  };
}

function buildUdaProgressPanel(
  claims: readonly DashboardNhsClaim[] | null,
  siteIdsInScope: readonly string[],
  siteId: string | null,
  targets: Readonly<Record<string, number>>,
  now: Date,
): UdaProgressPanel {
  const contractYear = nhsContractYear(now);
  if (claims === null) {
    const reason = UNAVAILABLE.claimsFailed;
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

  const live = computeTakingsStrip({
    payments: input.payments,
    paymentsCoverage: input.paymentsCoverage,
    paymentsDropped: input.droppedPayments ?? 0,
    appointments: input.appointments,
    appointmentsCoverage: input.appointmentsCoverage,
    now: input.now,
    siteId,
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
        window,
        siteByPatientId,
        siteId,
      ),
      patients: buildPatientsPanel(
        input.patients,
        input.appointments,
        input.appointmentsCoverage,
        window,
        siteId,
      ),
      plans: buildPlansPanel(input.plans, window, siteId),
      uda: buildUdaWindowPanel(input.claims, window, siteId, practitionerNameById),
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
    ),
    udaProgress: buildUdaProgressPanel(
      input.claims,
      siteIdsInScope,
      siteId,
      input.udaTargets ?? {},
      input.now,
    ),
    periods,
    unattributedPayments: live.unattributedPayments,
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
