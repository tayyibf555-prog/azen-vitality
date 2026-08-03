// ---------------------------------------------------------------------------
// REPORT A — the band-level NHS activity breakdown, per clinician.
//
// This is the report Blerta says Dentally cannot give her: "how many band ones
// did Shizza see this month and completed them? Or how many band ones did she
// see that are still pending?" Dentally shows a total; it will not break that
// total down by clinician AND band AND state. This does.
//
// WHAT THIS HONESTLY IS, and what it deliberately is NOT:
//
//   The only source that scales to a whole practice-month is /v1/nhs_claims
//   (site-scoped, ~52k rows live). It carries band + practitioner + the claim's
//   own UDA figures. It does NOT carry the clinical `completed`/`completed_at`
//   Blerta means by "completed vs pending" — only the CLAIM-LIFECYCLE state
//   (submitted / approved / rejected). And a claim is not even created until the
//   course of treatment closes, so genuinely-open work is under-represented here.
//
//   So the split this report shows is APPROVED vs AWAITING vs REJECTED — the
//   claim's lifecycle — and it must be LABELLED as exactly that on screen, never
//   dressed up as clinical "completed vs pending". The renderer carries that
//   caveat. The two-axis question ("band ones that are also under a band-one
//   treatment CATEGORY") needs `nhs_treatment_cat`, which lives on
//   treatment_plan_items. That endpoint IS listable practice-wide (989,292 rows,
//   read-only probe 2026-08-03) and does carry nhs_treatment_cat — it is simply
//   not read by this report, and the claim→plan-item join is not calibrated
//   against live data. So the report says it is not wired yet, not that Dentally
//   cannot answer it.
//
// UDA figures come from the CLAIM'S OWN expected_uda / awarded_uda (parsed from
// the wire string to whole hundredths), never derived from the band. The band→UDA
// weight is configurable and used only as a secondary reference/forecast column.
//
// Pure functions only: no I/O, no clock reads. Callers pass the window.
// ---------------------------------------------------------------------------

import { parseUdaHundredths } from "@/lib/dashboard/money";
import { claimStatusKey, DEFAULT_INVALID_STATUSES } from "@/lib/dashboard/uda";
import { isDayInWindow, isDayKey, londonDayOfIso, type DayWindow } from "@/lib/dashboard/period";

// --- Bands ------------------------------------------------------------------

export type BandKey = "band1" | "band2" | "band3" | "urgent" | "other" | "unknown";

/** Display order. `unknown` sits last so a mis-mapped band is visible, not lost. */
export const BAND_KEYS: readonly BandKey[] = [
  "band1",
  "band2",
  "band3",
  "urgent",
  "other",
  "unknown",
] as const;

export const BAND_LABELS: Record<BandKey, string> = {
  band1: "Band 1",
  band2: "Band 2",
  band3: "Band 3",
  urgent: "Urgent",
  other: "Other",
  unknown: "Unclassified",
};

/**
 * Reduce a raw Dentally band string to a canonical key.
 *
 * 2a/2b/2c all collapse to Band 2 (they are UDA sub-weights of the same band).
 * Dentally's internal "Band 4" is the NHS's Urgent, per CHARTING.md §7. Anything
 * we do not recognise becomes `unknown` and is reported, never guessed into a
 * band it might not belong to.
 */
export function canonicalBand(raw: string | null | undefined): BandKey {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return "unknown";
  if (s === "1" || s === "band 1" || s === "band1") return "band1";
  if (s === "2" || s === "2a" || s === "2b" || s === "2c" || s === "band 2" || s === "band2") {
    return "band2";
  }
  if (s === "3" || s === "band 3" || s === "band3") return "band3";
  if (s === "urgent" || s === "4" || s === "band 4" || s === "band4") return "urgent";
  if (s === "other" || s === "0" || s === "band 0" || s === "none") return "other";
  return "unknown";
}

// --- Band → UDA weight (configurable, secondary to the claim's own figure) ---

export type BandUdaConfig = Readonly<Partial<Record<BandKey, number>>>;

/** The CHARTING.md §7 mapping (April-2026 basis). Other/unknown carry no weight. */
export const DEFAULT_BAND_UDA: BandUdaConfig = {
  band1: 1,
  band2: 3,
  band3: 12,
  urgent: 1.2,
};

/**
 * Parse a `band1=1,band3=15,...` override. A non-positive or malformed value is
 * skipped (falls back to the default) rather than becoming 0 — a zero-weight band
 * would silently erase real activity from any forecast built on it.
 */
export function parseBandUdaConfig(raw: string | undefined | null): BandUdaConfig {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ...DEFAULT_BAND_UDA };
  const out: Partial<Record<BandKey, number>> = { ...DEFAULT_BAND_UDA };
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim() as BandKey;
    if (!BAND_KEYS.includes(key)) continue;
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    out[key] = value;
  }
  return out;
}

/** The configured UDA weight for a band, or null when the band has none. */
export function udaForBand(cfg: BandUdaConfig, band: BandKey): number | null {
  const v = cfg[band];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function configuredBandUda(): BandUdaConfig {
  return parseBandUdaConfig(process.env.NHS_BAND_UDA);
}

// --- Claim outcome (the lifecycle split, honestly labelled) -----------------

export type ClaimOutcome = "approved" | "awaiting" | "rejected" | "unrecognised";

/** Statuses meaning the claim has been credited/settled. */
export const DEFAULT_APPROVED_STATUSES: readonly string[] = [
  "approved",
  "accepted",
  "paid",
  "closed",
  "complete",
  "completed",
];

/** Statuses meaning the claim is submitted and awaiting a response. */
export const DEFAULT_AWAITING_STATUSES: readonly string[] = [
  "submitted",
  "scheduled",
  "pending",
  "awaiting_approval",
];

export interface OutcomeStatusSets {
  approved?: readonly string[];
  awaiting?: readonly string[];
  rejected?: readonly string[];
}

/**
 * Classify a claim by its lifecycle. An approval date present means approved
 * whatever the status text says (the date is the harder fact). A status matching
 * nothing is `unrecognised` and counts toward no total — the same discipline the
 * dashboard UDA block uses, so an unfamiliar vocabulary cannot inflate a figure.
 */
export function classifyClaimOutcome(
  status: string,
  approvalDay: string | null,
  sets: OutcomeStatusSets = {},
): ClaimOutcome {
  const key = claimStatusKey(status);
  const rejected = new Set((sets.rejected ?? DEFAULT_INVALID_STATUSES).map(claimStatusKey));
  const approved = new Set((sets.approved ?? DEFAULT_APPROVED_STATUSES).map(claimStatusKey));
  const awaiting = new Set((sets.awaiting ?? DEFAULT_AWAITING_STATUSES).map(claimStatusKey));

  if (rejected.has(key)) return "rejected";
  if (approvalDay !== null || approved.has(key)) return "approved";
  if (awaiting.has(key)) return "awaiting";
  return "unrecognised";
}

// --- Normalising a raw /v1/nhs_claims row -----------------------------------

export interface ReportNhsClaim {
  id: string;
  siteId: string | null;
  practitionerId: string | null;
  /** London day the claim was submitted. Null when the source omits it. */
  day: string | null;
  band: BandKey;
  rawBand: string | null;
  status: string;
  approvalDay: string | null;
  outcome: ClaimOutcome;
  expectedUdaHundredths: number;
  awardedUdaHundredths: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normalise one /v1/nhs_claims record for Report A. `expected_uda` is required
 * (a claim we cannot value cannot be counted either way); `awarded_uda` defaults
 * to 0 hundredths, because a submitted-but-not-yet-awarded claim genuinely has
 * nothing awarded. A malformed UDA drops the row and is counted, never zeroed.
 */
export function normaliseReportNhsClaim(
  raw: unknown,
  sets: OutcomeStatusSets = {},
): ReportNhsClaim | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asId(r["id"]);
  if (id === null) return null;

  const expectedUdaHundredths = parseUdaHundredths(r["expected_uda"]);
  if (expectedUdaHundredths === null) return null;
  const awardedRaw = r["awarded_uda"];
  const awardedUdaHundredths =
    awardedRaw === null || awardedRaw === undefined ? 0 : parseUdaHundredths(awardedRaw);
  if (awardedUdaHundredths === null) return null;

  const submitted = r["submitted_date"];
  const day = isDayKey(submitted) ? submitted : londonDayOfIso(submitted);
  const approvalRaw = r["approval_date"];
  const approvalDay = isDayKey(approvalRaw) ? approvalRaw : londonDayOfIso(approvalRaw);

  const rawBand = typeof r["uda_band"] === "string" ? (r["uda_band"] as string) : null;
  const status = typeof r["claim_status"] === "string" ? (r["claim_status"] as string) : "";

  return {
    id,
    siteId: asId(r["site_id"]),
    practitionerId: asId(r["practitioner_id"]),
    day,
    band: canonicalBand(rawBand),
    rawBand,
    status,
    approvalDay,
    outcome: classifyClaimOutcome(status, approvalDay, sets),
    expectedUdaHundredths,
    awardedUdaHundredths,
  };
}

export interface NormaliseResult<T> {
  rows: T[];
  dropped: number;
}

export function normaliseReportNhsClaims(
  raw: readonly unknown[],
  sets: OutcomeStatusSets = {},
): NormaliseResult<ReportNhsClaim> {
  const rows: ReportNhsClaim[] = [];
  let dropped = 0;
  for (const item of raw) {
    const row = normaliseReportNhsClaim(item, sets);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  return { rows, dropped };
}

// --- The band report --------------------------------------------------------

export interface Tally {
  /** Distinct claims / courses of treatment. */
  cotCount: number;
  approvedCount: number;
  awaitingCount: number;
  rejectedCount: number;
  unrecognisedCount: number;
  /** Whole hundredths of a UDA, from the claims' own expected_uda. */
  expectedUdaHundredths: number;
  /** Whole hundredths of a UDA, from the claims' own awarded_uda. */
  awardedUdaHundredths: number;
}

export interface BandCell extends Tally {
  band: BandKey;
}

export interface PractitionerBandRow {
  practitionerId: string | null;
  bands: BandCell[];
  total: Tally;
}

export interface NhsBandReport {
  practitioners: PractitionerBandRow[];
  byBand: BandCell[];
  grandTotal: Tally;
  unknownStatuses: string[];
  filters: {
    window: DayWindow | null;
    siteId: string | null;
    practitionerId: string | null;
    band: BandKey | null;
  };
}

export interface NhsBandReportInput {
  claims: readonly ReportNhsClaim[];
  window?: DayWindow | null;
  siteId?: string | null;
  practitionerId?: string | null;
  band?: BandKey | null;
}

function emptyTally(): Tally {
  return {
    cotCount: 0,
    approvedCount: 0,
    awaitingCount: 0,
    rejectedCount: 0,
    unrecognisedCount: 0,
    expectedUdaHundredths: 0,
    awardedUdaHundredths: 0,
  };
}

function addClaim(tally: Tally, c: ReportNhsClaim): void {
  tally.cotCount += 1;
  tally.expectedUdaHundredths += c.expectedUdaHundredths;
  tally.awardedUdaHundredths += c.awardedUdaHundredths;
  if (c.outcome === "approved") tally.approvedCount += 1;
  else if (c.outcome === "awaiting") tally.awaitingCount += 1;
  else if (c.outcome === "rejected") tally.rejectedCount += 1;
  else tally.unrecognisedCount += 1;
}

/**
 * Build Report A. Counts DISTINCT claim ids so a row appearing twice in the scan
 * cannot inflate the count. Everything is grouped by practitioner × band; the
 * per-band and per-practitioner subtotals both reconcile to the grand total by
 * construction (they are the same claims summed two ways).
 */
export function computeNhsBandReport(input: NhsBandReportInput): NhsBandReport {
  const window = input.window ?? null;
  const siteId = input.siteId ?? null;
  const practitionerId = input.practitionerId ?? null;
  const bandFilter = input.band ?? null;

  const seen = new Set<string>();
  const byPractitioner = new Map<string | null, Map<BandKey, BandCell>>();
  const byBand = new Map<BandKey, BandCell>();
  const grandTotal = emptyTally();
  const unknownStatuses = new Set<string>();

  for (const c of input.claims) {
    if (siteId !== null && c.siteId !== siteId) continue;
    if (practitionerId !== null && c.practitionerId !== practitionerId) continue;
    if (bandFilter !== null && c.band !== bandFilter) continue;
    if (window !== null) {
      if (c.day === null || !isDayInWindow(c.day, window)) continue;
    }
    // Distinct COTs only.
    if (seen.has(c.id)) continue;
    seen.add(c.id);

    if (c.outcome === "unrecognised" && c.status.trim().length > 0) {
      unknownStatuses.add(c.status);
    }

    addClaim(grandTotal, c);

    let bands = byPractitioner.get(c.practitionerId);
    if (!bands) {
      bands = new Map<BandKey, BandCell>();
      byPractitioner.set(c.practitionerId, bands);
    }
    let cell = bands.get(c.band);
    if (!cell) {
      cell = { band: c.band, ...emptyTally() };
      bands.set(c.band, cell);
    }
    addClaim(cell, c);

    let bandCell = byBand.get(c.band);
    if (!bandCell) {
      bandCell = { band: c.band, ...emptyTally() };
      byBand.set(c.band, bandCell);
    }
    addClaim(bandCell, c);
  }

  const practitioners: PractitionerBandRow[] = [...byPractitioner.entries()].map(
    ([pid, bands]) => {
      const cells = orderBands([...bands.values()]);
      const total = emptyTally();
      for (const cell of cells) mergeTally(total, cell);
      return { practitionerId: pid, bands: cells, total };
    },
  );
  practitioners.sort((a, b) => {
    if (b.total.cotCount !== a.total.cotCount) return b.total.cotCount - a.total.cotCount;
    const ida = a.practitionerId ?? "";
    const idb = b.practitionerId ?? "";
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });

  return {
    practitioners,
    byBand: orderBands([...byBand.values()]),
    grandTotal,
    unknownStatuses: [...unknownStatuses].sort(),
    filters: { window, siteId, practitionerId, band: bandFilter },
  };
}

function orderBands(cells: BandCell[]): BandCell[] {
  return cells.slice().sort((a, b) => BAND_KEYS.indexOf(a.band) - BAND_KEYS.indexOf(b.band));
}

function mergeTally(into: Tally, from: Tally): void {
  into.cotCount += from.cotCount;
  into.approvedCount += from.approvedCount;
  into.awaitingCount += from.awaitingCount;
  into.rejectedCount += from.rejectedCount;
  into.unrecognisedCount += from.unrecognisedCount;
  into.expectedUdaHundredths += from.expectedUdaHundredths;
  into.awardedUdaHundredths += from.awardedUdaHundredths;
}
