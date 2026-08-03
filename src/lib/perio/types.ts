// ===========================================================================
// THE PERIODONTAL CONTRACT.
//
// Types only. No logic, no I/O, and there is NO index.ts barrel in this
// directory, for the same reason src/lib/charting/types.ts says so: a barrel
// lets a client component reach a server-only repository, which builds green
// and then drags the service-role client into the client graph.
//
// THE ONE IMPORT. This file used to have none. It now takes a single type-only
// import — SurfaceId from src/lib/charting/types.ts — for exactly the reason
// that file gives for importing FundingCode rather than re-listing it: "a second
// hand-written list is exactly how two screens drift". The tooth chart already
// names the surfaces of a tooth, and a periodontal surface is the same surface.
// It is `import type`, so it is erased at compile time and drags nothing into
// any graph; charting/types.ts is itself types-only.
//
// READ THIS BEFORE YOU ADD A FIELD. Unlike the FDI chart, which is a read-only
// mirror of Dentally, NOTHING here mirrors anything. Dentally's API exposes no
// periodontal resource at all (PERIO.md §1), so every value described by this
// file is AUTHORED in this platform and this platform becomes the system of
// record for it the moment the gate is opened. That is why:
//
//   1. Every recorded thing carries a PerioAttribution — WHICH clinician, WHEN.
//      GDC Standard 4.1.4 puts the treating clinician's name on the record.
//   2. Amendments APPEND. `supersedesId` points at the entry this one replaces;
//      the superseded row is never overwritten and never hard-deleted, because
//      GDC 4.1.5 requires amendments to be clearly marked and dated.
//   3. A sextant that CANNOT be scored is a distinct state, never a zero. A
//      zero is a clinical claim ("healthy"); "not scorable" is the absence of
//      one, and collapsing the two is how a missed diagnosis gets written down
//      as a clean result.
//
// TIME IS ALWAYS AN ISO-8601 STRING PASSED IN BY THE CALLER. No module in this
// directory reads the clock — a Date.now() in a render path is a hydration bug
// this repo has already paid for once.
// ===========================================================================

import type { SurfaceId } from "@/lib/charting/types";

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/** The human being. Never a service account, never a shared practice login —
 *  PERIO.md §4: "no robot authorship, no shared identity". */
export interface ClinicianRef {
  id: string;
  /** As it should read on the record, e.g. "Blerta Hoxha". */
  name: string;
  /** GDC registration number where the practice holds it. Null is allowed; a
   *  fabricated one is not. */
  gdcNumber: string | null;
}

export interface PerioAttribution {
  clinician: ClinicianRef;
  /** ISO-8601, supplied by the caller. */
  at: string;
}

/**
 * The append-only envelope every stored periodontal entry carries.
 *
 * An amendment is a NEW row whose `supersedesId` names the old one. There is no
 * update path and no delete path; a reader reconstructs the current view by
 * following the chain, and the whole chain stays readable.
 */
export interface PerioEntryMeta {
  id: string;
  recorded: PerioAttribution;
  /** The entry this one amends, or null for an original observation. */
  supersedesId: string | null;
  /** Why it was amended. Required in substance on an amendment; the type keeps
   *  it nullable so an original entry does not have to carry an empty string. */
  amendmentReason: string | null;
}

// ---------------------------------------------------------------------------
// BPE
// ---------------------------------------------------------------------------

/** The six sextants. Upper/Lower × Right/Anterior/Left. */
export type SextantId = "UR" | "UA" | "UL" | "LR" | "LA" | "LL";

/**
 * 0 healthy · 1 bleeding · 2 calculus or plaque-retentive factor · 3 pocket
 * 3.5–5.5mm · 4 pocket >5.5mm.
 *
 * The furcation `*` is NOT a sixth code — it is an additive flag that can sit on
 * any of these, which is why it lives on BpeScore rather than in this union.
 */
export type BpeCode = 0 | 1 | 2 | 3 | 4;

/** One score, in its parsed form. `"3*"` is `{ code: 3, furcation: true }`. */
export interface BpeScore {
  code: BpeCode;
  furcation: boolean;
}

/** The probe used. Recorded because the reading means nothing without it: the
 *  3.5–5.5mm band that separates code 3 from code 4 is a property of the WHO
 *  621 probe, not of the mouth. */
export type PerioProbe = "who-621" | "who-cpi" | "other";

/**
 * One thing the clinician saw. Either a tooth or a sextant identifies it; a
 * tooth is better, because a tooth can be re-routed when its own sextant has too
 * few teeth to be scored.
 */
export interface BpeObservation {
  /** FDI. Preferred. */
  tooth?: number | null;
  /** Used when the clinician recorded at sextant level and named no tooth. */
  sextant?: SextantId | null;
  code: BpeCode;
  furcation?: boolean;
}

/** Why a sextant does or does not carry a score. NEVER conflate the last two
 *  with a code of 0. */
export type SextantStatus = "scorable" | "insufficient-teeth" | "no-teeth";

/** Where a tooth from a non-scorable sextant is actually recorded. A `to` of
 *  null means nowhere — the neighbour cannot be scored either, and the screen
 *  has to say so rather than quietly losing the reading. */
export interface ToothReassignment {
  tooth: number;
  to: SextantId | null;
}

export interface SextantQualification {
  sextant: SextantId;
  /** This sextant's OWN qualifying teeth that are present. Implants are not
   *  qualifying teeth: BPE is never used around them. */
  presentTeeth: number[];
  status: SextantStatus;
  /** Teeth donated by a neighbour that could not be scored on its own. These do
   *  not change this sextant's status — a sextant qualifies on its own teeth. */
  receivedTeeth: number[];
  /** Populated only when `status` is not "scorable": where each of this
   *  sextant's own teeth is recorded instead. */
  reassignments: ToothReassignment[];
}

export type SextantQualificationMap = Record<SextantId, SextantQualification>;

/** A sextant after scoring. `score` is null whenever no reading landed here —
 *  which includes the not-scorable case and the simply-not-probed case, told
 *  apart by `status`. */
export interface ScoredSextant {
  sextant: SextantId;
  status: SextantStatus;
  score: BpeScore | null;
  /** Every reading that rolled up into `score`, kept so the screen can show its
   *  working rather than a bare number. */
  contributing: BpeObservation[];
  qualification: SextantQualification;
}

// ---------------------------------------------------------------------------
// What the screening now demands
// ---------------------------------------------------------------------------

export type ChartingRequirementKind = "none" | "sextant-6-point" | "full-mouth-6-point";

export type ChartingTiming = "immediate" | "after-initial-therapy";

/**
 * The clinically load-bearing output. The UI states the REASON, not a flag:
 * "code 4 in the lower left" is actionable, a red dot is not.
 */
export interface ChartingRequirement {
  kind: ChartingRequirementKind;
  timing: ChartingTiming | null;
  /** Which sextants must be charted. Empty when nothing is required; all six
   *  when the requirement is full-mouth. */
  sextants: SextantId[];
  /** The highest code found anywhere in the mouth, which is what drives the
   *  requirement. Null when nothing was scored at all. */
  highest: BpeScore | null;
  /** The sextants actually holding that highest code. */
  drivenBy: SextantId[];
  furcationPresent: boolean;
  /** One whole sentence for the screen. Never a fragment to be templated. */
  reason: string;
  /** Further whole sentences that qualify the requirement without changing it. */
  advisories: string[];
}

// ---------------------------------------------------------------------------
// Refusals and warnings
// ---------------------------------------------------------------------------

export type PerioNoticeCode =
  /** BPE cannot measure treatment response; only a repeat 6-point chart can. */
  | "bpe-not-for-monitoring"
  /** BPE is never used around implants. */
  | "bpe-not-around-implants"
  /** A reading was recorded against a sextant that cannot be scored. */
  | "sextant-not-scorable"
  /** A tooth's reading has nowhere to go: its sextant cannot be scored and
   *  neither can the neighbour it would be recorded with. */
  | "tooth-not-recordable"
  /** A reading identified no tooth and no scorable sextant. */
  | "observation-unplaced"
  /** A reading names a tooth the mouth was not said to contain. */
  | "tooth-not-present"
  /** `*` was recorded. Raised, not silently escalated — see bpe.ts. */
  | "furcation-recorded"
  /** BPE is a mandatory FP17 field: recording it here does not stop it having
   *  to be typed into Dentally too. Emitted by the copy layer, not by bpe.ts. */
  | "fp17-double-entry";

/**
 * "refusal" — do not proceed; the reading must not be recorded this way.
 * "warning" — proceed, but the clinician must see this.
 * "info"    — context worth stating.
 */
export type PerioNoticeSeverity = "refusal" | "warning" | "info";

export interface PerioNotice {
  code: PerioNoticeCode;
  severity: PerioNoticeSeverity;
  /** A whole sentence, written for a clinician to read on screen. */
  message: string;
  sextants: SextantId[];
  teeth: number[];
}

// ---------------------------------------------------------------------------
// The exam
// ---------------------------------------------------------------------------

/**
 * What the platform knows about the mouth and the patient BEFORE the readings.
 * Passed in rather than looked up, because this directory is pure.
 */
export interface BpeContext {
  /** FDI numbers of the teeth present. A sextant qualifies on these. */
  presentTeeth: readonly number[];
  /** Teeth carrying implants. Excluded from qualification AND refused if probed. */
  implantTeeth?: readonly number[];
  /** The patient carries a periodontitis diagnosis, or is in active periodontal
   *  treatment or maintenance. If true, a BPE cannot be what measures the
   *  response — that requires a repeat 6-point chart. */
  underPeriodontalCare?: boolean;
  /** How many BPEs already exist for this patient. Serial BPEs on a patient in
   *  periodontal care are the specific pattern PERIO.md §3.1 says to call out. */
  previousExamCount?: number;
}

export interface BpeExamInput {
  context: BpeContext;
  observations: readonly BpeObservation[];
  /** Defaults to WHO 621 — see DEFAULT_PROBE in bpe.ts. */
  probe?: PerioProbe;
  /** Free text when `probe` is "other". */
  probeNote?: string | null;
  /** Attribution is not optional. */
  recorded: PerioAttribution;
}

export interface BpeExamResult {
  sextants: ScoredSextant[];
  /** Convenience view of the same thing, for callers that index by sextant. */
  scores: Record<SextantId, BpeScore | null>;
  highest: BpeScore | null;
  requirement: ChartingRequirement;
  notices: PerioNotice[];
  probe: PerioProbe;
  probeNote: string | null;
  recorded: PerioAttribution;
}

/** A stored exam: the result plus its append-only envelope. */
export interface BpeExamRecord extends PerioEntryMeta {
  siteId: string;
  patientId: string;
  probe: PerioProbe;
  probeNote: string | null;
  scores: Record<SextantId, BpeScore | null>;
  statuses: Record<SextantId, SextantStatus>;
}

// ---------------------------------------------------------------------------
// Six-point charting — the vocabulary only. The measuring and the CAL
// computation belong to the six-point builder; these shapes are here so the
// whole module speaks one language.
// ---------------------------------------------------------------------------

/** mesiobuccal · buccal · distobuccal · mesiolingual · lingual · distolingual. */
export type PerioSiteId = "mb" | "b" | "db" | "ml" | "l" | "dl";

/**
 * MOBILITY STAGES 1–3, which is what Dentally records.
 *
 * This used to be `MillerMobility = 0 | 1 | 2 | 3`, taken from the clinical
 * literature. Dentally's own help article for creating a perio exam says the
 * `m` key cycles through "mobility stages 1–3", so Dentally wins: the entire
 * point of this module is that staff do not relearn a scale they already use
 * every day.
 *
 * THERE IS NO STAGE 0 and there is no alias to the old union. Two scales in one
 * codebase is how a 4 becomes a III. "No mobility found" is `null` — the
 * absence of a finding — not a zero, which on the old scale was a positive
 * clinical claim of "tested, none". Anything that needs to distinguish "not
 * tested" from "tested and none" must add a separate field and say so on
 * screen, not overload a number.
 */
export type MobilityStage = 1 | 2 | 3;

/**
 * FURCATION GRADES 1–4, which is what Dentally records.
 *
 * This used to be `HampFurcation = 1 | 2 | 3` (Hamp I–III). Dentally's help
 * article says the `f` key "will cycle through furcation grades 1, 2, 3 and 4".
 * A hygienist who types a grade 4 furcation and cannot is a hygienist who stops
 * trusting the screen, so grade 4 exists here. Null means no furcation
 * involvement was recorded.
 */
export type FurcationGrade = 1 | 2 | 3 | 4;

/**
 * One site. There is NO `cal` field, deliberately: CAL is depth + recession and
 * PERIO.md §3.2 says it is computed, never typed. A stored CAL is a CAL that can
 * disagree with its own inputs.
 */
export interface PerioSiteMeasurement {
  site: PerioSiteId;
  /** mm. */
  probingDepth: number | null;
  /** mm. Negative where the margin sits coronal to the CEJ. */
  recession: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
}

export interface PerioToothRecord {
  tooth: number;
  sites: PerioSiteMeasurement[];
  mobility: MobilityStage | null;
  furcation: FurcationGrade | null;
}

export interface SixPointChart extends PerioEntryMeta {
  siteId: string;
  patientId: string;
  probe: PerioProbe;
  /** Which sextants this chart covers. A code-3 chart covers one sextant; a
   *  code-4 chart covers all six, and a partial chart must never render as if
   *  it were full-mouth. */
  sextants: SextantId[];
  teeth: PerioToothRecord[];
}

// ---------------------------------------------------------------------------
// PLAQUE AND BLEEDING BY SURFACE — Dentally's separate tab.
//
// This is NOT the six-point exam. The pocket chart records bleeding and plaque
// per SITE, as a property of a probing; Dentally additionally has a "Plaque &
// Bleeding" tab where the clinician labels a tooth SURFACE, which colours red
// for bleeding, yellow for plaque and orange for both, and "calculates the
// percentages of available surfaces where bleeding, plaque or both is present".
// Both exist, they are different examinations, and neither is derived from the
// other — a plaque control record is taken with a disclosing agent on surfaces
// that were never probed.
//
// AVAILABLE IS THE WHOLE PROBLEM. See PlaqueBleedingRecord.examinedTeeth.
// ---------------------------------------------------------------------------

/**
 * The surfaces a plaque or bleeding label can sit on.
 *
 * DERIVED from the tooth chart's own SurfaceId rather than re-listed, so the two
 * cannot drift: if charting ever renames a surface, this stops compiling instead
 * of quietly describing a different mouth.
 *
 * Occlusal is excluded, and that is the only difference. An occlusal surface has
 * no gingival margin, so it has no bleeding on probing and no marginal plaque
 * score; offering it would put a surface on the screen that can never
 * legitimately be marked, and a surface that can never be marked still lands in
 * the denominator and drags every percentage down.
 */
export type PerioSurfaceId = Exclude<SurfaceId, "occlusal">;

/** What was found on one surface. Both false is a real, recorded result: the
 *  surface was examined and was clean. */
export interface SurfaceFinding {
  surface: PerioSurfaceId;
  plaque: boolean;
  bleeding: boolean;
}

export interface ToothSurfaceRecord {
  tooth: number;
  surfaces: SurfaceFinding[];
}

/**
 * A stored plaque-and-bleeding examination, with its append-only envelope.
 *
 * `examinedTeeth` IS THE DENOMINATOR, and it is declared rather than inferred.
 * Every one of those teeth contributes its four surfaces to the total whether or
 * not it carries a mark, because a tooth that was examined and found clean is a
 * result. A tooth that was NOT examined contributes nothing at all — neither to
 * the numerator nor to the total.
 *
 * Inferring the denominator instead is how the number lies, in both directions:
 * count only the surfaces that carry a mark and every score is 100%; count every
 * tooth in the mouth and one plaque surface out of an unexamined dentition reads
 * as an immaculate 0.9%.
 */
export interface PlaqueBleedingRecord extends PerioEntryMeta {
  siteId: string;
  patientId: string;
  examinedTeeth: number[];
  teeth: ToothSurfaceRecord[];
}

// ---------------------------------------------------------------------------
// Diagnosis (2017/18 classification) — vocabulary only. Decision support that
// shows its working; the clinician owns the diagnosis (PERIO.md §3.3).
// ---------------------------------------------------------------------------

export type PerioStage = "I" | "II" | "III" | "IV";
export type PerioGrade = "A" | "B" | "C";

/** Modifies the grade UP only. Never down. */
export type GradeModifier = "smoking" | "diabetes";

export interface PerioDiagnosisSuggestion {
  stage: PerioStage | null;
  grade: PerioGrade | null;
  modifiersApplied: GradeModifier[];
  /** Each step of the reasoning, as whole sentences, so the clinician can
   *  disagree with a specific step rather than with a verdict. */
  workings: string[];
}
