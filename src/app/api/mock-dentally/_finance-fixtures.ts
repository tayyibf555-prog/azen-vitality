// ===========================================================================
// Mock Dentally fixtures for /v1/payments and /v1/nhs_claims.
//
// These drive the practice dashboard (the takings strip, the appointments
// donut, the UDA block). They are NOT real Dentally data.
//
// FIELD SHAPES ARE COPIED FROM THE LIVE API, verified 2026-07-30:
//
//   /v1/payments   id, amount (STRING, e.g. "27.9"), dated_on ("2026-07-29"),
//                  site_id, practitioner_id, patient_id, payment_plan_id,
//                  method ("Debit Card"), deleted (bool), status, account_id,
//                  reference, transaction_number. 40,243 rows live.
//
//   /v1/nhs_claims id, expected_uda (STRING, e.g. "1.56"), awarded_uda (STRING),
//                  uda_band, claim_status ("submitted"), site_id,
//                  practitioner_id, patient_id, treatment_plan_id,
//                  submitted_date, approval_date, patient_charge,
//                  dentist_charge, contract_id, ortho, triage. 52,875 rows live.
//
// UNVERIFIED VOCABULARIES, do not branch on them: the value sets for `status`
// on a payment and `uda_band` on a claim are not confirmed against live. Only
// "submitted" is confirmed for `claim_status`. The aggregation layer therefore
// reads `deleted` on payments (a boolean, unambiguous) and treats an
// unrecognised `claim_status` as counting toward nothing, rather than guessing.
//
// DETERMINISM: every value is generated from a seeded PRNG keyed on the day and
// the site, so the same calendar day always produces the same rows. Two loads of
// the dashboard never disagree, and a total is stable enough to assert against.
// The 90 day span is anchored to the CURRENT London day so the strip is
// meaningful whenever this is run, and the generated set is cached per day.
//
// DELIBERATE AWKWARD ROWS, so the defensive paths are exercised in dev rather
// than first meeting them in production:
//   - one payment with amount "" (the parser must drop it and count the drop)
//   - a handful of deleted: true payments (excluded from every total)
//   - two NHS claims with a claim_status outside the recognised sets (counted
//     toward neither completed nor invalid, reported for calibration)
// ===========================================================================

import { MOCK_PATIENTS } from "@/app/api/mock-dentally/_fixtures";
import { londonDayKey } from "@/lib/time/london";

const DAY_MS = 86_400_000;

/** The three sites the mock practice runs. */
export const MOCK_SITE_IDS = ["site-cc", "site-rv", "site-ng"] as const;

/** Matches the practitioners the /v1/practitioners mock returns for every site. */
const PRACTITIONER_IDS = ["prac-1", "prac-2"] as const;

const PAYMENT_METHODS = [
  "Debit Card",
  "Credit Card",
  "Cash",
  "Bank Transfer",
  "Direct Debit",
] as const;

/** Typical weekday payment volume per site. Busiest site first. */
const DAILY_VOLUME: Record<string, number> = {
  "site-cc": 14,
  "site-rv": 11,
  "site-ng": 9,
};

// --- Deterministic pseudo-randomness ---------------------------------------

function hash32(input: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and identical on every run for a given seed. */
function seeded(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

// --- Day helpers ------------------------------------------------------------

/** The Europe/London day, so the fixture's "today" matches the dashboard's. */
function todayKey(): string {
  return londonDayKey(new Date());
}

function shift(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday. Safe on a bare day key: UTC midnight is the same London date. */
function weekday(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

// --- Payments ---------------------------------------------------------------

export interface MockPayment {
  id: string;
  amount: string;
  dated_on: string;
  site_id: string;
  practitioner_id: string;
  patient_id: string;
  payment_plan_id: string | null;
  method: string;
  deleted: boolean;
  status: string;
  account_id: string;
  reference: string;
  transaction_number: string;
}

/**
 * Format pence the way Dentally does: two decimal places with a single trailing
 * zero stripped, so 2790 becomes "27.9" and 18500 becomes "185.0". This matches
 * the live sample exactly and keeps the parser honest about string input.
 */
function penceToDentallyString(pence: number): string {
  const fixed = (pence / 100).toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

/** A plausible dental payment, in pence. */
function paymentAmountPence(rand: () => number): number {
  const roll = rand();
  if (roll < 0.28) {
    // NHS band charges and small balances.
    return pick(rand, [2790, 2650, 7010, 9060, 2340, 3120]);
  }
  if (roll < 0.72) {
    // Routine private work: exams, hygiene, fillings.
    return 4500 + Math.floor(rand() * 21_000);
  }
  if (roll < 0.95) {
    // Larger course-of-treatment instalments.
    return 25_000 + Math.floor(rand() * 65_000);
  }
  // Implant, ortho or full-arch deposits.
  return 90_000 + Math.floor(rand() * 260_000);
}

function patientsForSiteId(siteId: string): string[] {
  const ids = MOCK_PATIENTS.filter((p) => p.site_id === siteId).map((p) => p.id);
  return ids.length > 0 ? ids : MOCK_PATIENTS.map((p) => p.id);
}

function paymentsForSiteDay(siteId: string, day: string): MockPayment[] {
  const dow = weekday(day);
  if (dow === 0) return []; // Closed on Sundays.
  const rand = seeded(`payments|${siteId}|${day}`);
  const base = DAILY_VOLUME[siteId] ?? 10;
  const volume = dow === 6 ? Math.round(base * 0.4) : base + Math.floor(rand() * 7) - 3;
  const patients = patientsForSiteId(siteId);

  const rows: MockPayment[] = [];
  for (let i = 0; i < Math.max(0, volume); i += 1) {
    const pence = paymentAmountPence(rand);
    // Roughly one payment in sixty is voided and soft deleted.
    const deleted = rand() < 0.017;
    rows.push({
      id: `pay-${day}-${siteId}-${i}`,
      amount: penceToDentallyString(pence),
      dated_on: day,
      site_id: siteId,
      practitioner_id: pick(rand, PRACTITIONER_IDS),
      patient_id: pick(rand, patients),
      payment_plan_id: rand() < 0.2 ? `pp-${String((i % 9) + 1).padStart(3, "0")}` : null,
      method: pick(rand, PAYMENT_METHODS),
      deleted,
      // Vocabulary UNVERIFIED against live. Nothing reads this field.
      status: deleted ? "void" : "complete",
      account_id: `acc-${siteId}-${i % 40}`,
      reference: `REF-${day.replace(/-/g, "")}-${i}`,
      transaction_number: String(hash32(`${siteId}${day}${i}`) % 1_000_000),
    });
  }
  return rows;
}

/** How many days back the mock generates. Matches the longest strip period. */
const PAYMENT_HISTORY_DAYS = 90;

/**
 * The one deliberately malformed amount, on a fixed day so it is reproducible.
 * A dashboard that reports this as £0.00 has a bug; it must be dropped, counted
 * and disclosed.
 */
const MALFORMED_AMOUNT_DAYS_AGO = 45;

function buildPayments(today: string): MockPayment[] {
  const rows: MockPayment[] = [];
  for (let back = 0; back < PAYMENT_HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const siteId of MOCK_SITE_IDS) rows.push(...paymentsForSiteDay(siteId, day));
    if (back === MALFORMED_AMOUNT_DAYS_AGO) {
      rows.push({
        id: `pay-${day}-site-cc-malformed`,
        amount: "",
        dated_on: day,
        site_id: "site-cc",
        practitioner_id: "prac-1",
        patient_id: "pat-001",
        payment_plan_id: null,
        method: "Cash",
        deleted: false,
        status: "complete",
        account_id: "acc-site-cc-0",
        reference: `REF-${day.replace(/-/g, "")}-X`,
        transaction_number: "0",
      });
    }
  }
  // Newest first, exactly as the live API returns them.
  rows.sort((a, b) => (a.dated_on === b.dated_on ? (a.id < b.id ? -1 : 1) : a.dated_on < b.dated_on ? 1 : -1));
  return rows;
}

let paymentCache: { day: string; rows: MockPayment[] } | null = null;

/** Every mock payment, newest first. Rebuilt once per London day. */
export function allPayments(): MockPayment[] {
  const today = todayKey();
  if (paymentCache?.day !== today) paymentCache = { day: today, rows: buildPayments(today) };
  return paymentCache.rows;
}

// --- NHS claims -------------------------------------------------------------

export interface MockNhsClaim {
  id: string;
  expected_uda: string;
  awarded_uda: string;
  uda_band: string;
  claim_status: string;
  site_id: string;
  practitioner_id: string;
  patient_id: string;
  treatment_plan_id: string;
  submitted_date: string;
  approval_date: string | null;
  patient_charge: string;
  dentist_charge: string;
  contract_id: string;
  ortho: boolean;
  triage: boolean;
}

/**
 * UDA values per band. The standard NHS bands are 1, 3 and 12 UDAs with 1.2 for
 * urgent care; the live sample also carries values such as "1.56", which do not
 * match any standard band, so one is included verbatim. Nothing in the
 * aggregation derives a UDA figure from the band: it reads expected_uda and
 * awarded_uda, which is why an unfamiliar band cannot corrupt a total.
 */
const UDA_BANDS: readonly { band: string; uda: number; patientCharge: number }[] = [
  { band: "1", uda: 1, patientCharge: 2790 },
  { band: "2", uda: 3, patientCharge: 7610 },
  { band: "3", uda: 12, patientCharge: 33_040 },
  { band: "urgent", uda: 1.2, patientCharge: 2790 },
  { band: "other", uda: 1.56, patientCharge: 2790 },
];

/** Weighted so band 1 and band 2 dominate, as they do in a real book. */
function pickBand(rand: () => number): (typeof UDA_BANDS)[number] {
  const roll = rand();
  if (roll < 0.46) return UDA_BANDS[0];
  if (roll < 0.8) return UDA_BANDS[1];
  if (roll < 0.9) return UDA_BANDS[2];
  if (roll < 0.96) return UDA_BANDS[3];
  return UDA_BANDS[4];
}

/** Two decimal places, as the live API returns UDA and charge figures. */
function udaString(uda: number): string {
  return uda.toFixed(2);
}

/** The NHS contract year containing a London day: 1 April to 31 March. */
function contractYearStart(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return `${month >= 4 ? year : year - 1}-04-01`;
}

function claimsForSiteDay(siteId: string, day: string): MockNhsClaim[] {
  const dow = weekday(day);
  if (dow === 0) return [];
  const rand = seeded(`claims|${siteId}|${day}`);
  const volume = dow === 6 ? 2 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 8);
  const patients = patientsForSiteId(siteId);

  const rows: MockNhsClaim[] = [];
  for (let i = 0; i < volume; i += 1) {
    const band = pickBand(rand);
    const roll = rand();
    const status = roll < 0.76 ? "submitted" : roll < 0.94 ? "approved" : "rejected";
    const rejected = status === "rejected";
    rows.push({
      id: `claim-${day}-${siteId}-${i}`,
      expected_uda: udaString(band.uda),
      awarded_uda: rejected ? "0.00" : udaString(band.uda),
      uda_band: band.band,
      claim_status: status,
      site_id: siteId,
      practitioner_id: pick(rand, PRACTITIONER_IDS),
      patient_id: pick(rand, patients),
      treatment_plan_id: `plan-${String((i % 10) + 1).padStart(3, "0")}`,
      submitted_date: day,
      approval_date: status === "approved" ? shift(day, 9) : null,
      patient_charge: (band.patientCharge / 100).toFixed(2),
      dentist_charge: "0.00",
      contract_id: `contract-${siteId}`,
      ortho: rand() < 0.06,
      triage: rand() < 0.03,
    });
  }
  return rows;
}

/**
 * Claims are generated across the whole contract year to date, not just the last
 * 90 days, because the UDA progress line is measured against the annual contract
 * and a 90 day slice would understate it. Capped at a year so the set stays small.
 */
function buildClaims(today: string): MockNhsClaim[] {
  const start = contractYearStart(today);
  const earliest = shift(today, -364);
  const from = start > earliest ? start : earliest;

  const rows: MockNhsClaim[] = [];
  for (let day = today; day >= from; day = shift(day, -1)) {
    for (const siteId of MOCK_SITE_IDS) rows.push(...claimsForSiteDay(siteId, day));
  }

  // Two claims with a status outside both recognised sets, on a fixed day. The
  // aggregation must count them toward neither completed nor invalid UDAs, and
  // report the status so it can be calibrated against the live vocabulary.
  const oddDay = shift(today, -12);
  for (let i = 0; i < 2; i += 1) {
    rows.push({
      id: `claim-${oddDay}-site-rv-unknown-${i}`,
      expected_uda: "3.00",
      awarded_uda: "0.00",
      uda_band: "2",
      claim_status: "awaiting_pcse_response",
      site_id: "site-rv",
      practitioner_id: "prac-2",
      patient_id: "pat-002",
      treatment_plan_id: "plan-002",
      submitted_date: oddDay,
      approval_date: null,
      patient_charge: "76.10",
      dentist_charge: "0.00",
      contract_id: "contract-site-rv",
      ortho: false,
      triage: false,
    });
  }

  rows.sort((a, b) =>
    a.submitted_date === b.submitted_date
      ? a.id < b.id
        ? -1
        : 1
      : a.submitted_date < b.submitted_date
        ? 1
        : -1,
  );
  return rows;
}

let claimCache: { day: string; rows: MockNhsClaim[] } | null = null;

/** Every mock NHS claim, newest first. Rebuilt once per London day. */
export function allNhsClaims(): MockNhsClaim[] {
  const today = todayKey();
  if (claimCache?.day !== today) claimCache = { day: today, rows: buildClaims(today) };
  return claimCache.rows;
}
