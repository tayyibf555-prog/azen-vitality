// ---------------------------------------------------------------------------
// The dashboard aggregation layer: pure, no I/O, one export surface.
//
// Every function here takes data in and gives numbers out. Nothing in this
// folder reads the clock, calls Dentally, or touches the database, so all of it
// is unit tested in plain .ts against fixed inputs and a fixed `now`.
//
// Two rules run through all of it:
//   - A figure that cannot be sourced is null, with a reason. Never a zero.
//   - Every day boundary is a Europe/London day, via src/lib/time/london.ts.
// ---------------------------------------------------------------------------

export {
  formatPenceGbp,
  hundredthsToUda,
  parseMoneyPence,
  parseUdaHundredths,
  penceToPounds,
  round2,
} from "@/lib/dashboard/money";

export {
  DASHBOARD_PERIODS,
  PERIOD_LABELS,
  coversWindow,
  dayKeyDiff,
  daysInWindow,
  isDayInWindow,
  isDayKey,
  londonDayOfIso,
  londonToday,
  periodWindow,
  shiftDayKey,
  windowLength,
  type DashboardPeriod,
  type DayCoverage,
  type DayWindow,
} from "@/lib/dashboard/period";

export {
  normaliseAccountBalance,
  normaliseAccountBalances,
  normaliseAppointment,
  normaliseAppointments,
  normaliseNhsClaim,
  normaliseNhsClaims,
  normalisePatient,
  normalisePatients,
  normalisePayment,
  normalisePayments,
  normaliseTreatmentPlan,
  normaliseTreatmentPlans,
  type DashboardAccountBalance,
  type DashboardAppointment,
  type DashboardNhsClaim,
  type DashboardPatient,
  type DashboardPayment,
  type DashboardTreatmentPlan,
  type NormaliseResult,
} from "@/lib/dashboard/normalise";

export {
  computeTakingsStrip,
  computeTakingsStripFromRollup,
  normaliseRollupDay,
  normaliseRollupDays,
  type DashboardRollupDay,
  type RollupStripInput,
  type TakingsCell,
  type TakingsStrip,
  type TakingsStripInput,
} from "@/lib/dashboard/takings";

export {
  classifyState,
  computeOutcomeSplit,
  countPatientsSeen,
  stateKey,
  type OutcomeBucket,
  type OutcomeSplit,
  type OutcomeSplitInput,
} from "@/lib/dashboard/appointments";

export {
  computeInvoicedTotals,
  computeOutstandingAccounts,
  type InvoicedTotals,
  type OutstandingAccounts,
  type RankedAccount,
} from "@/lib/dashboard/accounts";

export {
  computePatientCounts,
  computeTreatmentPlanCounts,
  type PatientCounts,
  type TreatmentPlanCounts,
} from "@/lib/dashboard/patients";

export {
  DEFAULT_INVALID_STATUSES,
  DEFAULT_VALID_STATUSES,
  claimStatusKey,
  computeUdaByPractitioner,
  computeUdaProgress,
  computeUdaTotals,
  nhsContractYear,
  type ContractYear,
  type PractitionerUdaTotals,
  type UdaProgress,
  type UdaTotals,
} from "@/lib/dashboard/uda";
