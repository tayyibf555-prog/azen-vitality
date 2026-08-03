// ===========================================================================
// THE BPE ENGINE.
//
// PURE. No I/O, no React, no DOM, no clock — every time value is passed in.
//
// WHAT THIS IS. The Basic Periodontal Examination: six sextants, one code each,
// and a protocol that turns those codes into an obligation to chart in detail.
// It is a SCREENING instrument. It says "look harder here"; it never says how
// the disease is doing. Two rules follow from that and are enforced below as
// explicit refusals rather than left to a comment nobody reads:
//
//   * BPE CANNOT MONITOR TREATMENT RESPONSE. Only a repeat 6-point chart can.
//     Serial BPEs on a patient already in periodontal care look like monitoring
//     and are not (PERIO.md §3.1).
//   * BPE IS NEVER USED AROUND IMPLANTS. An implant is not a qualifying tooth
//     and a reading taken on one is refused, not clamped to a neighbour.
//
// THE STATE THAT IS NOT A NUMBER. A sextant needs ≥2 qualifying teeth. One that
// does not have them is NOT SCORED — its remaining tooth is recorded with the
// adjacent sextant — and that is a distinct state, never a zero. Code 0 is a
// clinical claim ("healthy: no bleeding, no calculus, no pocket over 3.5mm").
// "Could not be scored" is the absence of a claim. Collapsing the two writes a
// missed examination down as a clean result, which is the exact failure
// CHARTING.md §6.3 calls "false completeness".
//
// THE `*`. Furcation involvement is an ADDITIVE flag, not a sixth code. It can
// sit on any code, so "0*" and "4*" are both representable and both round-trip.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not escalate the charting
// requirement on the strength of a `*` alone. PERIO.md §3.1's rule table
// escalates on codes 3 and 4 only; BSP guidance is stronger, and reasonable
// people read it as requiring a full assessment whenever a star appears. Rather
// than quietly applying a rule the binding spec does not state, the star is
// surfaced as an advisory on the requirement and as a notice on the exam, so
// the clinician makes that call with the disagreement visible.
// ===========================================================================

import type {
  BpeCode,
  BpeContext,
  BpeExamInput,
  BpeExamResult,
  BpeObservation,
  BpeScore,
  ChartingRequirement,
  PerioNotice,
  PerioProbe,
  ScoredSextant,
  SextantId,
  SextantQualification,
  SextantQualificationMap,
  ToothReassignment,
} from "./types";

// ---------------------------------------------------------------------------
// Sextants
// ---------------------------------------------------------------------------

/** Render and reporting order: upper right → upper left, then lower right →
 *  lower left, which is the order a BPE grid is written and spoken. */
export const SEXTANTS: readonly SextantId[] = ["UR", "UA", "UL", "LR", "LA", "LL"];

/**
 * FDI, exactly as PERIO.md §3.1 tabulates it.
 *
 * THIRD MOLARS ARE NOT HERE. The ranges stop at 7 (17–14, not 18–14), so 18, 28,
 * 38 and 48 belong to no sextant and are not examined. Teeth are listed distal
 * to mesial in each posterior sextant and right to left across each anterior
 * one, so `presentTeeth` reads in mouth order on screen.
 */
export const SEXTANT_TEETH: Record<SextantId, readonly number[]> = {
  UR: [17, 16, 15, 14],
  UA: [13, 12, 11, 21, 22, 23],
  UL: [24, 25, 26, 27],
  LR: [47, 46, 45, 44],
  LA: [43, 42, 41, 31, 32, 33],
  LL: [34, 35, 36, 37],
};

/** Every tooth the examination uses: 28 of them. */
export const BPE_TEETH: readonly number[] = SEXTANTS.flatMap((s) => [...SEXTANT_TEETH[s]]);

const TOOTH_TO_SEXTANT: ReadonlyMap<number, SextantId> = new Map(
  SEXTANTS.flatMap((sextant) =>
    SEXTANT_TEETH[sextant].map((tooth) => [tooth, sextant] as [number, SextantId]),
  ),
);

/**
 * THE sextant labels. Exported because this module owns the sextant vocabulary
 * for the whole perio directory — pocket-chart.ts and the route import these
 * rather than restating them. Two hand-written sextant tables is precisely how
 * two screens come to disagree about which sextant a tooth is in.
 */
export const SEXTANT_LABEL: Record<SextantId, string> = {
  UR: "upper right",
  UA: "upper anterior",
  UL: "upper left",
  LR: "lower right",
  LA: "lower anterior",
  LL: "lower left",
};

/**
 * The single neighbour of a POSTERIOR sextant.
 *
 * The anterior sextants are deliberately null: they have two neighbours, one
 * either side of the midline, so their adjacency is only ever resolved PER
 * TOOTH — see adjacentSextantForTooth. Picking one end for a whole anterior
 * sextant would record a reading on the wrong side of the mouth.
 */
export const ADJACENT_SEXTANT: Record<SextantId, SextantId | null> = {
  UR: "UA",
  UA: null,
  UL: "UA",
  LR: "LA",
  LA: null,
  LL: "LA",
};

/** PERIO.md §3.1: a sextant needs at least this many qualifying teeth. */
export const MIN_TEETH_PER_SEXTANT = 2;

/** The default probe. The 3.5–5.5mm black band that separates code 3 from code 4
 *  is a property of THIS probe, which is why the exam records which was used. */
export const DEFAULT_PROBE: PerioProbe = "who-621";

export const BPE_CODE_MEANING: Record<BpeCode, string> = {
  0: "Healthy: no bleeding, no calculus and no pocket deeper than 3.5mm.",
  1: "Bleeding on probing.",
  2: "Calculus or a plaque-retentive factor present.",
  3: "A pocket of 3.5–5.5mm — the black band on the probe is partly visible.",
  4: "A pocket deeper than 5.5mm — the black band on the probe disappears.",
};

export function sextantLabel(sextant: SextantId): string {
  return SEXTANT_LABEL[sextant];
}

/** The sextant this tooth belongs to, or null: third molars, deciduous teeth and
 *  anything unrecognised are outside the examination and are NEVER swept into a
 *  nearby sextant to make a number look complete. */
export function sextantOfTooth(fdi: number): SextantId | null {
  return TOOTH_TO_SEXTANT.get(fdi) ?? null;
}

/**
 * Where this tooth is recorded when its own sextant cannot be scored.
 *
 * A posterior tooth goes to the anterior sextant of its own arch. An anterior
 * tooth goes to the posterior sextant ON ITS OWN SIDE — quadrant 1 to the upper
 * right, quadrant 2 to the upper left, and so on down. Returns null for a tooth
 * the examination does not use.
 */
export function adjacentSextantForTooth(fdi: number): SextantId | null {
  const sextant = sextantOfTooth(fdi);
  if (!sextant) return null;
  const fixed = ADJACENT_SEXTANT[sextant];
  if (fixed) return fixed;
  const quadrant = Math.floor(fdi / 10);
  if (quadrant === 1) return "UR";
  if (quadrant === 2) return "UL";
  if (quadrant === 3) return "LL";
  if (quadrant === 4) return "LR";
  return null;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export function isBpeCode(value: number): value is BpeCode {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

const SCORE_PATTERN = /^([0-4])(\*?)$/;

/**
 * `"3"` and `"3*"` both parse; so do `0*` through `4*`, because the star is
 * additive and not the property of any particular code.
 *
 * Returns null rather than a default for anything else. A BPE score that will
 * not parse must reach the screen as "this did not parse", never as a 0 — see
 * the header.
 */
export function parseBpeScore(raw: string | number): BpeScore | null {
  if (typeof raw === "number") {
    return isBpeCode(raw) ? { code: raw, furcation: false } : null;
  }
  const match = SCORE_PATTERN.exec(raw.trim());
  if (!match) return null;
  return { code: Number(match[1]) as BpeCode, furcation: match[2] === "*" };
}

export function serialiseBpeScore(score: BpeScore): string {
  return `${score.code}${score.furcation ? "*" : ""}`;
}

/** The higher code, carrying the furcation flag from EITHER reading: the star is
 *  additive, so it survives even when it arrived on the lower code. */
export function maxBpeScore(a: BpeScore, b: BpeScore): BpeScore {
  return {
    code: (a.code >= b.code ? a.code : b.code) as BpeCode,
    furcation: a.furcation || b.furcation,
  };
}

/** The sextant score is the HIGHEST code found within it. Null for nothing. */
export function rollUpScores(scores: readonly BpeScore[]): BpeScore | null {
  return scores.reduce<BpeScore | null>(
    (highest, score) => (highest === null ? { ...score } : maxBpeScore(highest, score)),
    null,
  );
}

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

/**
 * Which sextants can be scored at all, and where the teeth of the ones that
 * cannot are recorded instead.
 *
 * Two passes, and they cannot be merged: a tooth is only re-routed to a
 * neighbour that qualifies ON ITS OWN teeth, so every status has to be settled
 * before any reassignment is made. Two crippled neighbours do not rescue each
 * other — such a tooth reassigns to `null`, which the caller must state out loud
 * rather than score somewhere plausible.
 *
 * IMPLANTS ARE NOT QUALIFYING TEETH. BPE is never used around them, so an
 * implant cannot make a sextant up to two.
 */
export function qualifySextants(
  teeth: readonly number[],
  options: { implantTeeth?: readonly number[] } = {},
): SextantQualificationMap {
  const implants = new Set(options.implantTeeth ?? []);
  const present = new Set(teeth.filter((t) => TOOTH_TO_SEXTANT.has(t) && !implants.has(t)));

  const map = {} as SextantQualificationMap;
  for (const sextant of SEXTANTS) {
    // Iterate the canonical list, not the caller's array: this de-duplicates and
    // fixes the order in one move, so `presentTeeth` always reads in mouth order.
    const presentTeeth = SEXTANT_TEETH[sextant].filter((t) => present.has(t));
    const status =
      presentTeeth.length >= MIN_TEETH_PER_SEXTANT
        ? "scorable"
        : presentTeeth.length === 0
          ? "no-teeth"
          : "insufficient-teeth";
    map[sextant] = {
      sextant,
      presentTeeth,
      status,
      receivedTeeth: [],
      reassignments: [],
    } satisfies SextantQualification;
  }

  for (const sextant of SEXTANTS) {
    if (map[sextant].status === "scorable") continue;
    const reassignments: ToothReassignment[] = [];
    for (const tooth of map[sextant].presentTeeth) {
      const neighbour = adjacentSextantForTooth(tooth);
      const to = neighbour && map[neighbour].status === "scorable" ? neighbour : null;
      reassignments.push({ tooth, to });
      if (to) map[to].receivedTeeth.push(tooth);
    }
    map[sextant].reassignments = reassignments;
  }

  return map;
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

function listSextants(sextants: readonly SextantId[]): string {
  const labels = sextants.map(sextantLabel);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const FURCATION_ADVISORY =
  "Furcation involvement (*) was recorded. The rule table escalates on codes 3 and 4 only, " +
  "so this has not changed the requirement above — but furcation involvement is itself an " +
  "indication for a detailed periodontal assessment, and that judgement is the clinician's.";

/**
 * WHAT CHARTING IS NOW REQUIRED, AND WHY.
 *
 * The highest code anywhere in the mouth drives it:
 *   code 4 in ANY sextant → a FULL-MOUTH 6-point chart, from the outset
 *   otherwise code 3      → a 6-point chart of THOSE SEXTANTS, after initial therapy
 *   otherwise             → nothing from this screening
 *
 * The difference between 3 and 4 is not a matter of degree: they differ in
 * SCOPE (one sextant vs the whole mouth) and in TIMING (after initial therapy vs
 * immediately). Swapping them either charts a whole mouth that needed one
 * sextant, or delays a full assessment a patient needed today.
 *
 * A sextant with no entry, or an explicit null, is ABSENT — not a zero. It
 * cannot lower the requirement and it cannot raise it.
 */
export function chartingRequirement(
  scores: Partial<Record<SextantId, BpeScore | null>>,
): ChartingRequirement {
  const scored = SEXTANTS.map((sextant) => ({ sextant, score: scores[sextant] ?? null })).filter(
    (entry): entry is { sextant: SextantId; score: BpeScore } => entry.score !== null,
  );

  const highest = rollUpScores(scored.map((e) => e.score));
  const furcationPresent = scored.some((e) => e.score.furcation);
  const advisories = furcationPresent ? [FURCATION_ADVISORY] : [];

  if (highest === null) {
    return {
      kind: "none",
      timing: null,
      sextants: [],
      highest: null,
      drivenBy: [],
      furcationPresent,
      reason:
        "No sextant was scored, so this screening says nothing about what charting is needed.",
      advisories,
    };
  }

  const drivenBy = scored.filter((e) => e.score.code === highest.code).map((e) => e.sextant);

  if (highest.code === 4) {
    return {
      kind: "full-mouth-6-point",
      timing: "immediate",
      sextants: [...SEXTANTS],
      highest,
      drivenBy,
      furcationPresent,
      reason:
        `Code 4 in the ${listSextants(drivenBy)}: a pocket deeper than 5.5mm. ` +
        "That requires a full-mouth 6-point chart from the outset — not a chart of that sextant, " +
        "and not after initial therapy.",
      advisories,
    };
  }

  if (highest.code === 3) {
    return {
      kind: "sextant-6-point",
      timing: "after-initial-therapy",
      sextants: drivenBy,
      highest,
      drivenBy,
      furcationPresent,
      reason:
        `Code 3 in the ${listSextants(drivenBy)}: a pocket of 3.5–5.5mm. ` +
        `That requires a 6-point chart of ${drivenBy.length === 1 ? "that sextant" : "those sextants"}, ` +
        "after initial therapy — not of the whole mouth.",
      advisories,
    };
  }

  return {
    kind: "none",
    timing: null,
    sextants: [],
    highest,
    drivenBy,
    furcationPresent,
    reason:
      `The highest score in the mouth is code ${highest.code} (${listSextants(drivenBy)}), ` +
      "so no 6-point chart is required by this screening.",
    advisories,
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * BPE IS NEVER USED AROUND IMPLANTS. Returns a refusal naming the teeth, or null
 * when nothing probed carries one.
 */
export function implantRefusal(
  probedTeeth: readonly number[],
  implantTeeth: readonly number[],
): PerioNotice | null {
  const implants = new Set(implantTeeth);
  const hit = [...new Set(probedTeeth.filter((t) => implants.has(t)))];
  if (hit.length === 0) return null;
  return {
    code: "bpe-not-around-implants",
    severity: "refusal",
    message:
      `BPE is never used around implants, and ${hit.length === 1 ? "tooth" : "teeth"} ` +
      `${hit.join(", ")} ${hit.length === 1 ? "carries one" : "carry one"}. ` +
      `${hit.length === 1 ? "That reading has" : "Those readings have"} not been scored; ` +
      "record peri-implant probing separately.",
    sextants: [...new Set(hit.map(sextantOfTooth).filter((s): s is SextantId => s !== null))],
    teeth: hit,
  };
}

/**
 * BPE CANNOT BE USED TO MONITOR TREATMENT RESPONSE — only a repeat 6-point chart
 * can. The pattern being refused is the SERIAL one: a second or later BPE on a
 * patient already in periodontal care is functioning as a monitor.
 *
 * A FIRST BPE on a patient who arrived already diagnosed is a legitimate
 * screening and is not refused.
 */
export function monitoringRefusal(context: BpeContext): PerioNotice | null {
  if (!context.underPeriodontalCare) return null;
  if ((context.previousExamCount ?? 0) < 1) return null;
  return {
    code: "bpe-not-for-monitoring",
    severity: "refusal",
    message:
      "This patient is already under periodontal care and has a previous BPE on record. " +
      "A BPE cannot measure the response to treatment — only a repeat 6-point chart can. " +
      "Record this as a screening if you need to, but do not read the change in code as progress.",
    sextants: [],
    teeth: [],
  };
}

// ---------------------------------------------------------------------------
// The exam
// ---------------------------------------------------------------------------

function toothOf(observation: BpeObservation): number | null {
  const tooth = observation.tooth;
  return typeof tooth === "number" && Number.isFinite(tooth) ? tooth : null;
}

function normalise(observation: BpeObservation, sextant: SextantId): BpeObservation {
  return {
    tooth: toothOf(observation),
    sextant,
    code: observation.code,
    furcation: observation.furcation === true,
  };
}

/**
 * A whole examination: route every reading to the sextant it is actually
 * recorded in, roll each sextant up to its highest code, and say what charting
 * that now demands.
 *
 * NOTHING IS SILENTLY DISCARDED. A reading that cannot be placed produces a
 * notice naming the tooth, because a clinician's number that vanishes is worse
 * than one that is questioned.
 */
export function scoreBpeExam(input: BpeExamInput): BpeExamResult {
  const { context, observations, recorded } = input;
  const implantTeeth = context.implantTeeth ?? [];
  const implants = new Set(implantTeeth);
  const presentTeeth = new Set(context.presentTeeth);
  const qualification = qualifySextants(context.presentTeeth, { implantTeeth });

  const notices: PerioNotice[] = [];
  const buckets = new Map<SextantId, BpeObservation[]>(SEXTANTS.map((s) => [s, []]));
  const probedImplants: number[] = [];
  const unrecordable: number[] = [];
  const notPresent: number[] = [];
  const unplacedTeeth: number[] = [];
  const unplacedSextants: SextantId[] = [];
  const reroutedFrom: SextantId[] = [];

  for (const observation of observations) {
    const tooth = toothOf(observation);

    if (tooth !== null) {
      if (implants.has(tooth)) {
        probedImplants.push(tooth);
        continue;
      }
      const home = sextantOfTooth(tooth);
      if (!home) {
        unplacedTeeth.push(tooth);
        continue;
      }
      if (!presentTeeth.has(tooth)) notPresent.push(tooth);

      let target: SextantId | null;
      if (qualification[home].status === "scorable") {
        target = home;
      } else {
        const entry = qualification[home].reassignments.find((r) => r.tooth === tooth);
        if (entry) {
          target = entry.to;
        } else {
          // The tooth was not listed as present, so it has no reassignment of
          // its own. Fall back to its neighbour, if that neighbour can be scored.
          const neighbour = adjacentSextantForTooth(tooth);
          target = neighbour && qualification[neighbour].status === "scorable" ? neighbour : null;
        }
      }

      if (target === null) {
        unrecordable.push(tooth);
        continue;
      }
      if (target !== home) reroutedFrom.push(home);
      buckets.get(target)!.push(normalise(observation, target));
      continue;
    }

    const named = observation.sextant ?? null;
    if (!named) {
      notices.push({
        code: "observation-unplaced",
        severity: "warning",
        message:
          `A reading of ${serialiseBpeScore({ code: observation.code, furcation: observation.furcation === true })} ` +
          "named neither a tooth nor a sextant, so it has not been scored.",
        sextants: [],
        teeth: [],
      });
      continue;
    }

    if (qualification[named].status === "scorable") {
      buckets.get(named)!.push(normalise(observation, named));
      continue;
    }

    // A sextant-level reading carries no tooth, so it can only follow the
    // sextant's own teeth — and only when they all agree on one destination.
    const destinations = [...new Set(qualification[named].reassignments.map((r) => r.to))];
    const target = destinations.length === 1 ? destinations[0] : null;
    if (target === null) {
      unplacedSextants.push(named);
      continue;
    }
    reroutedFrom.push(named);
    buckets.get(target)!.push(normalise(observation, target));
  }

  const scores = {} as Record<SextantId, BpeScore | null>;
  const sextants: ScoredSextant[] = SEXTANTS.map((sextant) => {
    const contributing = buckets.get(sextant)!;
    const score = rollUpScores(
      contributing.map((o) => ({ code: o.code, furcation: o.furcation === true })),
    );
    scores[sextant] = score;
    return {
      sextant,
      status: qualification[sextant].status,
      score,
      contributing,
      qualification: qualification[sextant],
    };
  });

  const implantNotice = implantRefusal(probedImplants, implantTeeth);
  if (implantNotice) notices.push(implantNotice);

  const monitoring = monitoringRefusal(context);
  if (monitoring) notices.push(monitoring);

  if (notPresent.length > 0) {
    const teeth = [...new Set(notPresent)];
    notices.push({
      code: "tooth-not-present",
      severity: "warning",
      message:
        `${teeth.length === 1 ? "Tooth" : "Teeth"} ${teeth.join(", ")} ` +
        `${teeth.length === 1 ? "was" : "were"} probed but ${teeth.length === 1 ? "is" : "are"} ` +
        "not listed as present in this mouth. The reading has been kept — check the chart.",
      sextants: [...new Set(teeth.map(sextantOfTooth).filter((s): s is SextantId => s !== null))],
      teeth,
    });
  }

  if (unrecordable.length > 0) {
    const teeth = [...new Set(unrecordable)];
    notices.push({
      code: "tooth-not-recordable",
      severity: "warning",
      message:
        `${teeth.length === 1 ? "Tooth" : "Teeth"} ${teeth.join(", ")} ` +
        `${teeth.length === 1 ? "sits" : "sit"} in a sextant with too few teeth to score, and the ` +
        "adjacent sextant cannot be scored either. This reading is recorded nowhere — it has not " +
        "been counted as a healthy sextant.",
      sextants: [...new Set(teeth.map(sextantOfTooth).filter((s): s is SextantId => s !== null))],
      teeth,
    });
  }

  if (unplacedTeeth.length > 0) {
    const teeth = [...new Set(unplacedTeeth)];
    notices.push({
      code: "observation-unplaced",
      severity: "warning",
      message:
        `${teeth.length === 1 ? "Tooth" : "Teeth"} ${teeth.join(", ")} ` +
        `${teeth.length === 1 ? "is" : "are"} outside the BPE sextants — third molars and ` +
        "deciduous teeth are not examined — so this reading has not been scored.",
      sextants: [],
      teeth,
    });
  }

  if (unplacedSextants.length > 0) {
    const list = [...new Set(unplacedSextants)];
    notices.push({
      code: "observation-unplaced",
      severity: "warning",
      message:
        `A reading was recorded against the ${listSextants(list)}, which cannot be scored, and ` +
        "no single neighbouring sextant can hold it. Record it against a tooth instead.",
      sextants: list,
      teeth: [],
    });
  }

  const rerouted = [...new Set(reroutedFrom)];
  if (rerouted.length > 0) {
    notices.push({
      code: "sextant-not-scorable",
      severity: "info",
      message:
        `The ${listSextants(rerouted)} ${rerouted.length === 1 ? "has" : "have"} fewer than ` +
        `${MIN_TEETH_PER_SEXTANT} teeth, so ${rerouted.length === 1 ? "its" : "their"} readings ` +
        `${rerouted.length === 1 ? "have" : "have"} been recorded with the adjacent sextant rather ` +
        "than scored separately.",
      sextants: rerouted,
      teeth: [],
    });
  }

  const requirement = chartingRequirement(scores);

  if (requirement.furcationPresent) {
    notices.push({
      code: "furcation-recorded",
      severity: "info",
      message: FURCATION_ADVISORY,
      sextants: SEXTANTS.filter((s) => scores[s]?.furcation === true),
      teeth: [],
    });
  }

  return {
    sextants,
    scores,
    highest: requirement.highest,
    requirement,
    notices,
    probe: input.probe ?? DEFAULT_PROBE,
    probeNote: input.probeNote ?? null,
    recorded,
  };
}
