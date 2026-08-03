import { describe, it, expect } from "vitest";
import {
  ADJACENT_SEXTANT,
  BPE_CODE_MEANING,
  BPE_TEETH,
  DEFAULT_PROBE,
  MIN_TEETH_PER_SEXTANT,
  SEXTANTS,
  SEXTANT_TEETH,
  adjacentSextantForTooth,
  chartingRequirement,
  implantRefusal,
  isBpeCode,
  maxBpeScore,
  monitoringRefusal,
  parseBpeScore,
  qualifySextants,
  rollUpScores,
  scoreBpeExam,
  sextantLabel,
  sextantOfTooth,
  serialiseBpeScore,
} from "./bpe";
import type { BpeObservation, PerioAttribution, SextantId } from "./types";

const CLINICIAN: PerioAttribution = {
  clinician: { id: "u-1", name: "B. Hoxha", gdcNumber: "123456" },
  at: "2026-08-02T09:30:00.000Z",
};

/** A full permanent dentition minus the third molars, which BPE does not use. */
const FULL_MOUTH = [
  17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 37, 36, 35, 34, 33, 32, 31, 41, 42,
  43, 44, 45, 46, 47,
];

// ===========================================================================
// Sextants
// ===========================================================================

describe("sextant definition", () => {
  it("assigns exactly the FDI ranges PERIO.md §3.1 tabulates", () => {
    expect([...SEXTANT_TEETH.UR]).toEqual([17, 16, 15, 14]);
    expect([...SEXTANT_TEETH.UA]).toEqual([13, 12, 11, 21, 22, 23]);
    expect([...SEXTANT_TEETH.UL]).toEqual([24, 25, 26, 27]);
    expect([...SEXTANT_TEETH.LR]).toEqual([47, 46, 45, 44]);
    expect([...SEXTANT_TEETH.LA]).toEqual([43, 42, 41, 31, 32, 33]);
    expect([...SEXTANT_TEETH.LL]).toEqual([34, 35, 36, 37]);
  });

  it("covers 28 teeth and no tooth twice", () => {
    expect(BPE_TEETH.length).toBe(28);
    expect(new Set(BPE_TEETH).size).toBe(28);
  });

  // THE WRONG-SEXTANT PROPERTY. 14 and 24 are mirror images across the midline;
  // a mapping that put 24 in the upper RIGHT would record the wrong side of the
  // mouth, exactly as a mirrored arch would on the FDI chart.
  it("never crosses the midline or the arch", () => {
    expect(sextantOfTooth(14)).toBe("UR");
    expect(sextantOfTooth(24)).toBe("UL");
    expect(sextantOfTooth(44)).toBe("LR");
    expect(sextantOfTooth(34)).toBe("LL");
    expect(sextantOfTooth(11)).toBe("UA");
    expect(sextantOfTooth(41)).toBe("LA");
  });

  it("maps every tooth of every sextant back to that sextant", () => {
    for (const sextant of SEXTANTS) {
      for (const tooth of SEXTANT_TEETH[sextant]) {
        expect(sextantOfTooth(tooth)).toBe(sextant);
      }
    }
  });

  // Third molars sit outside the BPE sextants (17-14, not 18-14). A silent
  // fallback that swept 18 into the upper right would score a tooth the
  // examination does not use.
  it("places no third molar and no deciduous tooth", () => {
    for (const tooth of [18, 28, 38, 48]) expect(sextantOfTooth(tooth)).toBeNull();
    for (const tooth of [55, 65, 75, 85, 51, 61]) expect(sextantOfTooth(tooth)).toBeNull();
    expect(sextantOfTooth(0)).toBeNull();
    expect(sextantOfTooth(99)).toBeNull();
    expect(sextantOfTooth(Number.NaN)).toBeNull();
  });

  it("labels each sextant in the words a clinician uses", () => {
    expect(sextantLabel("UR")).toBe("upper right");
    expect(sextantLabel("UA")).toBe("upper anterior");
    expect(sextantLabel("UL")).toBe("upper left");
    expect(sextantLabel("LR")).toBe("lower right");
    expect(sextantLabel("LA")).toBe("lower anterior");
    expect(sextantLabel("LL")).toBe("lower left");
  });
});

describe("adjacency", () => {
  it("sends a posterior tooth to the anterior sextant of its own arch", () => {
    expect(adjacentSextantForTooth(17)).toBe("UA");
    expect(adjacentSextantForTooth(24)).toBe("UA");
    expect(adjacentSextantForTooth(47)).toBe("LA");
    expect(adjacentSextantForTooth(34)).toBe("LA");
    expect(ADJACENT_SEXTANT.UR).toBe("UA");
    expect(ADJACENT_SEXTANT.LL).toBe("LA");
  });

  // An anterior sextant has TWO neighbours, so the neighbour is chosen per
  // tooth by which side of the midline it sits on — never by picking one end.
  it("sends an anterior tooth to the posterior sextant on its own side", () => {
    expect(adjacentSextantForTooth(12)).toBe("UR");
    expect(adjacentSextantForTooth(22)).toBe("UL");
    expect(adjacentSextantForTooth(42)).toBe("LR");
    expect(adjacentSextantForTooth(32)).toBe("LL");
    expect(ADJACENT_SEXTANT.UA).toBeNull();
    expect(ADJACENT_SEXTANT.LA).toBeNull();
  });

  it("has no neighbour for a tooth outside the examination", () => {
    expect(adjacentSextantForTooth(18)).toBeNull();
  });
});

// ===========================================================================
// Codes and the furcation flag
// ===========================================================================

describe("BPE codes", () => {
  it("accepts 0 through 4 and nothing else", () => {
    for (const n of [0, 1, 2, 3, 4]) expect(isBpeCode(n)).toBe(true);
    for (const n of [-1, 5, 6, 1.5, Number.NaN]) expect(isBpeCode(n)).toBe(false);
  });

  it("gives each code its clinical meaning, and 3 and 4 are not the same reading", () => {
    expect(BPE_CODE_MEANING[3]).toMatch(/3\.5/);
    expect(BPE_CODE_MEANING[3]).toMatch(/5\.5/);
    expect(BPE_CODE_MEANING[4]).toMatch(/5\.5/);
    expect(BPE_CODE_MEANING[4]).not.toBe(BPE_CODE_MEANING[3]);
    expect(BPE_CODE_MEANING[0]).toMatch(/health/i);
    expect(BPE_CODE_MEANING[1]).toMatch(/bleed/i);
    expect(BPE_CODE_MEANING[2]).toMatch(/calculus/i);
  });

  it("parses every plain code", () => {
    for (const code of [0, 1, 2, 3, 4] as const) {
      expect(parseBpeScore(String(code))).toEqual({ code, furcation: false });
      expect(parseBpeScore(code)).toEqual({ code, furcation: false });
    }
  });

  // The '*' is additive and can sit on ANY code, not only 3 and 4.
  it("parses the furcation star on every code", () => {
    for (const code of [0, 1, 2, 3, 4] as const) {
      expect(parseBpeScore(`${code}*`)).toEqual({ code, furcation: true });
    }
  });

  it("tolerates surrounding whitespace and nothing else", () => {
    expect(parseBpeScore("  3* ")).toEqual({ code: 3, furcation: true });
    expect(parseBpeScore("3 *")).toBeNull();
  });

  it("refuses everything that is not a BPE score", () => {
    for (const raw of ["", "5", "5*", "*", "*3", "3**", "-1", "X", "34", "3.5", "3x"]) {
      expect(parseBpeScore(raw)).toBeNull();
    }
    expect(parseBpeScore(5)).toBeNull();
    expect(parseBpeScore(3.5)).toBeNull();
  });

  it("serialises both forms, and round-trips", () => {
    expect(serialiseBpeScore({ code: 0, furcation: false })).toBe("0");
    expect(serialiseBpeScore({ code: 4, furcation: true })).toBe("4*");
    for (const raw of ["0", "1*", "2", "3*", "4"]) {
      const parsed = parseBpeScore(raw);
      expect(parsed).not.toBeNull();
      expect(serialiseBpeScore(parsed!)).toBe(raw);
    }
  });
});

describe("the highest code wins", () => {
  it("takes the higher of two codes", () => {
    expect(maxBpeScore({ code: 1, furcation: false }, { code: 3, furcation: false })).toEqual({
      code: 3,
      furcation: false,
    });
    expect(maxBpeScore({ code: 4, furcation: false }, { code: 2, furcation: false })).toEqual({
      code: 4,
      furcation: false,
    });
  });

  // The star is additive, so it survives even when it rode in on the LOWER code.
  it("keeps the furcation flag from any reading, not only the highest", () => {
    expect(maxBpeScore({ code: 2, furcation: true }, { code: 4, furcation: false })).toEqual({
      code: 4,
      furcation: true,
    });
  });

  it("rolls a mixed set up to its highest code", () => {
    const mixed = ["1", "0", "3", "2", "1"].map((r) => parseBpeScore(r)!);
    expect(rollUpScores(mixed)).toEqual({ code: 3, furcation: false });
  });

  it("rolls a set holding both a 3 and a 4 up to the 4, never the 3", () => {
    const mixed = ["3", "4", "2"].map((r) => parseBpeScore(r)!);
    expect(rollUpScores(mixed)).toEqual({ code: 4, furcation: false });
  });

  it("is null for nothing at all", () => {
    expect(rollUpScores([])).toBeNull();
  });
});

// ===========================================================================
// Qualification: ≥2 teeth, and what happens when there are not
// ===========================================================================

describe("sextant qualification", () => {
  it("requires two teeth", () => {
    expect(MIN_TEETH_PER_SEXTANT).toBe(2);
  });

  it("scores every sextant of a full mouth", () => {
    const q = qualifySextants(FULL_MOUTH);
    for (const sextant of SEXTANTS) {
      expect(q[sextant].status).toBe("scorable");
      expect(q[sextant].reassignments).toEqual([]);
    }
    expect(q.UA.presentTeeth).toEqual([13, 12, 11, 21, 22, 23]);
  });

  // THE BOUNDARY. Two teeth qualify; one does not. Off by one here silently
  // turns a not-scorable sextant into a scored one.
  it("qualifies on exactly two teeth", () => {
    const q = qualifySextants([17, 16, ...SEXTANT_TEETH.UA]);
    expect(q.UR.status).toBe("scorable");
    expect(q.UR.presentTeeth).toEqual([17, 16]);
  });

  it("does not score a sextant holding one tooth, and records it with the neighbour", () => {
    const q = qualifySextants([17, ...SEXTANT_TEETH.UA]);
    expect(q.UR.status).toBe("insufficient-teeth");
    expect(q.UR.status).not.toBe("scorable");
    expect(q.UR.reassignments).toEqual([{ tooth: 17, to: "UA" }]);
    expect(q.UA.receivedTeeth).toEqual([17]);
    // A donated tooth does NOT promote the receiver — UA already qualified.
    expect(q.UA.status).toBe("scorable");
  });

  it("distinguishes an empty sextant from a one-tooth one, and neither is a zero", () => {
    const q = qualifySextants([...SEXTANT_TEETH.UA]);
    expect(q.UR.status).toBe("no-teeth");
    expect(q.UR.presentTeeth).toEqual([]);
    expect(q.UR.reassignments).toEqual([]);
    expect(q.UL.status).toBe("no-teeth");
  });

  it("sends a lone anterior tooth to the neighbour on its own side", () => {
    const q = qualifySextants([22, ...SEXTANT_TEETH.UR, ...SEXTANT_TEETH.UL]);
    expect(q.UA.status).toBe("insufficient-teeth");
    expect(q.UA.reassignments).toEqual([{ tooth: 22, to: "UL" }]);
    expect(q.UL.receivedTeeth).toEqual([22]);
    expect(q.UR.receivedTeeth).toEqual([]);
  });

  // Two crippled neighbours cannot rescue each other. The tooth goes nowhere,
  // and that is stated rather than quietly scored somewhere plausible.
  it("leaves a tooth unrecordable when the neighbour cannot be scored either", () => {
    const q = qualifySextants([17, 12]);
    expect(q.UR.reassignments).toEqual([{ tooth: 17, to: null }]);
    expect(q.UA.reassignments).toEqual([{ tooth: 12, to: null }]);
    expect(q.UA.receivedTeeth).toEqual([]);
  });

  it("ignores teeth outside the examination and de-duplicates", () => {
    const q = qualifySextants([18, 18, 17, 17, 16, 55]);
    expect(q.UR.presentTeeth).toEqual([17, 16]);
  });

  // BPE is NEVER used around implants, so an implant is not a qualifying tooth.
  it("does not let an implant make up the numbers", () => {
    const q = qualifySextants([17, 16], { implantTeeth: [16] });
    expect(q.UR.presentTeeth).toEqual([17]);
    expect(q.UR.status).toBe("insufficient-teeth");
  });
});

// ===========================================================================
// The protocol. This is the part that is clinically load-bearing.
// ===========================================================================

describe("what charting the screening now requires", () => {
  it("requires nothing when no sextant scored above 2", () => {
    const r = chartingRequirement({
      UR: { code: 0, furcation: false },
      UA: { code: 1, furcation: false },
      UL: { code: 2, furcation: false },
    });
    expect(r.kind).toBe("none");
    expect(r.timing).toBeNull();
    expect(r.sextants).toEqual([]);
    expect(r.highest).toEqual({ code: 2, furcation: false });
    expect(r.reason).toMatch(/no 6-point chart/i);
  });

  it("requires a 6-point chart of THAT sextant only, after initial therapy, for a 3", () => {
    const r = chartingRequirement({
      UR: { code: 3, furcation: false },
      UA: { code: 1, furcation: false },
      UL: { code: 0, furcation: false },
    });
    expect(r.kind).toBe("sextant-6-point");
    expect(r.timing).toBe("after-initial-therapy");
    expect(r.sextants).toEqual(["UR"]);
    expect(r.drivenBy).toEqual(["UR"]);
    expect(r.reason).toContain("upper right");
    expect(r.reason).toMatch(/initial therapy/i);
  });

  it("requires a FULL-MOUTH 6-point chart from the outset for a 4", () => {
    const r = chartingRequirement({
      UR: { code: 4, furcation: false },
      UA: { code: 1, furcation: false },
      UL: { code: 0, furcation: false },
    });
    expect(r.kind).toBe("full-mouth-6-point");
    expect(r.timing).toBe("immediate");
    expect(r.sextants).toEqual([...SEXTANTS]);
    expect(r.drivenBy).toEqual(["UR"]);
    expect(r.reason).toMatch(/full-mouth/i);
    expect(r.reason).toMatch(/outset|immediately/i);
  });

  // THE ASYMMETRY, asserted directly: swapping codes 3 and 4 must change the
  // answer in kind, in scope and in timing. A test that passes under that swap
  // is not testing the protocol.
  it("does not treat a 3 and a 4 as interchangeable", () => {
    const three = chartingRequirement({ LL: { code: 3, furcation: false } });
    const four = chartingRequirement({ LL: { code: 4, furcation: false } });
    expect(three.kind).not.toBe(four.kind);
    expect(three.timing).not.toBe(four.timing);
    expect(three.sextants).toHaveLength(1);
    expect(four.sextants).toHaveLength(6);
    expect(three.reason).not.toBe(four.reason);
  });

  it("charts every sextant that scored 3, and only those", () => {
    const r = chartingRequirement({
      UR: { code: 3, furcation: false },
      UA: { code: 2, furcation: false },
      UL: { code: 3, furcation: false },
      LR: { code: 1, furcation: false },
      LA: { code: 0, furcation: false },
      LL: { code: 3, furcation: false },
    });
    expect(r.kind).toBe("sextant-6-point");
    expect(r.sextants).toEqual(["UR", "UL", "LL"]);
  });

  // The highest code ACROSS THE MOUTH drives it: one 4 anywhere outranks any
  // number of 3s.
  it("lets a single 4 outrank five 3s", () => {
    const r = chartingRequirement({
      UR: { code: 3, furcation: false },
      UA: { code: 3, furcation: false },
      UL: { code: 3, furcation: false },
      LR: { code: 3, furcation: false },
      LA: { code: 3, furcation: false },
      LL: { code: 4, furcation: false },
    });
    expect(r.kind).toBe("full-mouth-6-point");
    expect(r.drivenBy).toEqual(["LL"]);
    expect(r.highest).toEqual({ code: 4, furcation: false });
  });

  it("names every sextant holding the highest code", () => {
    const r = chartingRequirement({
      UR: { code: 4, furcation: false },
      LL: { code: 4, furcation: false },
      UA: { code: 1, furcation: false },
    });
    expect(r.drivenBy).toEqual(["UR", "LL"]);
  });

  it("says nothing was scored rather than inventing a healthy mouth", () => {
    const r = chartingRequirement({});
    expect(r.kind).toBe("none");
    expect(r.highest).toBeNull();
    expect(r.reason).toMatch(/no sextant was scored/i);
    expect(r.reason).not.toMatch(/healthy/i);
  });

  it("treats a not-scored sextant as absent, not as a zero", () => {
    const r = chartingRequirement({ UR: { code: 3, furcation: false }, UA: null });
    expect(r.kind).toBe("sextant-6-point");
    expect(r.highest).toEqual({ code: 3, furcation: false });
  });

  // PERIO.md's rule table stops at codes 3 and 4, so '*' is RAISED as an
  // advisory rather than silently escalating the requirement beyond the spec.
  it("raises furcation as an advisory without changing the requirement", () => {
    const r = chartingRequirement({ UR: { code: 3, furcation: true } });
    expect(r.furcationPresent).toBe(true);
    expect(r.kind).toBe("sextant-6-point");
    expect(r.advisories.join(" ")).toMatch(/furcation/i);
  });

  it("carries the furcation flag onto the highest score", () => {
    const r = chartingRequirement({
      UR: { code: 2, furcation: true },
      LL: { code: 4, furcation: false },
    });
    expect(r.highest).toEqual({ code: 4, furcation: true });
    expect(r.furcationPresent).toBe(true);
  });

  it("has no furcation advisory when no star was recorded", () => {
    const r = chartingRequirement({ UR: { code: 4, furcation: false } });
    expect(r.furcationPresent).toBe(false);
    expect(r.advisories.join(" ")).not.toMatch(/furcation/i);
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("BPE is never used around implants", () => {
  it("refuses a reading taken on an implant, naming the tooth", () => {
    const notice = implantRefusal([26, 27], [26]);
    expect(notice).not.toBeNull();
    expect(notice!.code).toBe("bpe-not-around-implants");
    expect(notice!.severity).toBe("refusal");
    expect(notice!.teeth).toEqual([26]);
    expect(notice!.message).toMatch(/implant/i);
  });

  it("is silent when no probed tooth carries an implant", () => {
    expect(implantRefusal([26, 27], [16])).toBeNull();
    expect(implantRefusal([26, 27], [])).toBeNull();
  });
});

describe("BPE cannot measure treatment response", () => {
  it("refuses when a patient already under periodontal care is BPE'd again", () => {
    const notice = monitoringRefusal({
      presentTeeth: FULL_MOUTH,
      underPeriodontalCare: true,
      previousExamCount: 1,
    });
    expect(notice).not.toBeNull();
    expect(notice!.code).toBe("bpe-not-for-monitoring");
    expect(notice!.severity).toBe("refusal");
    expect(notice!.message).toMatch(/6-point/i);
    expect(notice!.message).toMatch(/monitor|response/i);
  });

  it("is silent for a first BPE on a patient not under periodontal care", () => {
    expect(
      monitoringRefusal({ presentTeeth: FULL_MOUTH, underPeriodontalCare: false, previousExamCount: 0 }),
    ).toBeNull();
    expect(monitoringRefusal({ presentTeeth: FULL_MOUTH })).toBeNull();
  });

  // A first BPE on a patient in periodontal care is a legitimate screening on a
  // new arrival; it is the SERIAL one that is being used as a monitor.
  it("does not refuse the first BPE of a patient who arrived already diagnosed", () => {
    expect(
      monitoringRefusal({ presentTeeth: FULL_MOUTH, underPeriodontalCare: true, previousExamCount: 0 }),
    ).toBeNull();
  });

  it("does not refuse serial BPEs on a patient with no periodontal diagnosis", () => {
    expect(
      monitoringRefusal({ presentTeeth: FULL_MOUTH, underPeriodontalCare: false, previousExamCount: 4 }),
    ).toBeNull();
  });
});

// ===========================================================================
// The whole exam
// ===========================================================================

function obs(tooth: number, raw: string): BpeObservation {
  const score = parseBpeScore(raw)!;
  return { tooth, code: score.code, furcation: score.furcation };
}

describe("scoring an exam", () => {
  it("defaults to the WHO 621 probe and records it", () => {
    expect(DEFAULT_PROBE).toBe("who-621");
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [obs(16, "1")],
      recorded: CLINICIAN,
    });
    expect(result.probe).toBe("who-621");
    expect(result.probeNote).toBeNull();
  });

  it("records the probe actually used when it is not the default", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [obs(16, "1")],
      probe: "other",
      probeNote: "UNC-15",
      recorded: CLINICIAN,
    });
    expect(result.probe).toBe("other");
    expect(result.probeNote).toBe("UNC-15");
  });

  it("carries the clinician and the time straight through", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [obs(16, "1")],
      recorded: CLINICIAN,
    });
    expect(result.recorded.clinician.id).toBe("u-1");
    expect(result.recorded.at).toBe("2026-08-02T09:30:00.000Z");
  });

  it("rolls each sextant up to its highest reading and keeps the working", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [obs(17, "1"), obs(16, "3"), obs(15, "0"), obs(36, "4")],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toEqual({ code: 3, furcation: false });
    expect(result.scores.LL).toEqual({ code: 4, furcation: false });
    expect(result.scores.UA).toBeNull();
    const ur = result.sextants.find((s) => s.sextant === "UR")!;
    expect(ur.contributing).toHaveLength(3);
    expect(result.highest).toEqual({ code: 4, furcation: false });
    expect(result.requirement.kind).toBe("full-mouth-6-point");
  });

  it("keeps a star from any tooth in the sextant", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [obs(16, "2*"), obs(15, "3")],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toEqual({ code: 3, furcation: true });
    expect(serialiseBpeScore(result.scores.UR!)).toBe("3*");
  });

  it("scores a lone tooth into the neighbouring sextant, not its own", () => {
    const present = [17, ...SEXTANT_TEETH.UA];
    const result = scoreBpeExam({
      context: { presentTeeth: present },
      observations: [obs(17, "4"), obs(11, "1")],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toBeNull();
    expect(result.scores.UA).toEqual({ code: 4, furcation: false });
    const ur = result.sextants.find((s) => s.sextant === "UR")!;
    expect(ur.status).toBe("insufficient-teeth");
  });

  it("refuses a reading on an implant and does not score it", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH, implantTeeth: [16] },
      observations: [obs(16, "4"), obs(15, "1")],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toEqual({ code: 1, furcation: false });
    expect(result.notices.some((n) => n.code === "bpe-not-around-implants")).toBe(true);
    expect(result.requirement.kind).toBe("none");
  });

  it("says out loud when a reading has nowhere to be recorded", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: [17, 12] },
      observations: [obs(17, "3")],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toBeNull();
    expect(result.scores.UA).toBeNull();
    const notice = result.notices.find((n) => n.code === "tooth-not-recordable");
    expect(notice).toBeDefined();
    expect(notice!.teeth).toEqual([17]);
    expect(result.requirement.kind).toBe("none");
  });

  it("warns when a reading names a tooth the mouth was not said to contain", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH.filter((t) => t !== 16) },
      observations: [obs(16, "3")],
      recorded: CLINICIAN,
    });
    const notice = result.notices.find((n) => n.code === "tooth-not-present");
    expect(notice).toBeDefined();
    expect(notice!.severity).toBe("warning");
    // The reading is kept, not discarded — losing a clinician's number is worse.
    expect(result.scores.UR).toEqual({ code: 3, furcation: false });
  });

  it("takes a sextant-level reading when no tooth was named", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [{ sextant: "LR", code: 3 }],
      recorded: CLINICIAN,
    });
    expect(result.scores.LR).toEqual({ code: 3, furcation: false });
    expect(result.requirement.sextants).toEqual(["LR"]);
  });

  it("follows a one-tooth sextant's reading into the neighbour it is recorded with", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: [17, ...SEXTANT_TEETH.UA] },
      observations: [{ sextant: "UR", code: 4 }],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toBeNull();
    expect(result.scores.UA).toEqual({ code: 4, furcation: false });
    expect(result.notices.some((n) => n.code === "sextant-not-scorable")).toBe(true);
  });

  // A sextant-level reading carries no tooth, so there is nothing to follow when
  // the sextant is edentulous. It is refused rather than parked on a neighbour.
  it("cannot place a sextant-level reading on a sextant with no teeth at all", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: [...SEXTANT_TEETH.UA] },
      observations: [{ sextant: "UR", code: 4 }],
      recorded: CLINICIAN,
    });
    expect(result.scores.UR).toBeNull();
    expect(result.scores.UA).toBeNull();
    expect(result.notices.some((n) => n.code === "observation-unplaced")).toBe(true);
    expect(result.requirement.kind).toBe("none");
  });

  it("cannot place a reading that names neither a tooth nor a sextant", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [{ code: 4 }],
      recorded: CLINICIAN,
    });
    expect(result.notices.some((n) => n.code === "observation-unplaced")).toBe(true);
    expect(result.highest).toBeNull();
  });

  it("attaches the monitoring refusal to the exam itself", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH, underPeriodontalCare: true, previousExamCount: 2 },
      observations: [obs(16, "3")],
      recorded: CLINICIAN,
    });
    expect(result.notices.some((n) => n.code === "bpe-not-for-monitoring")).toBe(true);
    expect(result.notices.find((n) => n.code === "bpe-not-for-monitoring")!.severity).toBe(
      "refusal",
    );
  });

  it("reports a sextant that cannot be scored on every exam, scored or not", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: [17, ...SEXTANT_TEETH.UA] },
      observations: [obs(11, "1")],
      recorded: CLINICIAN,
    });
    const byId = Object.fromEntries(result.sextants.map((s) => [s.sextant, s.status])) as Record<
      SextantId,
      string
    >;
    expect(byId.UR).toBe("insufficient-teeth");
    expect(byId.UL).toBe("no-teeth");
    expect(byId.UA).toBe("scorable");
    expect(result.sextants).toHaveLength(6);
  });

  it("returns all six sextants in a stable order", () => {
    const result = scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations: [],
      recorded: CLINICIAN,
    });
    expect(result.sextants.map((s) => s.sextant)).toEqual([...SEXTANTS]);
    expect(result.highest).toBeNull();
    expect(result.requirement.kind).toBe("none");
  });

  it("does not mutate the observations it was given", () => {
    const observations: BpeObservation[] = [obs(16, "3")];
    const snapshot = JSON.stringify(observations);
    scoreBpeExam({
      context: { presentTeeth: FULL_MOUTH },
      observations,
      recorded: CLINICIAN,
    });
    expect(JSON.stringify(observations)).toBe(snapshot);
  });
});
