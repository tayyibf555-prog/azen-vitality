import { describe, it, expect } from "vitest";
// The sextant vocabulary lives in bpe.ts and is imported from there — this file
// deliberately does not have its own copy to test against.
import { SEXTANT_TEETH, sextantOfTooth } from "./bpe";
import {
  INTERPROXIMAL_SITES,
  PERIO_SURFACES,
  PerioValidationError,
  SITE_IDS,
  amendPocketChart,
  buildPlaqueBleedingChart,
  buildPocketChart,
  computeStats,
  describeCoverage,
  describePlaqueBleedingScope,
  diffPocketCharts,
  liveBopScore,
  summarisePocketChart,
  validatePlaqueBleeding,
  validatePocketChart,
} from "./pocket-chart";
import type {
  PlaqueBleedingInput,
  PocketChartInput,
  SiteMeasurementInput,
  ToothRecordInput,
  ToothSurfaceInput,
} from "./pocket-chart";
import type {
  FurcationGrade,
  MobilityStage,
  PerioAttribution,
  PerioSiteId,
  PerioSurfaceId,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures. Time is always passed in — nothing here reads a clock.
// ---------------------------------------------------------------------------

const CLINICIAN = { id: "u-1", name: "Blerta Hoxha", gdcNumber: "123456" };
const OTHER_CLINICIAN = { id: "u-2", name: "Jawad Ahmed", gdcNumber: "654321" };

function at(iso: string): PerioAttribution {
  return { clinician: CLINICIAN, at: iso };
}

function site(id: PerioSiteId, depth: number | null, over: Partial<SiteMeasurementInput> = {}): SiteMeasurementInput {
  return {
    site: id,
    probingDepth: depth,
    recession: depth === null ? null : 0,
    bleeding: false,
    suppuration: false,
    plaque: false,
    ...over,
  };
}

/** Six sites, all the same depth, unless overridden per site. */
function tooth(
  fdi: number,
  depth: number | null,
  over: Partial<Record<PerioSiteId, Partial<SiteMeasurementInput>>> = {},
  rest: Partial<ToothRecordInput> = {},
): ToothRecordInput {
  return {
    tooth: fdi,
    sites: SITE_IDS.map((id) => site(id, depth, over[id] ?? {})),
    mobility: null,
    furcation: null,
    ...rest,
  };
}

function chartInput(over: Partial<PocketChartInput> = {}): PocketChartInput {
  return {
    sextants: ["LR"],
    teeth: [tooth(44, 3), tooth(45, 3)],
    recorded: at("2026-08-01T09:00:00.000Z"),
    ...over,
  };
}

const ALL_SEXTANTS = ["UR", "UA", "UL", "LL", "LA", "LR"] as const;

function fullMouthInput(depth = 3): PocketChartInput {
  const teeth = ALL_SEXTANTS.flatMap((s) => SEXTANT_TEETH[s].slice(0, 2).map((fdi) => tooth(fdi, depth)));
  return chartInput({ sextants: [...ALL_SEXTANTS], teeth });
}

// ---------------------------------------------------------------------------
// Sextants
// ---------------------------------------------------------------------------

describe("sextantOfTooth", () => {
  it("places every tooth exactly where PERIO.md §3.1 says it goes", () => {
    expect([17, 16, 15, 14].map(sextantOfTooth)).toEqual(["UR", "UR", "UR", "UR"]);
    expect([13, 12, 11, 21, 22, 23].map(sextantOfTooth)).toEqual(["UA", "UA", "UA", "UA", "UA", "UA"]);
    expect([24, 25, 26, 27].map(sextantOfTooth)).toEqual(["UL", "UL", "UL", "UL"]);
    expect([34, 35, 36, 37].map(sextantOfTooth)).toEqual(["LL", "LL", "LL", "LL"]);
    expect([33, 32, 31, 41, 42, 43].map(sextantOfTooth)).toEqual(["LA", "LA", "LA", "LA", "LA", "LA"]);
    expect([44, 45, 46, 47].map(sextantOfTooth)).toEqual(["LR", "LR", "LR", "LR"]);
  });

  it("puts third molars and the deciduous dentition in no sextant at all", () => {
    expect([18, 28, 38, 48].map(sextantOfTooth)).toEqual([null, null, null, null]);
    expect(sextantOfTooth(55)).toBeNull();
    expect(sextantOfTooth(99)).toBeNull();
  });

  it("holds four teeth per posterior sextant and six per anterior, in mouth order", () => {
    // bpe.ts lists each sextant distal-to-mesial, which is how a BPE grid reads
    // on screen. This file used to keep its own ascending-FDI copy; the copy is
    // gone and this asserts against the one surviving table.
    expect(SEXTANT_TEETH.UR).toEqual([17, 16, 15, 14]);
    expect(SEXTANT_TEETH.UA).toEqual([13, 12, 11, 21, 22, 23]);
    expect(SEXTANT_TEETH.LR).toEqual([47, 46, 45, 44]);
  });
});

// ---------------------------------------------------------------------------
// CAL is computed, never typed
// ---------------------------------------------------------------------------

describe("CAL", () => {
  it("is probing depth plus recession, and appears nowhere in the input", () => {
    const chart = buildPocketChart(
      chartInput({ teeth: [tooth(44, 4, { mb: { probingDepth: 4, recession: 2 } })] }),
    );
    const mb = chart.teeth[0].sites.find((s) => s.site === "mb");
    expect(mb?.cal).toBe(6);
    expect(chart.teeth[0].sites.find((s) => s.site === "b")?.cal).toBe(4);
  });

  it("is null when either component is missing rather than assuming a zero", () => {
    const chart = buildPocketChart(
      chartInput({
        teeth: [tooth(44, 3, { mb: { probingDepth: 3, recession: null } })],
      }),
    );
    expect(chart.teeth[0].sites.find((s) => s.site === "mb")?.cal).toBeNull();
  });

  it("is smaller than the pocket when recession is negative, and is not clamped", () => {
    const chart = buildPocketChart(
      chartInput({ teeth: [tooth(44, 4, { b: { probingDepth: 4, recession: -2 } })] }),
    );
    expect(chart.teeth[0].sites.find((s) => s.site === "b")?.cal).toBe(2);
  });

  it("cannot be typed: the field does not exist on the input type", () => {
    const typed: SiteMeasurementInput = {
      site: "mb",
      probingDepth: 4,
      recession: 1,
      bleeding: false,
      suppuration: false,
      plaque: false,
      // @ts-expect-error CAL is computed from depth and recession and is never a stored field.
      cal: 99,
    };
    expect(typed.probingDepth).toBe(4);
  });

  it("is refused at runtime too, because a chart posted as JSON never met the type", () => {
    const smuggled = {
      site: "mb",
      probingDepth: 4,
      recession: 1,
      bleeding: false,
      suppuration: false,
      plaque: false,
      cal: 99,
    } as unknown as SiteMeasurementInput;
    const issues = validatePocketChart(
      chartInput({ teeth: [{ tooth: 44, sites: [smuggled], mobility: null, furcation: null }] }),
    );
    expect(issues.join(" ")).toContain("never typed");
    expect(() =>
      buildPocketChart(
        chartInput({ teeth: [{ tooth: 44, sites: [smuggled], mobility: null, furcation: null }] }),
      ),
    ).toThrow(PerioValidationError);
  });

  it("names the interproximal sites separately, because staging is defined on them", () => {
    expect([...INTERPROXIMAL_SITES].sort()).toEqual(["db", "dl", "mb", "ml"]);
    const chart = buildPocketChart(
      chartInput({
        teeth: [
          tooth(44, 3, {
            b: { probingDepth: 3, recession: 5 },
            mb: { probingDepth: 3, recession: 1 },
          }),
        ],
      }),
    );
    expect(chart.teeth[0].worstCal).toBe(8);
    expect(chart.teeth[0].worstInterproximalCal).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Partial charts
// ---------------------------------------------------------------------------

describe("coverage", () => {
  it("calls a single-sextant chart partial and names the sextant", () => {
    const chart = buildPocketChart(chartInput());
    expect(chart.coverage).toBe("partial");
    expect(chart.chartedSextants).toEqual(["LR"]);
    expect(describeCoverage(chart)).toContain("Partial");
    expect(describeCoverage(chart)).toContain("lower right");
    expect(chart.caveats.join(" ")).toContain("not of the whole mouth");
  });

  it("calls a chart full-mouth only when all six sextants hold readings", () => {
    const chart = buildPocketChart(fullMouthInput());
    expect(chart.coverage).toBe("full-mouth");
    expect(chart.chartedSextants).toHaveLength(6);
    expect(describeCoverage(chart)).toContain("Full-mouth");
  });

  it("is still partial when six sextants are declared but only two were charted", () => {
    const chart = buildPocketChart(
      chartInput({ sextants: [...ALL_SEXTANTS], teeth: [tooth(44, 3), tooth(36, 3)] }),
    );
    expect(chart.coverage).toBe("partial");
    // Listed in bpe.ts's SEXTANTS order — upper right → upper left, then lower
    // right → lower left — which is how a BPE grid is written and spoken.
    expect(chart.chartedSextants).toEqual(["LR", "LL"]);
    expect(chart.emptyDeclaredSextants).toEqual(["UR", "UA", "UL", "LA"]);
    expect(chart.caveats.join(" ")).toContain("not the same as healthy");
  });

  it("treats a declared sextant with only unprobed sites as unexamined", () => {
    const chart = buildPocketChart(
      chartInput({ sextants: ["LR", "LL"], teeth: [tooth(44, 3), tooth(36, null)] }),
    );
    expect(chart.chartedSextants).toEqual(["LR"]);
    expect(chart.emptyDeclaredSextants).toEqual(["LL"]);
  });

  it("keeps a third molar's readings in the whole-chart figures and in no sextant", () => {
    const chart = buildPocketChart(chartInput({ teeth: [tooth(44, 3), tooth(48, 7)] }));
    expect(chart.teethOutsideSextantScheme).toEqual([48]);
    const summary = summarisePocketChart(chart);
    expect(summary.whole.deepestPocket).toBe(7);
    expect(summary.bySextant.LR?.deepestPocket).toBe(3);
    expect(summary.caveats.join(" ")).toContain("outside the six-sextant scheme");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validatePocketChart", () => {
  it("refuses a chart that declares no scope", () => {
    expect(validatePocketChart(chartInput({ sextants: [] })).join(" ")).toContain("declares none");
  });

  it("refuses a tooth charted outside the scope the chart claims", () => {
    expect(validatePocketChart(chartInput({ sextants: ["LR"], teeth: [tooth(36, 3)] })).join(" ")).toContain(
      "not one this chart says it covers",
    );
  });

  it("refuses the deciduous dentition", () => {
    expect(validatePocketChart(chartInput({ sextants: ["LR"], teeth: [tooth(85, 3)] })).join(" ")).toContain(
      "permanent dentition",
    );
  });

  it("refuses the same tooth twice", () => {
    expect(validatePocketChart(chartInput({ teeth: [tooth(44, 3), tooth(44, 4)] })).join(" ")).toContain(
      "appears twice",
    );
  });

  it("refuses a probing depth that is not a whole number of plausible millimetres", () => {
    expect(validatePocketChart(chartInput({ teeth: [tooth(44, 4.5)] })).join(" ")).toContain("whole number");
    expect(validatePocketChart(chartInput({ teeth: [tooth(44, 40)] })).join(" ")).toContain("whole number");
  });

  it("refuses a furcation grade on a single-rooted tooth", () => {
    const issues = validatePocketChart(
      chartInput({ sextants: ["LA"], teeth: [tooth(41, 3, {}, { furcation: 2 })] }),
    );
    expect(issues.join(" ")).toContain("single-rooted");
  });

  it("allows a furcation grade on a molar", () => {
    expect(validatePocketChart(chartInput({ teeth: [tooth(46, 3, {}, { furcation: 2 })] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scales are DENTALLY'S, not the literature's.
//
// Dentally's own help article (help.dentally.com/en/articles/3565934) says the
// `f` key "will cycle through furcation grades 1, 2, 3 and 4" and the `m` key
// cycles "mobility stages 1–3". We had built Hamp I–III furcation and Miller
// 0–III mobility from the clinical literature. Dentally wins: a hygienist who
// types a grade 4 furcation and cannot is a hygienist who stops trusting the
// screen, and a 0 mobility that is silently accepted is a "no mobility" claim
// wearing a stage number.
//
// The two specific readings the OLD scales allowed and the new ones must
// refuse — a mobility of 4 and a furcation of 0 — are asserted by name below,
// because they are the exact points where a 4 could become a III.
// ---------------------------------------------------------------------------

describe("mobility stages 1–3", () => {
  it("accepts every stage Dentally's m key can produce", () => {
    for (const stage of [1, 2, 3] as const) {
      expect(validatePocketChart(chartInput({ teeth: [tooth(46, 3, {}, { mobility: stage })] }))).toEqual([]);
    }
  });

  it("accepts null, which is the ONLY way to say no mobility was found", () => {
    expect(validatePocketChart(chartInput({ teeth: [tooth(46, 3, {}, { mobility: null })] }))).toEqual([]);
  });

  it("REFUSES a mobility of 0 — the Miller value that used to be legal", () => {
    const issues = validatePocketChart(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chartInput({ teeth: [tooth(46, 3, {}, { mobility: 0 as any })] }),
    );
    expect(issues.join(" ")).toContain("stages 1");
    expect(issues.length).toBeGreaterThan(0);
  });

  it("REFUSES a mobility of 4, and every other value off the scale", () => {
    for (const bad of [4, -1, 1.5, 10]) {
      const issues = validatePocketChart(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chartInput({ teeth: [tooth(46, 3, {}, { mobility: bad as any })] }),
      );
      expect(issues.length, `mobility ${bad} must be refused`).toBeGreaterThan(0);
    }
  });

  it("names no scale the clinician does not use", () => {
    const issues = validatePocketChart(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chartInput({ teeth: [tooth(46, 3, {}, { mobility: 0 as any })] }),
    );
    expect(issues.join(" ")).not.toContain("Miller");
  });
});

describe("furcation grades 1–4", () => {
  it("accepts every grade Dentally's f key can produce, including 4", () => {
    for (const grade of [1, 2, 3, 4] as const) {
      expect(
        validatePocketChart(chartInput({ teeth: [tooth(46, 3, {}, { furcation: grade })] })),
        `grade ${grade} must be accepted`,
      ).toEqual([]);
    }
  });

  it("REFUSES a furcation of 0 — there is no grade 0, only 'nothing recorded'", () => {
    const issues = validatePocketChart(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chartInput({ teeth: [tooth(46, 3, {}, { furcation: 0 as any })] }),
    );
    expect(issues.join(" ")).toContain("grades 1");
    expect(issues.length).toBeGreaterThan(0);
  });

  it("REFUSES a furcation of 5, and every other value off the scale", () => {
    for (const bad of [5, -1, 2.5, 99]) {
      const issues = validatePocketChart(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chartInput({ teeth: [tooth(46, 3, {}, { furcation: bad as any })] }),
      );
      expect(issues.length, `furcation ${bad} must be refused`).toBeGreaterThan(0);
    }
  });

  it("still refuses any grade on a single-rooted tooth, grade 4 included", () => {
    const issues = validatePocketChart(
      chartInput({ sextants: ["LA"], teeth: [tooth(41, 3, {}, { furcation: 4 })] }),
    );
    expect(issues.join(" ")).toContain("single-rooted");
  });

  it("names no scale the clinician does not use", () => {
    const issues = validatePocketChart(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chartInput({ teeth: [tooth(46, 3, {}, { furcation: 9 as any })] }),
    );
    expect(issues.join(" ")).not.toContain("Hamp");
  });

  it("carries the grade through to the built chart unchanged", () => {
    const chart = buildPocketChart(chartInput({ teeth: [tooth(46, 3, {}, { furcation: 4, mobility: 3 })] }));
    expect(chart.teeth[0].furcation).toBe(4);
    expect(chart.teeth[0].mobility).toBe(3);
  });
});

describe("the scales at the type level", () => {
  it("pins the unions themselves, not only the validator", () => {
    // These are compile-time assertions; tsc --noEmit is what actually runs
    // them. They are here so that widening either union back out fails the
    // typecheck rather than passing silently.
    const stages: MobilityStage[] = [1, 2, 3];
    const grades: FurcationGrade[] = [1, 2, 3, 4];
    expect(stages).toEqual([1, 2, 3]);
    expect(grades).toEqual([1, 2, 3, 4]);

    // @ts-expect-error 0 is not a mobility stage — it is the absence of one.
    const zeroMobility: MobilityStage = 0;
    // @ts-expect-error 4 is off the mobility scale.
    const fourMobility: MobilityStage = 4;
    // @ts-expect-error 0 is not a furcation grade — it is the absence of one.
    const zeroFurcation: FurcationGrade = 0;
    // @ts-expect-error 5 is off the furcation scale.
    const fiveFurcation: FurcationGrade = 5;
    expect([zeroMobility, fourMobility, zeroFurcation, fiveFurcation]).toHaveLength(4);
  });

  it("refuses a finding at a site that was never probed", () => {
    const issues = validatePocketChart(
      chartInput({ teeth: [tooth(44, null, { mb: { probingDepth: null, recession: null, bleeding: true } })] }),
    );
    expect(issues.join(" ")).toContain("cannot be placed");
  });

  it("refuses a chart with no clinician and no time — attribution is not optional", () => {
    const issues = validatePocketChart(
      chartInput({ recorded: { clinician: { id: "", name: "", gdcNumber: null }, at: "not a date" } }),
    );
    expect(issues.join(" ")).toContain("which clinician");
    expect(issues.join(" ")).toContain("GDC Standard 4.1.4");
    expect(issues.join(" ")).toContain("ISO-8601");
  });

  it("refuses an amendment with no reason", () => {
    expect(validatePocketChart(chartInput({ supersedesId: "c-1" })).join(" ")).toContain("GDC Standard 4.1.5");
  });
});

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

describe("summarisePocketChart", () => {
  it("counts bleeding, plaque, deep sites and the deepest pocket over recorded sites only", () => {
    const chart = buildPocketChart(
      chartInput({
        sextants: ["LR"],
        teeth: [
          tooth(44, 3, {
            mb: { probingDepth: 5, bleeding: true },
            b: { probingDepth: 3, plaque: true },
            db: { probingDepth: 7, bleeding: true, suppuration: true },
          }),
          tooth(45, 2, { ml: { probingDepth: null, recession: null } }),
        ],
      }),
    );
    const s = summarisePocketChart(chart).whole;
    expect(s.sitesRecorded).toBe(11);
    expect(s.bleedingSites).toBe(2);
    expect(s.plaqueSites).toBe(1);
    expect(s.suppurationSites).toBe(1);
    expect(s.sites4mmPlus).toBe(2);
    expect(s.sites6mmPlus).toBe(1);
    expect(s.deepestPocket).toBe(7);
    expect(s.deepestPocketAt).toEqual({ tooth: 44, site: "db" });
    expect(s.bopPercent).toBe(18.2);
  });

  it("reports a percentage of null, never zero, when nothing was recorded", () => {
    const stats = computeStats([]);
    expect(stats.bopPercent).toBeNull();
    expect(stats.plaquePercent).toBeNull();
    expect(stats.deepestPocket).toBeNull();
  });

  it("gives a sextant that holds no readings a null row, never a row of zeroes", () => {
    const summary = summarisePocketChart(buildPocketChart(chartInput()));
    expect(summary.bySextant.LR).not.toBeNull();
    expect(summary.bySextant.UR).toBeNull();
    expect(summary.bySextant.LL).toBeNull();
  });

  it("carries its own scope sentence, so a partial figure can never be printed bare", () => {
    const summary = summarisePocketChart(buildPocketChart(chartInput()));
    expect(summary.coverage).toBe("partial");
    expect(summary.scope).toContain("Partial");
    expect(summary.scope).toContain("not of the whole mouth");
  });

  it("breaks the same statistics down per sextant", () => {
    const chart = buildPocketChart(
      chartInput({
        sextants: ["LR", "LL"],
        teeth: [tooth(44, 3, { mb: { probingDepth: 8 } }), tooth(36, 2)],
      }),
    );
    const summary = summarisePocketChart(chart);
    expect(summary.bySextant.LR?.deepestPocket).toBe(8);
    expect(summary.bySextant.LL?.deepestPocket).toBe(2);
    expect(summary.whole.deepestPocket).toBe(8);
  });

  it("lists mobile and furcation-involved teeth", () => {
    const chart = buildPocketChart(
      chartInput({
        teeth: [tooth(46, 3, {}, { mobility: 2, furcation: 3 }), tooth(45, 3, {}, { mobility: null })],
      }),
    );
    const s = summarisePocketChart(chart).whole;
    expect(s.teethWithMobility).toEqual([46]);
    expect(s.teethWithFurcation).toEqual([46]);
  });

  it("counts a stage 1 mobility as mobility — under Miller it was a 0-or-more test", () => {
    // The old scale started at 0, so "has mobility" had to mean `> 0`. On
    // Dentally's 1–3 scale the lowest stage IS a finding, and a `> 0` test that
    // survived the scale change would have kept it. It did not survive.
    const chart = buildPocketChart(chartInput({ teeth: [tooth(46, 3, {}, { mobility: 1 })] }));
    expect(summarisePocketChart(chart).whole.teethWithMobility).toEqual([46]);
  });
});

// ---------------------------------------------------------------------------
// Amendment
// ---------------------------------------------------------------------------

describe("amendPocketChart", () => {
  const original = buildPocketChart(chartInput({ id: "chart-1", patientId: "p-1" }));

  it("writes a new chart that points at the old one and keeps the old one intact", () => {
    const { chart, changes } = amendPocketChart(
      original,
      chartInput({ teeth: [tooth(44, 5), tooth(45, 3)] }),
      { by: OTHER_CLINICIAN, at: "2026-08-02T09:00:00.000Z", reason: "Transcription error on 44." },
    );
    expect(chart.supersedesId).toBe("chart-1");
    expect(chart.amendmentReason).toBe("Transcription error on 44.");
    expect(chart.recorded.clinician.id).toBe("u-2");
    expect(chart.patientId).toBe("p-1");
    // The original is untouched: its author and its readings still stand.
    expect(original.recorded.clinician.id).toBe("u-1");
    expect(original.teeth[0].sites[0].probingDepth).toBe(3);
    expect(changes.some((c) => c.field === "probingDepth" && c.from === 3 && c.to === 5)).toBe(true);
  });

  it("refuses an amendment with no reason", () => {
    expect(() =>
      amendPocketChart(original, chartInput(), { by: OTHER_CLINICIAN, at: "2026-08-02T09:00:00.000Z", reason: "  " }),
    ).toThrow(/4\.1\.5/);
  });

  it("refuses to amend a chart that was never stored", () => {
    const unsaved = buildPocketChart(chartInput());
    expect(() =>
      amendPocketChart(unsaved, chartInput({ teeth: [tooth(44, 5), tooth(45, 3)] }), {
        by: OTHER_CLINICIAN,
        at: "2026-08-02T09:00:00.000Z",
        reason: "x",
      }),
    ).toThrow(/no id/);
  });

  it("refuses an amendment that changes nothing", () => {
    expect(() =>
      amendPocketChart(original, chartInput(), {
        by: OTHER_CLINICIAN,
        at: "2026-08-02T09:00:00.000Z",
        reason: "Re-typed.",
      }),
    ).toThrow(/nothing to record/);
  });
});

// ---------------------------------------------------------------------------
// Comparison over time
// ---------------------------------------------------------------------------

describe("diffPocketCharts", () => {
  const before = buildPocketChart(
    chartInput({
      id: "c-1",
      patientId: "p-1",
      sextants: ["LR"],
      teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } }), tooth(46, 9)],
      recorded: at("2026-01-10T09:00:00.000Z"),
    }),
  );

  it("classifies each site as improved, worse or unchanged", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [
          tooth(44, 5, { mb: { probingDepth: 3 }, b: { probingDepth: 7 } }),
          tooth(46, 9),
        ],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after);
    const t44 = diff.teeth.find((t) => t.tooth === 44);
    expect(t44?.status).toBe("compared");
    expect(t44?.sites.find((s) => s.site === "mb")?.movement).toBe("improved");
    expect(t44?.sites.find((s) => s.site === "mb")?.depthChange).toBe(-2);
    expect(t44?.sites.find((s) => s.site === "b")?.movement).toBe("worse");
    expect(t44?.sites.find((s) => s.site === "db")?.movement).toBe("unchanged");
    expect(diff.headline.sitesImproved).toBe(1);
    expect(diff.headline.sitesWorse).toBe(1);
    expect(diff.headline.comparedSites).toBe(12);
  });

  it("honours a larger threshold and says so", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 4 } }), tooth(46, 9)],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    expect(diffPocketCharts(before, after).headline.sitesImproved).toBe(1);
    const strict = diffPocketCharts(before, after, { thresholdMm: 2 });
    expect(strict.headline.sitesImproved).toBe(0);
    expect(strict.caveats.join(" ")).toContain("less than 2mm");
  });

  // THE CASE THIS WHOLE FUNCTION EXISTS FOR.
  it("does NOT read an extracted tooth as an improvement", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } })],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after, { presentTeethAfter: [44, 45, 47] });

    expect(diff.teeth.find((t) => t.tooth === 46)?.status).toBe("lost-since");
    expect(diff.headline.teethLostSince).toEqual([46]);
    // 46 was six sites of 9mm. None of it may show up as progress.
    expect(diff.headline.sitesImproved).toBe(0);
    expect(diff.headline.comparedTeeth).toEqual([44]);
    expect(diff.headline.comparedSites).toBe(6);
    // The naive diff would show the deepest pocket falling 9mm → 5mm.
    expect(diff.headline.before.deepestPocket).toBe(5);
    expect(diff.headline.after.deepestPocket).toBe(5);
    expect(diff.headline.deepestPocketChange).toBe(0);
    expect(diff.headline.sites6mmPlusChange).toBe(0);
    expect(diff.caveats.join(" ")).toContain("Losing a tooth is not an improvement");
  });

  it("says it cannot tell an extraction from an omission when it is not told", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } })],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after);
    expect(diff.teeth.find((t) => t.tooth === 46)?.status).toBe("not-recharted");
    expect(diff.headline.teethNotRecharted).toEqual([46]);
    expect(diff.headline.teethLostSince).toEqual([]);
    expect(diff.headline.sitesImproved).toBe(0);
    expect(diff.caveats.join(" ")).toContain("cannot tell an extraction from an omission");
  });

  it("compares percentages over the same sites in both charts, not over two different mouths", () => {
    // Before: 44 bleeds at one site of six (16.7%), 46 bleeds nowhere.
    // Losing 46 would inflate the later BOP% if the denominators were not matched.
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } })],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after, { presentTeethAfter: [44] });
    expect(diff.headline.before.bopPercent).toBe(16.7);
    expect(diff.headline.after.bopPercent).toBe(16.7);
    expect(diff.headline.bopPercentChange).toBe(0);
  });

  it("marks a newly charted tooth as having no baseline rather than as an improvement", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } }), tooth(46, 9), tooth(45, 2)],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after);
    expect(diff.teeth.find((t) => t.tooth === 45)?.status).toBe("new-since");
    expect(diff.headline.teethNewSince).toEqual([45]);
    expect(diff.headline.comparedTeeth).toEqual([44, 46]);
    expect(diff.caveats.join(" ")).toContain("no baseline");
  });

  it("excludes a sextant that only one of the two charts covers, and calls it uncompared", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR", "LL"],
        teeth: [tooth(44, 5, { mb: { probingDepth: 5, bleeding: true } }), tooth(46, 9), tooth(36, 2)],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after);
    expect(diff.comparableSextants).toEqual(["LR"]);
    expect(diff.teeth.find((t) => t.tooth === 36)?.status).toBe("outside-scope-before");
    expect(diff.caveats.join(" ")).toContain("uncompared, not unchanged");
  });

  it("marks a site probed at only one of the two visits as not comparable", () => {
    const after = buildPocketChart(
      chartInput({
        patientId: "p-1",
        sextants: ["LR"],
        teeth: [
          tooth(44, 5, { mb: { probingDepth: null, recession: null, bleeding: false } }),
          tooth(46, 9),
        ],
        recorded: at("2026-07-10T09:00:00.000Z"),
      }),
    );
    const diff = diffPocketCharts(before, after);
    const mb = diff.teeth.find((t) => t.tooth === 44)?.sites.find((s) => s.site === "mb");
    expect(mb?.movement).toBe("not-comparable");
    expect(mb?.reason).toContain("later visit");
    expect(diff.headline.comparedSites).toBe(11);
  });

  it("refuses to compare charts belonging to different patients", () => {
    const other = buildPocketChart(chartInput({ patientId: "p-2", recorded: at("2026-07-10T09:00:00.000Z") }));
    expect(() => diffPocketCharts(before, other)).toThrow(/different patients/);
  });

  it("refuses a comparison whose two charts are the wrong way round", () => {
    const earlier = buildPocketChart(chartInput({ patientId: "p-1", recorded: at("2025-01-01T09:00:00.000Z") }));
    expect(() => diffPocketCharts(before, earlier)).toThrow(/dated before/);
  });
});

// ---------------------------------------------------------------------------
// PLAQUE AND BLEEDING BY SURFACE
//
// Dentally charts these on their own tab, by SURFACE, separately from the
// six-point pocket exam: a surface goes "red for bleeding", "yellow for plaque"
// or "orange if both bleeding and plaque have been added", and the system
// "calculates the percentages of AVAILABLE surfaces where bleeding, plaque or
// both is present".
//
// "Available" is the whole test. A plaque score computed over surfaces of teeth
// nobody examined is a fabricated number that reads as a clean mouth, so the
// denominator is DECLARED (`examinedTeeth`) rather than inferred from whatever
// happens to carry a mark.
// ---------------------------------------------------------------------------

function surfaces(over: Partial<Record<PerioSurfaceId, { plaque?: boolean; bleeding?: boolean }>> = {}) {
  return PERIO_SURFACES.map((s) => ({ surface: s, plaque: false, bleeding: false, ...(over[s] ?? {}) }));
}

function pbTooth(fdi: number, over: Parameters<typeof surfaces>[0] = {}): ToothSurfaceInput {
  return { tooth: fdi, surfaces: surfaces(over) };
}

function pbInput(over: Partial<PlaqueBleedingInput> = {}): PlaqueBleedingInput {
  return {
    examinedTeeth: [44, 45],
    teeth: [pbTooth(44), pbTooth(45)],
    recorded: at("2026-08-01T09:00:00.000Z"),
    ...over,
  };
}

describe("the surface vocabulary", () => {
  it("is the tooth chart's own, minus the one surface that cannot bleed", () => {
    // src/lib/charting/types.ts declares SurfaceId as mesial | occlusal |
    // distal | buccal | lingual, and PerioSurfaceId is derived from it by type
    // rather than re-typed, so the two can never drift. Occlusal is excluded:
    // it has no gingival margin, so it has neither a plaque score nor bleeding
    // on probing, and offering it would put a surface on screen that can never
    // legitimately be marked.
    expect([...PERIO_SURFACES].sort()).toEqual(["buccal", "distal", "lingual", "mesial"]);
  });

  it("refuses an occlusal surface by name rather than ignoring it", () => {
    const issues = validatePlaqueBleeding(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pbInput({ teeth: [{ tooth: 44, surfaces: [{ surface: "occlusal" as any, plaque: true }] }] }),
    );
    expect(issues.join(" ")).toContain("occlusal");
  });
});

describe("plaque and bleeding percentages", () => {
  it("counts every surface of every examined tooth in the denominator, marked or not", () => {
    const view = buildPlaqueBleedingChart(pbInput({ teeth: [pbTooth(44, { mesial: { plaque: true } })] }));
    // Two teeth examined, four surfaces each: eight available surfaces. Only
    // ONE tooth carries findings, and the other is still in the denominator —
    // it was examined and found clean, which is a result.
    expect(view.scores.availableSurfaces).toBe(8);
    expect(view.scores.plaqueSurfaces).toBe(1);
    expect(view.scores.plaquePercent).toBe(12.5);
  });

  it("counts ONLY examined teeth — an unexamined tooth is not a clean tooth", () => {
    // THE MUTATION THIS TEST EXISTS TO KILL: making the denominator the whole
    // permanent dentition (or every tooth present in the mouth) rather than the
    // teeth actually examined. One plaque surface out of 28 teeth is 0.9% and
    // reads as an immaculate mouth; out of the single tooth that was actually
    // looked at, it is 25%.
    const view = buildPlaqueBleedingChart(
      pbInput({ examinedTeeth: [44], teeth: [pbTooth(44, { mesial: { plaque: true } })] }),
    );
    expect(view.scores.availableSurfaces).toBe(4);
    expect(view.scores.plaquePercent).toBe(25);
  });

  it("scores bleeding, plaque and both separately, as Dentally's three colours do", () => {
    const view = buildPlaqueBleedingChart(
      pbInput({
        examinedTeeth: [44],
        teeth: [
          pbTooth(44, {
            mesial: { plaque: true },
            distal: { bleeding: true },
            buccal: { plaque: true, bleeding: true },
          }),
        ],
      }),
    );
    expect(view.scores.plaqueSurfaces).toBe(2);
    expect(view.scores.bleedingSurfaces).toBe(2);
    expect(view.scores.bothSurfaces).toBe(1);
    expect(view.scores.plaquePercent).toBe(50);
    expect(view.scores.bleedingPercent).toBe(50);
    expect(view.scores.bothPercent).toBe(25);
    const drawn = view.teeth[0].surfaces;
    expect(drawn.find((s) => s.surface === "mesial")?.state).toBe("plaque");
    expect(drawn.find((s) => s.surface === "distal")?.state).toBe("bleeding");
    expect(drawn.find((s) => s.surface === "buccal")?.state).toBe("both");
    expect(drawn.find((s) => s.surface === "lingual")?.state).toBe("clean");
  });

  it("fills in the surfaces a tooth did not mention, as clean and counted", () => {
    const view = buildPlaqueBleedingChart(
      pbInput({ examinedTeeth: [44], teeth: [{ tooth: 44, surfaces: [{ surface: "mesial", plaque: true }] }] }),
    );
    expect(view.teeth[0].surfaces).toHaveLength(4);
    expect(view.scores.availableSurfaces).toBe(4);
  });

  it("gives per-tooth scores over that tooth's own four surfaces", () => {
    const view = buildPlaqueBleedingChart(
      pbInput({ teeth: [pbTooth(44, { mesial: { plaque: true }, distal: { plaque: true } }), pbTooth(45)] }),
    );
    const t44 = view.teeth.find((t) => t.tooth === 44);
    const t45 = view.teeth.find((t) => t.tooth === 45);
    expect(t44?.scores.plaquePercent).toBe(50);
    expect(t45?.scores.plaquePercent).toBe(0);
  });

  it("counts an examined tooth with no findings at all", () => {
    const view = buildPlaqueBleedingChart(pbInput());
    expect(view.scores.examinedTeeth).toBe(2);
    expect(view.scores.availableSurfaces).toBe(8);
    expect(view.scores.plaquePercent).toBe(0);
    expect(view.scores.bleedingPercent).toBe(0);
  });

  it("never reports a percentage over an empty denominator", () => {
    // A refusal rather than a 0%: 0% of nothing is the "false completeness"
    // failure with a number attached.
    expect(validatePlaqueBleeding(pbInput({ examinedTeeth: [], teeth: [] })).join(" ")).toContain(
      "which teeth were examined",
    );
  });

  it("states its own denominator in a sentence, every time", () => {
    const view = buildPlaqueBleedingChart(pbInput());
    expect(view.scores.denominator).toContain("8");
    expect(view.scores.denominator).toContain("2");
    expect(describePlaqueBleedingScope(view)).toContain("examined");
    expect(view.caveats.join(" ")).toContain("8");
  });
});

describe("plaque and bleeding validation", () => {
  it("REFUSES a finding on a tooth the chart never said it examined", () => {
    // The numerator-without-a-denominator bug: tooth 46 would contribute a
    // marked surface and no available surfaces, so a single finding could push
    // the score above 100%.
    const issues = validatePlaqueBleeding(
      pbInput({ examinedTeeth: [44], teeth: [pbTooth(44), pbTooth(46, { mesial: { plaque: true } })] }),
    );
    expect(issues.join(" ")).toContain("46");
    expect(issues.join(" ")).toContain("examined");
  });

  it("refuses the same tooth twice, in either list", () => {
    expect(validatePlaqueBleeding(pbInput({ examinedTeeth: [44, 44] })).join(" ")).toContain("twice");
    expect(
      validatePlaqueBleeding(pbInput({ teeth: [pbTooth(44), pbTooth(44)] })).join(" "),
    ).toContain("twice");
  });

  it("refuses the same surface twice on one tooth", () => {
    const issues = validatePlaqueBleeding(
      pbInput({
        teeth: [
          { tooth: 44, surfaces: [{ surface: "mesial", plaque: true }, { surface: "mesial", bleeding: true }] },
          pbTooth(45),
        ],
      }),
    );
    expect(issues.join(" ")).toContain("twice");
  });

  it("refuses a tooth number that is not an FDI position", () => {
    expect(validatePlaqueBleeding(pbInput({ examinedTeeth: [99] })).join(" ")).toContain("FDI");
  });

  it("refuses a chart with no identifiable clinician (GDC Standard 4.1.4)", () => {
    const anonymous = validatePlaqueBleeding(
      pbInput({ recorded: { clinician: { id: "", name: "", gdcNumber: null }, at: "2026-08-01T09:00:00.000Z" } }),
    );
    expect(anonymous.join(" ")).toContain("clinician");
    expect(() =>
      buildPlaqueBleedingChart(
        pbInput({ recorded: { clinician: { id: "", name: "", gdcNumber: null }, at: "2026-08-01T09:00:00.000Z" } }),
      ),
    ).toThrow(PerioValidationError);
  });

  it("refuses a timestamp the caller did not supply as an ISO instant", () => {
    expect(
      validatePlaqueBleeding(pbInput({ recorded: { clinician: CLINICIAN, at: "yesterday" } })).join(" "),
    ).toContain("ISO-8601");
  });

  it("refuses an amendment that does not say why it was made (GDC 4.1.5)", () => {
    expect(validatePlaqueBleeding(pbInput({ supersedesId: "pb-1" })).join(" ")).toContain("why");
  });

  it("keeps the amendment as an append, naming what it supersedes", () => {
    const view = buildPlaqueBleedingChart(
      pbInput({ id: "pb-2", supersedesId: "pb-1", amendmentReason: "Mis-keyed the buccal surface of 44." }),
    );
    expect(view.supersedesId).toBe("pb-1");
    expect(view.amendmentReason).toContain("Mis-keyed");
  });
});

// ---------------------------------------------------------------------------
// LIVE BOP
//
// Dentally: "A live % Bleeding on Probing (BOP) score will appear at the top of
// the perio chart" during a six-pocket exam. computeStats already produces a
// bopPercent, but only from a BUILT chart — that is, only after validation has
// passed and the whole chart exists. Halfway through entry neither is true, so
// the entry screen needs a figure it can compute on every keystroke from the
// partial state it is holding.
// ---------------------------------------------------------------------------

describe("liveBopScore", () => {
  it("is a percentage of the sites PROBED SO FAR, not of the sites in the mouth", () => {
    // THE MUTATION THIS TEST EXISTS TO KILL: dividing by tooth count × 6, or by
    // the number of sites on screen. Four sites probed, one bleeding, is 25%.
    // Divided by the six sites of the tooth it would read 16.7%, and the number
    // would fall every time the hygienist moved to a new tooth without probing
    // it — bleeding appearing to improve as the exam goes on.
    const score = liveBopScore([
      {
        sites: [
          { probingDepth: 3, bleeding: true },
          { probingDepth: 2, bleeding: false },
          { probingDepth: 2, bleeding: false },
          { probingDepth: 3, bleeding: false },
          { probingDepth: null, bleeding: false },
          { probingDepth: null, bleeding: false },
        ],
      },
    ]);
    expect(score.sitesProbed).toBe(4);
    expect(score.bleedingSites).toBe(1);
    expect(score.percent).toBe(25);
  });

  it("is null, not zero, before anything has been probed", () => {
    const score = liveBopScore([{ sites: [{ probingDepth: null, bleeding: false }] }]);
    expect(score.percent).toBeNull();
    expect(score.label).toContain("no");
  });

  it("counts across every tooth handed to it", () => {
    const score = liveBopScore([
      { sites: [{ probingDepth: 3, bleeding: true }, { probingDepth: 3, bleeding: true }] },
      { sites: [{ probingDepth: 3, bleeding: false }, { probingDepth: 3, bleeding: false }] },
    ]);
    expect(score.percent).toBe(50);
    expect(score.label).toContain("50");
    expect(score.label).toContain("4");
  });

  it("ignores bleeding recorded at a site with no probing depth", () => {
    // Bleeding is a property OF a probing. A flag set at a site that was never
    // probed would raise the numerator without raising the denominator.
    const score = liveBopScore([
      { sites: [{ probingDepth: 3, bleeding: false }, { probingDepth: null, bleeding: true }] },
    ]);
    expect(score.sitesProbed).toBe(1);
    expect(score.bleedingSites).toBe(0);
    expect(score.percent).toBe(0);
  });

  it("agrees with the built chart's own bopPercent", () => {
    const input = chartInput({
      teeth: [tooth(44, 3, { mb: { bleeding: true }, b: { bleeding: true } }), tooth(45, 3)],
    });
    const chart = buildPocketChart(input);
    expect(liveBopScore(input.teeth).percent).toBe(computeStats(chart.teeth).bopPercent);
  });

  it("takes the entry state as it is, without demanding a whole valid chart", () => {
    // No tooth number, no mobility, no attribution — a half-typed exam.
    expect(liveBopScore([{ sites: [{ probingDepth: 5, bleeding: true }] }]).percent).toBe(100);
  });
});
