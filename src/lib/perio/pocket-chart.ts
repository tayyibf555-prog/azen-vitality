// ===========================================================================
// THE SIX-POINT POCKET CHART — building, summarising, and comparing over time.
//
// PURE. No I/O, no React, no clock. Every timestamp is passed in by the caller,
// because a Date.now() in a render path is a bug this repo has already paid for.
//
// THREE THINGS IN HERE ARE LOAD-BEARING, and each one is a way a periodontal
// chart lies if it is built casually:
//
//   1. CAL IS COMPUTED, NEVER TYPED. It is probing depth + recession and nothing
//      else. A stored CAL is a number that can disagree with its own components,
//      and the disagreement is invisible on screen. The input types ban the
//      field at compile time (`cal?: never`) AND the builder refuses it at
//      runtime, because a chart arriving as JSON from a route body is not
//      protected by the type system at all.
//
//   2. A PARTIAL CHART IS NEVER SUMMARISED AS A FULL ONE. A BPE code 3 requires
//      one sextant to be charted, so a partial chart is the NORMAL case, not an
//      error. But "18% bleeding" computed over the lower right and printed
//      without its scope reads as a whole-mouth result, which is the "false
//      completeness" failure CHARTING.md §6.3 says is the specific way this
//      screen kills someone. Coverage is carried on the view, every summary
//      states its own scope, and `describeCoverage` writes the sentence.
//
//   3. A TOOTH THAT IS GONE IS NOT AN IMPROVEMENT. The naive diff — pocket was
//      9mm, tooth no longer in the chart, therefore 9mm of improvement — turns
//      the worst possible outcome into the best-looking number on the page.
//      Teeth that are not in both charts are excluded from every headline figure
//      and reported separately, by name.
//
// WHAT THIS FILE DOES NOT DO: it does not decide anything clinical. Staging and
// grading live in diagnosis.ts, and both are decision support.
//
// SEXTANT MAP: this file used to derive its own `sextantOfTooth` from the FDI
// numbering. bpe.ts exports an equivalent, written out as the table in
// PERIO.md §3.1, so — as the note here always said should happen — the copy in
// this file has been deleted and bpe.ts's is imported. Two hand-written sextant
// tables is precisely how two screens come to disagree about which sextant a
// tooth is in. bpe.ts owns the sextant vocabulary; this file owns the sites.
// (The two were verified to have identical membership before the deletion: same
// 28 teeth, third molars and the deciduous dentition in neither.)
// ===========================================================================

import { displayNumber, isDeciduous, isTooth, quadrantOf } from "@/lib/charting/fdi";
import { SEXTANTS, SEXTANT_LABEL, sextantOfTooth } from "./bpe";
import type {
  ClinicianRef,
  FurcationGrade,
  MobilityStage,
  PerioAttribution,
  PerioProbe,
  PerioSiteId,
  PerioSiteMeasurement,
  PerioSurfaceId,
  PerioToothRecord,
  SextantId,
  SurfaceFinding,
} from "./types";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Entry order around a tooth: the buccal row, then the lingual row. */
export const SITE_IDS: readonly PerioSiteId[] = ["mb", "b", "db", "ml", "l", "dl"];

export const SITE_LABEL: Record<PerioSiteId, string> = {
  mb: "mesiobuccal",
  b: "buccal",
  db: "distobuccal",
  ml: "mesiolingual",
  l: "lingual",
  dl: "distolingual",
};

/** The four interproximal sites. Staging in the 2017/18 classification is done
 *  on INTERDENTAL attachment loss, so the mid-buccal and mid-lingual readings —
 *  which are where recession from brushing shows up — must not be mistaken for
 *  it. diagnosis.ts reads this. */
export const INTERPROXIMAL_SITES: readonly PerioSiteId[] = ["mb", "db", "ml", "dl"];

/**
 * SEXTANTS, SEXTANT_LABEL, sextantOfTooth and SEXTANT_TEETH are NOT declared
 * here. They live in bpe.ts and are imported at the top of this file — see the
 * SEXTANT MAP note in the header. `SEXTANTS` is bpe.ts's ordering (upper right →
 * upper left, then lower right → lower left, the order a BPE grid is written and
 * spoken), and it is the order every list and sentence below is built in.
 *
 * NULL IS A REAL ANSWER from sextantOfTooth, not a failure. The third molars sit
 * outside the sextant scheme entirely, and so does the deciduous dentition. A
 * third molar CAN be six-point charted, so its readings are kept and counted in
 * the whole-chart figures — they just belong to no sextant, and the chart says so
 * out loud rather than dropping them.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * A site as it is TYPED. PerioSiteMeasurement already has no `cal` field; this
 * adds the explicit ban, so a caller that carries a CAL around in its own shape
 * gets a compiler error at the boundary instead of having it silently dropped.
 */
export type SiteMeasurementInput = PerioSiteMeasurement & {
  cal?: never;
  attachmentLoss?: never;
  clinicalAttachmentLevel?: never;
};

export interface ToothRecordInput extends Omit<PerioToothRecord, "sites"> {
  sites: readonly SiteMeasurementInput[];
}

export interface PocketChartInput {
  /** The sextants the clinician SET OUT to chart. A BPE code 3 charts one; a
   *  code 4 charts all six. Declaring the scope is what makes a partial chart
   *  legible as a deliberate partial chart rather than an abandoned full one. */
  sextants: readonly SextantId[];
  teeth: readonly ToothRecordInput[];
  /** Not optional. GDC Standard 4.1.4. */
  recorded: PerioAttribution;
  probe?: PerioProbe;
  id?: string | null;
  siteId?: string | null;
  patientId?: string | null;
  supersedesId?: string | null;
  amendmentReason?: string | null;
}

// ---------------------------------------------------------------------------
// The built view
// ---------------------------------------------------------------------------

export interface ChartedSite extends PerioSiteMeasurement {
  /**
   * COMPUTED: probing depth + recession. Null when either component is missing,
   * because a CAL derived from a guessed zero is a fabricated measurement.
   * Negative recession (margin coronal to the CEJ) legitimately produces a CAL
   * smaller than the pocket, and it is NOT clamped to zero.
   */
  cal: number | null;
  /** A probing depth was recorded here. Everything else is a property OF a
   *  reading, so a site with no depth carries no findings at all. */
  recorded: boolean;
  interproximal: boolean;
}

export interface ChartedTooth {
  tooth: number;
  sextant: SextantId | null;
  sites: ChartedSite[];
  mobility: MobilityStage | null;
  furcation: FurcationGrade | null;
  recordedSites: number;
  deepestPocket: number | null;
  worstCal: number | null;
  /** The worst CAL at an INTERPROXIMAL site. This, not worstCal, is what
   *  staging is defined on. */
  worstInterproximalCal: number | null;
}

export type ChartCoverage = "full-mouth" | "partial";

export interface PocketChartView {
  id: string | null;
  siteId: string | null;
  patientId: string | null;
  probe: PerioProbe;
  recorded: PerioAttribution;
  supersedesId: string | null;
  amendmentReason: string | null;
  /** What the clinician set out to chart. */
  declaredSextants: SextantId[];
  /** What actually holds at least one reading. */
  chartedSextants: SextantId[];
  /** Declared, then left empty. A gap in a chart that claims to cover them. */
  emptyDeclaredSextants: SextantId[];
  /** "full-mouth" ONLY when all six sextants hold readings. Nothing else. */
  coverage: ChartCoverage;
  teeth: ChartedTooth[];
  /** Charted teeth belonging to no sextant (third molars). In the whole-chart
   *  figures, in no sextant's figures, and named in the caveats. */
  teethOutsideSextantScheme: number[];
  /** Whole sentences, for the screen. Never fragments to be templated. */
  caveats: string[];
}

export class PerioValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "PerioValidationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// THE MEASUREMENT RANGES, DECLARED ONCE.
//
// EXPORTED, and exported for a reason rather than for tidiness. These numbers
// were written out a second time in the entry grid and a THIRD time, differently,
// in the database: 0066_perio.sql allowed a recession of -10 to 20 while this
// module allowed -5 to 15. Nothing bad could reach the table through the app,
// because the app was the stricter of the two — but a measurement with two
// definitions has already started drifting, and the check constraint is the last
// line if anything ever writes directly.
//
// So there is one definition, here, and:
//   - pocket-chart.tsx imports these instead of declaring its own;
//   - 0066_perio.sql's check constraints carry the same numbers, and
//     src/lib/perio/measurement-ranges.test.ts reads the SQL and fails if they
//     ever stop matching.
//
// WHY -5 TO 15 IS THE RIGHT PAIR, rather than the database's wider one. The
// maximum is the probe: a WHO 621 is banded to 5.5mm and a UNC-15 is marked to
// 15mm, so 15 is the largest reading the instrument can produce and matches
// MAX_PROBING_DEPTH_MM. The minimum is negative because the gingival margin can
// sit CORONAL to the CEJ (overgrowth, or an unrecessed deep pocket) and clamping
// that at zero would inflate every CAL derived from it; -5mm of overgrowth is
// already a florid hyperplasia, and -10 buys nothing but room for a typo. The
// wider pair was not clinically argued anywhere — it was simply looser.
// ---------------------------------------------------------------------------

/** The deepest probing depth an instrument marked to 15mm can report. */
export const MAX_PROBING_DEPTH_MM = 15;
/** Negative recession is a margin coronal to the CEJ, and is never clamped. */
export const MIN_RECESSION_MM = -5;
export const MAX_RECESSION_MM = 15;

/** Keys that must never arrive on a site. Checked at runtime because a chart
 *  posted to an API route is an `unknown` that TypeScript never saw. */
const FORBIDDEN_SITE_KEYS = ["cal", "CAL", "attachmentLoss", "clinicalAttachmentLevel"];

function isSextantId(value: unknown): value is SextantId {
  return typeof value === "string" && (SEXTANTS as readonly string[]).includes(value);
}

function isSiteId(value: unknown): value is PerioSiteId {
  return typeof value === "string" && (SITE_IDS as readonly string[]).includes(value);
}

function isIsoInstant(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * Everything wrong with this chart, as whole sentences. Empty means valid.
 *
 * Returned as a list rather than thrown so a route can answer with all of it at
 * once; buildPocketChart throws the same list as a PerioValidationError.
 */
export function validatePocketChart(input: PocketChartInput): string[] {
  const issues: string[] = [];

  if (input.sextants.length === 0) {
    issues.push("A chart must declare which sextants it covers; this one declares none.");
  }
  const seenSextants = new Set<SextantId>();
  for (const sextant of input.sextants) {
    if (!isSextantId(sextant)) {
      issues.push(`"${String(sextant)}" is not one of the six sextants.`);
      continue;
    }
    if (seenSextants.has(sextant)) {
      issues.push(`The ${SEXTANT_LABEL[sextant]} sextant is declared twice.`);
    }
    seenSextants.add(sextant);
  }

  const clinician: ClinicianRef | undefined = input.recorded?.clinician;
  if (!clinician || typeof clinician.id !== "string" || clinician.id.trim() === "") {
    issues.push("A chart must record which clinician made it; no clinician id was given.");
  }
  if (!clinician || typeof clinician.name !== "string" || clinician.name.trim() === "") {
    issues.push("A chart must record the treating clinician's name (GDC Standard 4.1.4).");
  }
  if (!isIsoInstant(input.recorded?.at)) {
    issues.push("A chart must record when it was made, as an ISO-8601 instant supplied by the caller.");
  }

  const seenTeeth = new Set<number>();
  for (const tooth of input.teeth) {
    const fdi = tooth.tooth;
    if (!isTooth(fdi)) {
      issues.push(`${String(fdi)} is not an FDI tooth number.`);
      continue;
    }
    if (isDeciduous(fdi)) {
      issues.push(
        `Tooth ${fdi} is a deciduous tooth. Six-point periodontal charting is defined for the permanent dentition.`,
      );
      continue;
    }
    if (seenTeeth.has(fdi)) {
      issues.push(`Tooth ${fdi} appears twice in the same chart.`);
      continue;
    }
    seenTeeth.add(fdi);

    const sextant = sextantOfTooth(fdi);
    if (sextant && !seenSextants.has(sextant)) {
      issues.push(
        `Tooth ${fdi} is charted but the ${SEXTANT_LABEL[sextant]} sextant is not one this chart says it covers.`,
      );
    }

    // THE SCALES ARE DENTALLY'S. Mobility is recorded in stages 1–3 and
    // furcation in grades 1–4, because that is what their `m` and `f` keys
    // cycle through and staff must not have to relearn a scale. There is no 0
    // in either: "nothing found" is null. See MobilityStage / FurcationGrade.
    if (tooth.mobility !== null && tooth.mobility !== undefined) {
      if (!Number.isInteger(tooth.mobility) || tooth.mobility < 1 || tooth.mobility > 3) {
        issues.push(
          `Tooth ${fdi}: mobility is recorded in stages 1, 2 and 3, not ${String(tooth.mobility)}. Leave it unset where no mobility was found.`,
        );
      }
    }
    if (tooth.furcation !== null && tooth.furcation !== undefined) {
      if (!Number.isInteger(tooth.furcation) || tooth.furcation < 1 || tooth.furcation > 4) {
        issues.push(
          `Tooth ${fdi}: furcation is recorded in grades 1, 2, 3 and 4, not ${String(tooth.furcation)}. Leave it unset where no furcation involvement was found.`,
        );
      } else if (displayNumber(fdi) <= 3) {
        issues.push(
          `Tooth ${fdi} is single-rooted, so it has no furcation to grade. A furcation grade here is a mis-keyed tooth.`,
        );
      }
    }

    const seenSites = new Set<PerioSiteId>();
    for (const site of tooth.sites) {
      if (!isSiteId(site.site)) {
        issues.push(`Tooth ${fdi}: "${String(site.site)}" is not one of the six sites.`);
        continue;
      }
      if (seenSites.has(site.site)) {
        issues.push(`Tooth ${fdi}: the ${SITE_LABEL[site.site]} site is recorded twice.`);
      }
      seenSites.add(site.site);

      for (const key of FORBIDDEN_SITE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(site, key)) {
          issues.push(
            `Tooth ${fdi}, ${SITE_LABEL[site.site]}: "${key}" was supplied. Attachment loss is computed from probing depth and recession and is never typed, because a stored value can disagree with the measurements it claims to come from.`,
          );
        }
      }

      const depth = site.probingDepth;
      if (depth !== null && depth !== undefined) {
        if (!Number.isInteger(depth) || depth < 0 || depth > MAX_PROBING_DEPTH_MM) {
          issues.push(
            `Tooth ${fdi}, ${SITE_LABEL[site.site]}: a probing depth of ${String(depth)}mm is not a whole number of millimetres between 0 and ${MAX_PROBING_DEPTH_MM}.`,
          );
        }
      }
      const recession = site.recession;
      if (recession !== null && recession !== undefined) {
        if (!Number.isInteger(recession) || recession < MIN_RECESSION_MM || recession > MAX_RECESSION_MM) {
          issues.push(
            `Tooth ${fdi}, ${SITE_LABEL[site.site]}: a recession of ${String(recession)}mm is not a whole number of millimetres between ${MIN_RECESSION_MM} and ${MAX_RECESSION_MM}.`,
          );
        }
      }
      if (depth === null || depth === undefined) {
        const findings: string[] = [];
        if (site.bleeding) findings.push("bleeding");
        if (site.suppuration) findings.push("suppuration");
        if (site.plaque) findings.push("plaque");
        if (recession !== null && recession !== undefined) findings.push("recession");
        if (findings.length > 0) {
          issues.push(
            `Tooth ${fdi}, ${SITE_LABEL[site.site]}: ${findings.join(", ")} recorded with no probing depth. A finding at a site that was not probed cannot be placed.`,
          );
        }
      }
    }
  }

  if (input.supersedesId && (input.amendmentReason ?? "").trim() === "") {
    issues.push("An amendment must say why it was made (GDC Standard 4.1.5).");
  }

  return issues;
}

function emptySite(site: PerioSiteId): ChartedSite {
  return {
    site,
    probingDepth: null,
    recession: null,
    bleeding: false,
    suppuration: false,
    plaque: false,
    cal: null,
    recorded: false,
    interproximal: (INTERPROXIMAL_SITES as readonly string[]).includes(site),
  };
}

function buildSite(input: SiteMeasurementInput): ChartedSite {
  const depth = input.probingDepth ?? null;
  const recession = input.recession ?? null;
  const recorded = depth !== null;
  return {
    site: input.site,
    probingDepth: depth,
    recession,
    bleeding: recorded ? Boolean(input.bleeding) : false,
    suppuration: recorded ? Boolean(input.suppuration) : false,
    plaque: recorded ? Boolean(input.plaque) : false,
    // The one and only place attachment loss is ever produced.
    cal: depth !== null && recession !== null ? depth + recession : null,
    recorded,
    interproximal: (INTERPROXIMAL_SITES as readonly string[]).includes(input.site),
  };
}

function toothOrder(a: number, b: number): number {
  const qa = quadrantOf(a);
  const qb = quadrantOf(b);
  if (qa !== qb) return qa - qb;
  return displayNumber(a) - displayNumber(b);
}

/**
 * Validate, compute, and describe. Throws PerioValidationError rather than
 * returning a half-built chart: a six-point chart that silently dropped the
 * readings it could not understand is the "false completeness" failure again.
 */
export function buildPocketChart(input: PocketChartInput): PocketChartView {
  const issues = validatePocketChart(input);
  if (issues.length > 0) throw new PerioValidationError(issues);

  const teeth: ChartedTooth[] = [...input.teeth]
    .sort((a, b) => toothOrder(a.tooth, b.tooth))
    .map((tooth) => {
      const byId = new Map<PerioSiteId, ChartedSite>();
      for (const site of tooth.sites) byId.set(site.site, buildSite(site));
      const sites = SITE_IDS.map((id) => byId.get(id) ?? emptySite(id));
      const recorded = sites.filter((s) => s.recorded);
      const depths = recorded.map((s) => s.probingDepth as number);
      const cals = recorded.map((s) => s.cal).filter((c): c is number => c !== null);
      const interCals = recorded
        .filter((s) => s.interproximal)
        .map((s) => s.cal)
        .filter((c): c is number => c !== null);
      return {
        tooth: tooth.tooth,
        sextant: sextantOfTooth(tooth.tooth),
        sites,
        mobility: tooth.mobility ?? null,
        furcation: tooth.furcation ?? null,
        recordedSites: recorded.length,
        deepestPocket: depths.length > 0 ? Math.max(...depths) : null,
        worstCal: cals.length > 0 ? Math.max(...cals) : null,
        worstInterproximalCal: interCals.length > 0 ? Math.max(...interCals) : null,
      };
    });

  const declaredSextants = SEXTANTS.filter((s) => input.sextants.includes(s));
  const chartedSextants = SEXTANTS.filter((s) =>
    teeth.some((t) => t.sextant === s && t.recordedSites > 0),
  );
  const emptyDeclaredSextants = declaredSextants.filter((s) => !chartedSextants.includes(s));
  const teethOutsideSextantScheme = teeth
    .filter((t) => t.sextant === null && t.recordedSites > 0)
    .map((t) => t.tooth);

  const coverage: ChartCoverage = chartedSextants.length === SEXTANTS.length ? "full-mouth" : "partial";

  const caveats: string[] = [];
  if (coverage === "partial") {
    caveats.push(
      chartedSextants.length === 0
        ? "This chart holds no readings at all, so nothing can be concluded from it."
        : `This is a partial chart: it covers the ${listSextants(chartedSextants)}. Every figure below is of the sites actually charted, not of the whole mouth.`,
    );
  }
  if (emptyDeclaredSextants.length > 0) {
    caveats.push(
      `The chart says it covers the ${listSextants(emptyDeclaredSextants)}, but no readings were recorded there. That sextant is unexamined, which is not the same as healthy.`,
    );
  }
  if (teethOutsideSextantScheme.length > 0) {
    caveats.push(
      `${teethOutsideSextantScheme.length === 1 ? "Tooth" : "Teeth"} ${teethOutsideSextantScheme.join(", ")} ${teethOutsideSextantScheme.length === 1 ? "is" : "are"} charted but ${teethOutsideSextantScheme.length === 1 ? "sits" : "sit"} outside the six-sextant scheme, which runs 17–14, 13–23, 24–27, 34–37, 33–43 and 44–47. Those readings are in the whole-chart figures and in no sextant's figures.`,
    );
  }

  return {
    id: input.id ?? null,
    siteId: input.siteId ?? null,
    patientId: input.patientId ?? null,
    probe: input.probe ?? "who-621",
    recorded: input.recorded,
    supersedesId: input.supersedesId ?? null,
    amendmentReason: input.amendmentReason ?? null,
    declaredSextants,
    chartedSextants,
    emptyDeclaredSextants,
    coverage,
    teeth,
    teethOutsideSextantScheme,
    caveats,
  };
}

function listSextants(sextants: readonly SextantId[]): string {
  const names = sextants.map((s) => SEXTANT_LABEL[s]);
  if (names.length === 0) return "no sextants";
  if (names.length === 1) return `${names[0]} sextant`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} sextants`;
}

/** One sentence naming what this chart does and does not cover. The screen must
 *  print this anywhere a percentage from a partial chart is shown. */
export function describeCoverage(chart: PocketChartView): string {
  if (chart.coverage === "full-mouth") {
    return "Full-mouth six-point chart: all six sextants hold readings.";
  }
  if (chart.chartedSextants.length === 0) {
    return "No sextant holds a reading, so this chart says nothing about this mouth.";
  }
  return `Partial six-point chart — ${listSextants(chart.chartedSextants)} only. Percentages are of the charted sites, not of the whole mouth.`;
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export interface SiteRef {
  tooth: number;
  site: PerioSiteId;
}

export interface PerioStats {
  teethCharted: number;
  sitesRecorded: number;
  bleedingSites: number;
  plaqueSites: number;
  suppurationSites: number;
  sites4mmPlus: number;
  sites6mmPlus: number;
  /** Percentages are of RECORDED sites and of nothing else. Null when nothing
   *  was recorded — a bleeding score of 0% on an unexamined mouth is a claim. */
  bopPercent: number | null;
  plaquePercent: number | null;
  percent4mmPlus: number | null;
  deepestPocket: number | null;
  deepestPocketAt: SiteRef | null;
  worstCal: number | null;
  worstCalAt: SiteRef | null;
  teethWithMobility: number[];
  teethWithFurcation: number[];
}

function percent(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Statistics over exactly the teeth handed in. Scope is the caller's problem;
 *  every caller in this file states it. */
export function computeStats(teeth: readonly ChartedTooth[]): PerioStats {
  let sitesRecorded = 0;
  let bleedingSites = 0;
  let plaqueSites = 0;
  let suppurationSites = 0;
  let sites4mmPlus = 0;
  let sites6mmPlus = 0;
  let deepestPocket: number | null = null;
  let deepestPocketAt: SiteRef | null = null;
  let worstCal: number | null = null;
  let worstCalAt: SiteRef | null = null;
  const teethWithMobility: number[] = [];
  const teethWithFurcation: number[] = [];
  let teethCharted = 0;

  for (const tooth of teeth) {
    if (tooth.recordedSites > 0) teethCharted += 1;
    // `!== null` and NOT `> 0`. On the old Miller scale a 0 was a legal value
    // meaning "no mobility", so "has mobility" had to be a `> 0` test. On
    // Dentally's 1–3 scale there is no 0 at all: any stage present IS a
    // finding, and the absence of one is null.
    if (tooth.mobility !== null) teethWithMobility.push(tooth.tooth);
    if (tooth.furcation !== null) teethWithFurcation.push(tooth.tooth);
    for (const site of tooth.sites) {
      if (!site.recorded) continue;
      const depth = site.probingDepth as number;
      sitesRecorded += 1;
      if (site.bleeding) bleedingSites += 1;
      if (site.plaque) plaqueSites += 1;
      if (site.suppuration) suppurationSites += 1;
      if (depth >= 4) sites4mmPlus += 1;
      if (depth >= 6) sites6mmPlus += 1;
      if (deepestPocket === null || depth > deepestPocket) {
        deepestPocket = depth;
        deepestPocketAt = { tooth: tooth.tooth, site: site.site };
      }
      if (site.cal !== null && (worstCal === null || site.cal > worstCal)) {
        worstCal = site.cal;
        worstCalAt = { tooth: tooth.tooth, site: site.site };
      }
    }
  }

  return {
    teethCharted,
    sitesRecorded,
    bleedingSites,
    plaqueSites,
    suppurationSites,
    sites4mmPlus,
    sites6mmPlus,
    bopPercent: percent(bleedingSites, sitesRecorded),
    plaquePercent: percent(plaqueSites, sitesRecorded),
    percent4mmPlus: percent(sites4mmPlus, sitesRecorded),
    deepestPocket,
    deepestPocketAt,
    worstCal,
    worstCalAt,
    teethWithMobility,
    teethWithFurcation,
  };
}

export interface PocketChartSummary {
  coverage: ChartCoverage;
  /** The sentence that must accompany the numbers. */
  scope: string;
  chartedSextants: SextantId[];
  /** Over every charted tooth, INCLUDING any that belong to no sextant. */
  whole: PerioStats;
  /** Null for a sextant that holds no readings — never a row of zeroes, because
   *  a row of zeroes reads as a healthy sextant. */
  bySextant: Record<SextantId, PerioStats | null>;
  caveats: string[];
}

export function summarisePocketChart(chart: PocketChartView): PocketChartSummary {
  const bySextant = {} as Record<SextantId, PerioStats | null>;
  for (const sextant of SEXTANTS) {
    const teeth = chart.teeth.filter((t) => t.sextant === sextant && t.recordedSites > 0);
    bySextant[sextant] = teeth.length > 0 ? computeStats(teeth) : null;
  }
  return {
    coverage: chart.coverage,
    scope: describeCoverage(chart),
    chartedSextants: chart.chartedSextants,
    whole: computeStats(chart.teeth),
    bySextant,
    caveats: chart.caveats,
  };
}

// ---------------------------------------------------------------------------
// Amendment — append, never overwrite
// ---------------------------------------------------------------------------

export interface FieldChange {
  tooth: number;
  site: PerioSiteId | null;
  field: string;
  from: number | boolean | null;
  to: number | boolean | null;
}

export interface AmendmentResult {
  /** A NEW chart. `supersedesId` names the one it replaces; the previous view is
   *  returned untouched and must still be stored. */
  chart: PocketChartView;
  changes: FieldChange[];
}

function siteChanges(tooth: number, before: ChartedSite, after: ChartedSite): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (field: string, from: number | boolean | null, to: number | boolean | null) => {
    if (from !== to) out.push({ tooth, site: before.site, field, from, to });
  };
  push("probingDepth", before.probingDepth, after.probingDepth);
  push("recession", before.recession, after.recession);
  push("bleeding", before.bleeding, after.bleeding);
  push("suppuration", before.suppuration, after.suppuration);
  push("plaque", before.plaque, after.plaque);
  return out;
}

/** What changed between two built charts, field by field. */
export function chartChanges(before: PocketChartView, after: PocketChartView): FieldChange[] {
  const changes: FieldChange[] = [];
  const beforeTeeth = new Map(before.teeth.map((t) => [t.tooth, t]));
  const afterTeeth = new Map(after.teeth.map((t) => [t.tooth, t]));
  for (const [fdi, afterTooth] of afterTeeth) {
    const beforeTooth = beforeTeeth.get(fdi);
    if (!beforeTooth) {
      changes.push({ tooth: fdi, site: null, field: "tooth", from: null, to: true });
      continue;
    }
    for (let i = 0; i < SITE_IDS.length; i += 1) {
      changes.push(...siteChanges(fdi, beforeTooth.sites[i], afterTooth.sites[i]));
    }
    if (beforeTooth.mobility !== afterTooth.mobility) {
      changes.push({
        tooth: fdi,
        site: null,
        field: "mobility",
        from: beforeTooth.mobility,
        to: afterTooth.mobility,
      });
    }
    if (beforeTooth.furcation !== afterTooth.furcation) {
      changes.push({
        tooth: fdi,
        site: null,
        field: "furcation",
        from: beforeTooth.furcation,
        to: afterTooth.furcation,
      });
    }
  }
  for (const fdi of beforeTeeth.keys()) {
    if (!afterTeeth.has(fdi)) {
      changes.push({ tooth: fdi, site: null, field: "tooth", from: true, to: null });
    }
  }
  return changes;
}

/**
 * Amend a chart by writing a NEW one.
 *
 * The previous chart is not touched, not returned modified, and must not be
 * deleted: GDC Standard 4.1.5 requires an amendment to be marked and dated, and
 * an overwritten reading is an amendment nobody can see. The amender's own
 * attribution goes on the new entry — the original clinician stays named on the
 * original.
 */
export function amendPocketChart(
  previous: PocketChartView,
  next: PocketChartInput,
  meta: { by: ClinicianRef; at: string; reason: string },
): AmendmentResult {
  const issues: string[] = [];
  if (!previous.id) {
    issues.push("The chart being amended has no id, so the amendment has nothing to point at.");
  }
  if ((meta.reason ?? "").trim() === "") {
    issues.push("An amendment must say why it was made (GDC Standard 4.1.5).");
  }
  if (issues.length > 0) throw new PerioValidationError(issues);

  const chart = buildPocketChart({
    ...next,
    id: next.id ?? null,
    siteId: next.siteId ?? previous.siteId,
    patientId: next.patientId ?? previous.patientId,
    supersedesId: previous.id,
    amendmentReason: meta.reason,
    recorded: { clinician: meta.by, at: meta.at },
  });
  const changes = chartChanges(previous, chart);
  if (changes.length === 0) {
    throw new PerioValidationError([
      "Nothing in this chart differs from the one it claims to amend, so there is nothing to record.",
    ]);
  }
  return { chart, changes };
}

// ---------------------------------------------------------------------------
// Comparison over time — the clinical point of the feature
// ---------------------------------------------------------------------------

export type SiteMovement = "improved" | "worse" | "unchanged" | "not-comparable";

export interface SiteDiff {
  tooth: number;
  site: PerioSiteId;
  movement: SiteMovement;
  beforeDepth: number | null;
  afterDepth: number | null;
  depthChange: number | null;
  beforeCal: number | null;
  afterCal: number | null;
  calChange: number | null;
  bleedingBefore: boolean;
  bleedingAfter: boolean;
  /** Why it could not be compared. Null when it could. */
  reason: string | null;
}

export type ToothComparison =
  | "compared"
  /** Charted before; the caller told us the tooth is no longer in the mouth. */
  | "lost-since"
  /** Charted before, its sextant charted again, and the tooth simply is not in
   *  the later chart. We cannot tell an extraction from an omission. */
  | "not-recharted"
  /** In the later chart, not the earlier one, though the earlier chart covered
   *  its sextant. */
  | "new-since"
  | "outside-scope-before"
  | "outside-scope-after";

export interface ToothDiff {
  tooth: number;
  sextant: SextantId | null;
  status: ToothComparison;
  sites: SiteDiff[];
  deepestBefore: number | null;
  deepestAfter: number | null;
}

export interface DiffHeadline {
  comparedTeeth: number[];
  comparedSites: number;
  sitesImproved: number;
  sitesWorse: number;
  sitesUnchanged: number;
  /** Both computed over the SAME sites — the ones recorded in both charts.
   *  Comparing a whole-chart percentage against a differently-shaped whole-chart
   *  percentage is how a mouth appears to improve by losing teeth. */
  before: PerioStats;
  after: PerioStats;
  bopPercentChange: number | null;
  plaquePercentChange: number | null;
  sites4mmPlusChange: number;
  sites6mmPlusChange: number;
  deepestPocketChange: number | null;
  teethLostSince: number[];
  teethNotRecharted: number[];
  teethNewSince: number[];
}

export interface PocketChartDiff {
  comparableSextants: SextantId[];
  teeth: ToothDiff[];
  headline: DiffHeadline;
  /** Whole sentences. The extracted-tooth sentence is in here, always. */
  caveats: string[];
}

export interface DiffOptions {
  /**
   * How many millimetres of change count as movement. Default 1mm: anything
   * smaller is not a change at all. Pass 2 for the clinically conventional
   * threshold, which allows for probing error — the caller chooses, because
   * this module must not quietly redefine what "improved" means.
   */
  thresholdMm?: number;
  /**
   * FDI numbers of the teeth actually in the mouth at the later visit, if the
   * caller knows. Supplying it is the ONLY way to tell an extraction from a
   * tooth that was merely not re-charted — neither is an improvement, but the
   * clinician needs to know which happened.
   */
  presentTeethAfter?: readonly number[];
}

function restrictTooth(tooth: ChartedTooth, sites: ReadonlySet<PerioSiteId>): ChartedTooth {
  const kept = tooth.sites.map((s) => (sites.has(s.site) && s.recorded ? s : emptySite(s.site)));
  const recorded = kept.filter((s) => s.recorded);
  const depths = recorded.map((s) => s.probingDepth as number);
  const cals = recorded.map((s) => s.cal).filter((c): c is number => c !== null);
  const interCals = recorded
    .filter((s) => s.interproximal)
    .map((s) => s.cal)
    .filter((c): c is number => c !== null);
  return {
    ...tooth,
    sites: kept,
    recordedSites: recorded.length,
    deepestPocket: depths.length > 0 ? Math.max(...depths) : null,
    worstCal: cals.length > 0 ? Math.max(...cals) : null,
    worstInterproximalCal: interCals.length > 0 ? Math.max(...interCals) : null,
  };
}

function movementOf(depthChange: number, threshold: number): SiteMovement {
  if (depthChange <= -threshold) return "improved";
  if (depthChange >= threshold) return "worse";
  return "unchanged";
}

/**
 * This visit against the last.
 *
 * THE RULE THAT MATTERS: only teeth charted in BOTH visits, at sites recorded in
 * BOTH visits, contribute to any headline figure. A tooth that has gone is
 * reported as a loss and excluded from the arithmetic; nothing about losing a
 * tooth is allowed to look like progress.
 */
export function diffPocketCharts(
  before: PocketChartView,
  after: PocketChartView,
  options: DiffOptions = {},
): PocketChartDiff {
  const threshold = options.thresholdMm ?? 1;
  if (threshold <= 0) {
    throw new PerioValidationError(["A comparison threshold must be at least 1mm."]);
  }
  if (before.patientId && after.patientId && before.patientId !== after.patientId) {
    throw new PerioValidationError([
      "These two charts belong to different patients and must never be compared.",
    ]);
  }
  const beforeAt = Date.parse(before.recorded.at);
  const afterAt = Date.parse(after.recorded.at);
  if (!Number.isNaN(beforeAt) && !Number.isNaN(afterAt) && afterAt < beforeAt) {
    throw new PerioValidationError([
      "The later chart is dated before the earlier one. Compared in that order every improvement reads as deterioration, so the comparison is refused rather than reversed silently.",
    ]);
  }

  const comparableSextants = SEXTANTS.filter(
    (s) => before.chartedSextants.includes(s) && after.chartedSextants.includes(s),
  );
  const beforeTeeth = new Map(before.teeth.filter((t) => t.recordedSites > 0).map((t) => [t.tooth, t]));
  const afterTeeth = new Map(after.teeth.filter((t) => t.recordedSites > 0).map((t) => [t.tooth, t]));
  const presentAfter = options.presentTeethAfter ? new Set(options.presentTeethAfter) : null;

  const allTeeth = [...new Set([...beforeTeeth.keys(), ...afterTeeth.keys()])].sort(toothOrder);

  const teeth: ToothDiff[] = [];
  const comparedBefore: ChartedTooth[] = [];
  const comparedAfter: ChartedTooth[] = [];
  const teethLostSince: number[] = [];
  const teethNotRecharted: number[] = [];
  const teethNewSince: number[] = [];
  let sitesImproved = 0;
  let sitesWorse = 0;
  let sitesUnchanged = 0;
  let comparedSites = 0;

  for (const fdi of allTeeth) {
    const b = beforeTeeth.get(fdi);
    const a = afterTeeth.get(fdi);
    const sextant = sextantOfTooth(fdi);
    // A tooth in no sextant (a third molar) is compared on its own terms: it is
    // never "out of scope", because it was never inside the sextant scheme.
    const regionComparable = sextant === null ? true : comparableSextants.includes(sextant);

    if (b && a && regionComparable) {
      const comparable = new Set<PerioSiteId>();
      const sites: SiteDiff[] = SITE_IDS.map((id) => {
        const bs = b.sites.find((s) => s.site === id) as ChartedSite;
        const as = a.sites.find((s) => s.site === id) as ChartedSite;
        if (!bs.recorded || !as.recorded) {
          return {
            tooth: fdi,
            site: id,
            movement: "not-comparable" as SiteMovement,
            beforeDepth: bs.probingDepth,
            afterDepth: as.probingDepth,
            depthChange: null,
            beforeCal: bs.cal,
            afterCal: as.cal,
            calChange: null,
            bleedingBefore: bs.bleeding,
            bleedingAfter: as.bleeding,
            reason: bs.recorded
              ? "This site was not probed at the later visit."
              : "This site was not probed at the earlier visit.",
          };
        }
        comparable.add(id);
        const depthChange = (as.probingDepth as number) - (bs.probingDepth as number);
        const movement = movementOf(depthChange, threshold);
        if (movement === "improved") sitesImproved += 1;
        else if (movement === "worse") sitesWorse += 1;
        else sitesUnchanged += 1;
        comparedSites += 1;
        return {
          tooth: fdi,
          site: id,
          movement,
          beforeDepth: bs.probingDepth,
          afterDepth: as.probingDepth,
          depthChange,
          beforeCal: bs.cal,
          afterCal: as.cal,
          calChange: bs.cal !== null && as.cal !== null ? as.cal - bs.cal : null,
          bleedingBefore: bs.bleeding,
          bleedingAfter: as.bleeding,
          reason: null,
        };
      });
      comparedBefore.push(restrictTooth(b, comparable));
      comparedAfter.push(restrictTooth(a, comparable));
      teeth.push({
        tooth: fdi,
        sextant,
        status: "compared",
        sites,
        deepestBefore: b.deepestPocket,
        deepestAfter: a.deepestPocket,
      });
      continue;
    }

    let status: ToothComparison;
    if (b && !a) {
      if (presentAfter && !presentAfter.has(fdi)) {
        status = "lost-since";
        teethLostSince.push(fdi);
      } else if (regionComparable) {
        status = "not-recharted";
        teethNotRecharted.push(fdi);
      } else {
        status = "outside-scope-after";
      }
    } else if (a && !b) {
      status = regionComparable ? "new-since" : "outside-scope-before";
      if (status === "new-since") teethNewSince.push(fdi);
    } else {
      // In both charts, but the sextant is not comparable.
      status = before.chartedSextants.includes(sextant as SextantId)
        ? "outside-scope-after"
        : "outside-scope-before";
    }

    teeth.push({
      tooth: fdi,
      sextant,
      status,
      sites: [],
      deepestBefore: b?.deepestPocket ?? null,
      deepestAfter: a?.deepestPocket ?? null,
    });
  }

  const beforeStats = computeStats(comparedBefore);
  const afterStats = computeStats(comparedAfter);

  const caveats: string[] = [];
  if (teethLostSince.length > 0) {
    caveats.push(
      `${teethLostSince.length === 1 ? "Tooth" : "Teeth"} ${teethLostSince.join(", ")} ${teethLostSince.length === 1 ? "is" : "are"} no longer present. Losing a tooth is not an improvement, so ${teethLostSince.length === 1 ? "its" : "their"} readings are excluded from every figure above and the deepest pocket recorded there was ${teethLostSince
        .map((t) => `${t}: ${beforeTeeth.get(t)?.deepestPocket ?? "—"}mm`)
        .join(", ")}.`,
    );
  }
  if (teethNotRecharted.length > 0) {
    caveats.push(
      `${teethNotRecharted.length === 1 ? "Tooth" : "Teeth"} ${teethNotRecharted.join(", ")} ${teethNotRecharted.length === 1 ? "was" : "were"} charted last time and ${teethNotRecharted.length === 1 ? "is" : "are"} missing from this chart, though the sextant was charted again. This platform cannot tell an extraction from an omission, and neither one is an improvement, so ${teethNotRecharted.length === 1 ? "it is" : "they are"} excluded from the figures above.`,
    );
  }
  if (teethNewSince.length > 0) {
    caveats.push(
      `${teethNewSince.length === 1 ? "Tooth" : "Teeth"} ${teethNewSince.join(", ")} ${teethNewSince.length === 1 ? "was" : "were"} charted this time and not last time, so ${teethNewSince.length === 1 ? "it has" : "they have"} no baseline to be compared against.`,
    );
  }
  if (comparableSextants.length < SEXTANTS.length) {
    caveats.push(
      comparableSextants.length === 0
        ? "These two charts have no sextant in common, so there is nothing to compare."
        : `Only the ${listSextants(comparableSextants)} appear in both charts; everything else is uncompared, not unchanged.`,
    );
  }
  if (threshold > 1) {
    caveats.push(`A change of less than ${threshold}mm is reported as unchanged.`);
  }

  return {
    comparableSextants,
    teeth,
    headline: {
      comparedTeeth: teeth.filter((t) => t.status === "compared").map((t) => t.tooth),
      comparedSites,
      sitesImproved,
      sitesWorse,
      sitesUnchanged,
      before: beforeStats,
      after: afterStats,
      bopPercentChange:
        beforeStats.bopPercent !== null && afterStats.bopPercent !== null
          ? Math.round((afterStats.bopPercent - beforeStats.bopPercent) * 10) / 10
          : null,
      plaquePercentChange:
        beforeStats.plaquePercent !== null && afterStats.plaquePercent !== null
          ? Math.round((afterStats.plaquePercent - beforeStats.plaquePercent) * 10) / 10
          : null,
      sites4mmPlusChange: afterStats.sites4mmPlus - beforeStats.sites4mmPlus,
      sites6mmPlusChange: afterStats.sites6mmPlus - beforeStats.sites6mmPlus,
      deepestPocketChange:
        beforeStats.deepestPocket !== null && afterStats.deepestPocket !== null
          ? afterStats.deepestPocket - beforeStats.deepestPocket
          : null,
      teethLostSince,
      teethNotRecharted,
      teethNewSince,
    },
    caveats,
  };
}

// ===========================================================================
// PLAQUE AND BLEEDING BY SURFACE — Dentally's separate tab.
//
// NOT the six-point exam, and not derived from it. The pocket chart records
// bleeding and plaque per SITE, as properties of a probing. Dentally
// additionally has a "Plaque & Bleeding" tab where the clinician labels a tooth
// SURFACE — red for bleeding, yellow for plaque, orange for both — and
// "calculates the percentages of available surfaces where bleeding, plaque or
// both is present". A plaque control record is taken with a disclosing agent on
// surfaces that were never probed, so the two examinations genuinely differ and
// neither may be computed from the other.
//
// EVERYTHING HERE TURNS ON THE WORD "AVAILABLE". The denominator is DECLARED —
// `examinedTeeth` — and never inferred, because inference lies in both
// directions: count only the surfaces carrying a mark and every score is 100%;
// count every tooth in the dentition and one plaque surface reads as 0.9%, an
// immaculate mouth. The teeth actually looked at are the only honest total, and
// they are the one thing the screen cannot work out for itself.
// ===========================================================================

/**
 * Entry order round a tooth: mesial, buccal, distal, lingual.
 *
 * Declared as a Record keyed by PerioSurfaceId so the COMPILER enforces that
 * every surface in the union appears exactly once. PerioSurfaceId is derived
 * from the tooth chart's SurfaceId, so if charting ever adds or renames a
 * surface this stops compiling rather than silently leaving one off the screen —
 * and a surface left off the screen is a surface left out of the denominator.
 */
const PERIO_SURFACE_ORDER: Record<PerioSurfaceId, number> = {
  mesial: 0,
  buccal: 1,
  distal: 2,
  lingual: 3,
};

export const PERIO_SURFACES: readonly PerioSurfaceId[] = (
  Object.keys(PERIO_SURFACE_ORDER) as PerioSurfaceId[]
).sort((a, b) => PERIO_SURFACE_ORDER[a] - PERIO_SURFACE_ORDER[b]);

/** How many surfaces one examined tooth contributes to the denominator. */
export const SURFACES_PER_TOOTH = PERIO_SURFACES.length;

export interface SurfaceFindingInput {
  surface: PerioSurfaceId;
  plaque?: boolean;
  bleeding?: boolean;
}

export interface ToothSurfaceInput {
  tooth: number;
  /** Only the surfaces the clinician touched. Every surface of an examined
   *  tooth is counted whether or not it appears here; an omitted surface is
   *  clean, not absent. */
  surfaces: readonly SurfaceFindingInput[];
}

export interface PlaqueBleedingInput {
  /**
   * THE DENOMINATOR. The teeth this examination covered — declared, not
   * inferred. Each contributes its four surfaces to the total whether or not it
   * carries a mark, because a tooth examined and found clean is a result. A
   * tooth that is not in this list contributes nothing at all, and a finding on
   * one is refused rather than counted.
   */
  examinedTeeth: readonly number[];
  teeth: readonly ToothSurfaceInput[];
  /** Not optional. GDC Standard 4.1.4. */
  recorded: PerioAttribution;
  id?: string | null;
  siteId?: string | null;
  patientId?: string | null;
  supersedesId?: string | null;
  amendmentReason?: string | null;
}

/** What Dentally colours: yellow, red, orange, or nothing. */
export type SurfaceState = "clean" | "plaque" | "bleeding" | "both";

export interface ChartedSurface extends SurfaceFinding {
  state: SurfaceState;
}

export interface PlaqueBleedingScores {
  examinedTeeth: number;
  /** The denominator itself, on the page, as a number. */
  availableSurfaces: number;
  plaqueSurfaces: number;
  bleedingSurfaces: number;
  /** Surfaces carrying BOTH — Dentally's orange. Counted in all three figures,
   *  which is why plaque% + bleeding% can exceed 100 and is not a bug. */
  bothSurfaces: number;
  /** Null when nothing was examined. Never 0%, which is a clinical claim. */
  plaquePercent: number | null;
  bleedingPercent: number | null;
  bothPercent: number | null;
  /** One whole sentence naming the denominator. Printed wherever a percentage
   *  from this examination is printed. */
  denominator: string;
}

export interface ChartedToothSurfaces {
  tooth: number;
  sextant: SextantId | null;
  surfaces: ChartedSurface[];
  /** Over this tooth's own four surfaces. */
  scores: PlaqueBleedingScores;
}

export interface PlaqueBleedingView {
  id: string | null;
  siteId: string | null;
  patientId: string | null;
  recorded: PerioAttribution;
  supersedesId: string | null;
  amendmentReason: string | null;
  examinedTeeth: number[];
  teeth: ChartedToothSurfaces[];
  scores: PlaqueBleedingScores;
  caveats: string[];
}

function isPerioSurface(value: unknown): value is PerioSurfaceId {
  return typeof value === "string" && (PERIO_SURFACES as readonly string[]).includes(value);
}

/**
 * Everything wrong with this examination, as whole sentences. Empty means valid.
 */
export function validatePlaqueBleeding(input: PlaqueBleedingInput): string[] {
  const issues: string[] = [];

  const examined = new Set<number>();
  if (input.examinedTeeth.length === 0) {
    issues.push(
      "A plaque and bleeding examination must say which teeth were examined. Without that there is no denominator, and a percentage with no denominator is not a low score — it is no score at all.",
    );
  }
  for (const fdi of input.examinedTeeth) {
    if (!isTooth(fdi)) {
      issues.push(`${String(fdi)} is not an FDI tooth number.`);
      continue;
    }
    if (examined.has(fdi)) {
      issues.push(`Tooth ${fdi} is listed twice among the teeth examined, which would double its surfaces.`);
      continue;
    }
    examined.add(fdi);
  }

  const clinician: ClinicianRef | undefined = input.recorded?.clinician;
  if (!clinician || typeof clinician.id !== "string" || clinician.id.trim() === "") {
    issues.push("A plaque and bleeding examination must record which clinician made it; no clinician id was given.");
  }
  if (!clinician || typeof clinician.name !== "string" || clinician.name.trim() === "") {
    issues.push("A plaque and bleeding examination must record the treating clinician's name (GDC Standard 4.1.4).");
  }
  if (!isIsoInstant(input.recorded?.at)) {
    issues.push(
      "A plaque and bleeding examination must record when it was made, as an ISO-8601 instant supplied by the caller.",
    );
  }

  const seen = new Set<number>();
  for (const tooth of input.teeth) {
    const fdi = tooth.tooth;
    if (!isTooth(fdi)) {
      issues.push(`${String(fdi)} is not an FDI tooth number.`);
      continue;
    }
    if (seen.has(fdi)) {
      issues.push(`Tooth ${fdi} appears twice in the same plaque and bleeding examination.`);
      continue;
    }
    seen.add(fdi);
    if (!examined.has(fdi)) {
      issues.push(
        `Tooth ${fdi} carries a finding but is not among the teeth this examination says were examined. It would count towards the score and not towards the total, which inflates every percentage on the page.`,
      );
    }

    const seenSurfaces = new Set<PerioSurfaceId>();
    for (const surface of tooth.surfaces) {
      if (!isPerioSurface(surface.surface)) {
        issues.push(
          String(surface.surface) === "occlusal"
            ? `Tooth ${fdi}: the occlusal surface has no gingival margin, so it carries neither plaque score nor bleeding on probing. Plaque and bleeding are recorded on the mesial, buccal, distal and lingual surfaces.`
            : `Tooth ${fdi}: "${String(surface.surface)}" is not a surface plaque or bleeding can be recorded on.`,
        );
        continue;
      }
      if (seenSurfaces.has(surface.surface)) {
        issues.push(`Tooth ${fdi}: the ${surface.surface} surface is recorded twice.`);
      }
      seenSurfaces.add(surface.surface);
    }
  }

  if (input.supersedesId && (input.amendmentReason ?? "").trim() === "") {
    issues.push("An amendment must say why it was made (GDC Standard 4.1.5).");
  }

  return issues;
}

function surfaceState(finding: SurfaceFinding): SurfaceState {
  if (finding.plaque && finding.bleeding) return "both";
  if (finding.bleeding) return "bleeding";
  if (finding.plaque) return "plaque";
  return "clean";
}

function scoreSurfaces(teethExamined: number, surfaces: readonly ChartedSurface[]): PlaqueBleedingScores {
  const available = surfaces.length;
  let plaqueSurfaces = 0;
  let bleedingSurfaces = 0;
  let bothSurfaces = 0;
  for (const surface of surfaces) {
    if (surface.plaque) plaqueSurfaces += 1;
    if (surface.bleeding) bleedingSurfaces += 1;
    if (surface.plaque && surface.bleeding) bothSurfaces += 1;
  }
  return {
    examinedTeeth: teethExamined,
    availableSurfaces: available,
    plaqueSurfaces,
    bleedingSurfaces,
    bothSurfaces,
    plaquePercent: percent(plaqueSurfaces, available),
    bleedingPercent: percent(bleedingSurfaces, available),
    bothPercent: percent(bothSurfaces, available),
    denominator:
      available === 0
        ? "No tooth was examined, so every percentage here would be a percentage of nothing."
        : `Every percentage is of the ${available} surfaces of the ${teethExamined} ${teethExamined === 1 ? "tooth" : "teeth"} examined, and of nothing else.`,
  };
}

/**
 * Validate, fill in the unmarked surfaces, and score.
 *
 * Throws PerioValidationError rather than returning a half-built examination:
 * an examination that quietly dropped the findings it could not place would
 * still print a percentage, and the percentage would be too low.
 */
export function buildPlaqueBleedingChart(input: PlaqueBleedingInput): PlaqueBleedingView {
  const issues = validatePlaqueBleeding(input);
  if (issues.length > 0) throw new PerioValidationError(issues);

  const examinedTeeth = [...input.examinedTeeth].sort(toothOrder);
  const findings = new Map(input.teeth.map((t) => [t.tooth, t]));

  // EVERY examined tooth gets a row, whether or not the clinician marked it.
  // A tooth that was examined and found clean is a result and belongs in the
  // total; leaving it out would shrink the denominator and raise the score.
  const teeth: ChartedToothSurfaces[] = examinedTeeth.map((fdi) => {
    const marked = new Map(
      (findings.get(fdi)?.surfaces ?? []).map((s) => [s.surface, s] as const),
    );
    const surfaces: ChartedSurface[] = PERIO_SURFACES.map((surface) => {
      const found = marked.get(surface);
      const finding: SurfaceFinding = {
        surface,
        plaque: Boolean(found?.plaque),
        bleeding: Boolean(found?.bleeding),
      };
      return { ...finding, state: surfaceState(finding) };
    });
    return {
      tooth: fdi,
      sextant: sextantOfTooth(fdi),
      surfaces,
      scores: scoreSurfaces(1, surfaces),
    };
  });

  const scores = scoreSurfaces(
    examinedTeeth.length,
    teeth.flatMap((t) => t.surfaces),
  );

  return {
    id: input.id ?? null,
    siteId: input.siteId ?? null,
    patientId: input.patientId ?? null,
    recorded: input.recorded,
    supersedesId: input.supersedesId ?? null,
    amendmentReason: input.amendmentReason ?? null,
    examinedTeeth,
    teeth,
    scores,
    caveats: [scores.denominator],
  };
}

/** One sentence naming what this examination did and did not cover. The screen
 *  must print it anywhere one of its percentages is shown. */
export function describePlaqueBleedingScope(view: PlaqueBleedingView): string {
  if (view.examinedTeeth.length === 0) {
    return "No tooth was examined for plaque or bleeding, so this record says nothing about this mouth.";
  }
  return `Plaque and bleeding examined on ${view.examinedTeeth.length} ${
    view.examinedTeeth.length === 1 ? "tooth" : "teeth"
  } (${view.scores.availableSurfaces} surfaces). Teeth not examined are absent from these figures — they are not clean.`;
}

// ---------------------------------------------------------------------------
// LIVE BOP — the figure at the top of a six-pocket exam, while it is being typed
//
// Dentally: "A live % Bleeding on Probing (BOP) score will appear at the top of
// the perio chart", so the clinician never counts by hand. computeStats already
// produces a bopPercent, but only from a BUILT chart — after validation, after
// the whole thing exists. Halfway through entry neither holds, so this takes the
// partial entry state as it is and is cheap enough to run on every keystroke.
//
// THE DENOMINATOR IS THE SITES PROBED SO FAR, and nothing else. Divide by the
// sites on screen instead and the score falls every time the hygienist moves to
// a tooth they have not probed yet — bleeding appearing to improve as the exam
// goes on is the exact opposite of what the number is for.
// ---------------------------------------------------------------------------

export interface LiveBopSiteInput {
  probingDepth?: number | null;
  bleeding?: boolean;
}

export interface LiveBopToothInput {
  sites: readonly LiveBopSiteInput[];
}

export interface LiveBopScore {
  sitesProbed: number;
  bleedingSites: number;
  /** Null before anything has been probed. A 0% on an unprobed mouth is a
   *  claim of health nobody made. */
  percent: number | null;
  /** A whole sentence for the top of the chart. */
  label: string;
}

export function liveBopScore(teeth: readonly LiveBopToothInput[]): LiveBopScore {
  let sitesProbed = 0;
  let bleedingSites = 0;
  for (const tooth of teeth) {
    for (const site of tooth.sites) {
      // Bleeding is a property OF a probing. A bleeding flag at a site with no
      // depth raises the numerator without raising the denominator, so it is
      // not counted here — validatePocketChart refuses it outright on save.
      if (site.probingDepth === null || site.probingDepth === undefined) continue;
      sitesProbed += 1;
      if (site.bleeding) bleedingSites += 1;
    }
  }
  const pct = percent(bleedingSites, sitesProbed);
  return {
    sitesProbed,
    bleedingSites,
    percent: pct,
    label:
      pct === null
        ? "Bleeding on probing: no site has been probed yet."
        : `Bleeding on probing ${pct}% — ${bleedingSites} of ${sitesProbed} probed ${sitesProbed === 1 ? "site" : "sites"}.`,
  };
}
