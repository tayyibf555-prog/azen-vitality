import {
  ADJACENT_SEXTANT,
  MIN_TEETH_PER_SEXTANT,
  SEXTANTS,
  SEXTANT_LABEL,
  SEXTANT_TEETH,
  BPE_CODE_MEANING,
  chartingRequirement,
  serialiseBpeScore,
} from "@/lib/perio/bpe";
import { londonDateTimeLabel } from "@/lib/time/london";
import { BAND_CLASS, PROBE_LABEL, UNSCORED_CLASS, bpeBand } from "./bpe-legend";
import { BpeEntry, type BpeEntryCopy } from "./bpe-entry";
import type {
  BpeCode,
  BpeScore,
  ChartingRequirement,
  ClinicianRef,
  PerioAttribution,
  PerioNotice,
  PerioProbe,
  SextantId,
  SextantQualificationMap,
  SextantStatus,
} from "@/lib/perio/types";

// ===========================================================================
// THE BPE GRID. Six sextants, two rows of three, and the obligation those six
// numbers create.
//
// THIS SCREEN IS TOUCHED AT EVERY EXAMINATION, so it is built to be read in a
// glance and filled without thought. Everything on it is either a number the
// clinician entered or a sentence the engine wrote about those numbers; there is
// no third category, and in particular there is no rule re-expressed in JSX.
// chartingRequirement() decides what a 3 or a 4 now demands, bpeBand() decides
// which colour that obligation wears, and this file decides only where they sit.
//
// WHY THIS LAYOUT WAS BUILT WITHOUT A DENTALLY SCREENSHOT, when the FDI arch
// waited for one. BPE is clinically STANDARDISED — the BSP defines the form, so
// every UK system draws it near-identically: six boxes, two rows of three, upper
// above lower, patient's right on the viewer's left exactly as the chart is
// drawn. Restorative charting has no such standard, which is why that one waited.
// The identities and the tooth sets are read from bpe.ts and never restated here,
// so a reskin moves pixels and cannot move a sextant.
//
// THE GREY BOX IS THE WHOLE POINT OF THE COMPONENT. A sextant that cannot be
// scored, and a sextant nobody probed, are DISTINCT STATES and neither is a zero:
// code 0 is a positive claim of health, and a blank box on a BPE grid reads as
// exactly that claim to a clinician with twenty seconds between patients
// (CHARTING.md 6.3, "false completeness"). So every one of the six boxes always
// says something, an unscorable one names the adjacent sextant its teeth were
// recorded with, and none of them is ever empty.
//
// FOUR NULL STATES, TOLD APART. "Not shown here" (the gate is off — this screen
// knows nothing about this patient), "No reading" (the gate is on and nobody
// probed this sextant), "Too few teeth" (fewer than MIN_TEETH_PER_SEXTANT
// qualifying teeth), and "No teeth". Collapsing any pair of them writes a missed
// examination down as a clean result.
//
// BPE IS A MANDATORY FP17 FIELD (since 1 October 2022). While claims still go out
// of Dentally, a score recorded here has to be typed there too. That sentence is
// rendered where the clinician recording the score can see it, never tucked into
// a settings page, and it comes in as PERIO_COPY.doubleEntry rather than being
// written here — see the note on `copy` below.
//
// NO "use client", and NO import of src/lib/perio/gate.ts. That module is
// `server-only` by design (its comment: the flag never crosses the wire), and
// importing it here would make this component unimportable from a client
// component for the sake of two strings the shell already holds. So the gate
// arrives as a boolean and its sentences arrive as props. bpe.ts, by contrast, is
// pure and safe on either side of the boundary.
// ===========================================================================

/**
 * One BPE as the screen needs it.
 *
 * DELIBERATELY THE INTERSECTION OF THE TWO SHAPES THE SERVER CAN PRODUCE, so the
 * shell can feed it either. A StoredBpeExam off the repository carries `scores`
 * and `statuses` and nothing richer; a live BpeExamResult off scoreBpeExam()
 * carries those plus the full SextantQualification. Requiring the richer one
 * would force the shell to fabricate qualification data for a stored row — a
 * fabricated `presentTeeth` on a clinical screen is a worse outcome than a
 * slightly thinner sentence.
 *
 * NOTHING DERIVABLE IS ACCEPTED. There is no `requirement` field and no
 * `highest`: both come out of chartingRequirement(scores) below, so the screen
 * physically cannot show a requirement that disagrees with the scores printed
 * beside it.
 */
export interface BpeExamView {
  scores: Record<SextantId, BpeScore | null>;
  statuses: Record<SextantId, SextantStatus>;
  /** Present only when the caller scored the exam in this request. When it is
   *  here the boxes can name the exact teeth; when it is not they fall back to
   *  ADJACENT_SEXTANT, which is honest but coarser for the anterior sextants. */
  qualification?: SextantQualificationMap | null;
  probe: PerioProbe;
  probeNote?: string | null;
  /** GDC 4.1.4: the treating clinician is on the record, always. */
  recorded: PerioAttribution;
  /** 1-based, assigned by the database. */
  version?: number | null;
  /** GDC 4.1.5: an amendment is a new version that names the one it replaces and
   *  says why. Both render; neither is optional in substance. */
  supersedesId?: string | null;
  amendmentReason?: string | null;
  /** A withdrawn exam is still part of the record and is still shown — that is
   *  the whole difference between retracting and deleting — but it must never be
   *  read as the standing score. */
  retractedAt?: string | null;
  retractionReason?: string | null;
}

/**
 * The two gate sentences, passed in rather than imported.
 *
 * They are PERIO_COPY.disabled and PERIO_COPY.doubleEntry from
 * src/lib/perio/gate.ts, which is `server-only`. Both are REQUIRED, and
 * `doubleEntry` in particular is required rather than optional on purpose: a
 * missing FP17 notice is the one omission on this screen that costs money as well
 * as accuracy, and a required prop makes forgetting it a type error instead of a
 * silence.
 */
export interface BpeGateCopy {
  disabled: string;
  doubleEntry: string;
}

/**
 * Everything the entry panel needs, as PLAIN DATA.
 *
 * It arrives as one object rather than as six loose props for a reason worth
 * stating: BpeEntry is a client island and this component is universal, so every
 * field crossing this seam has to be serialisable. Grouping them makes that a
 * single shape to check rather than a habit to remember.
 *
 * `canSave` is separate from the grid's `enabled` because src/lib/perio/gate.ts
 * keeps isPerioEnabled() and canSavePerio() separate — a future read-only preview
 * mode has somewhere to diverge, and with `canSave` false the panel still renders
 * and simply has nothing on it to type into.
 */
export interface BpeEntrySeat {
  client: string;
  siteId: string;
  patientId: string;
  canSave: boolean;
  /** GDC 4.1.4. Null refuses authorship rather than inventing an author. */
  clinician: ClinicianRef | null;
  presentTeeth?: readonly number[];
  implantTeeth?: readonly number[];
  copy: BpeEntryCopy;
}

export function BpeGrid({
  exam,
  enabled,
  copy,
  notices,
  entry,
  className,
}: {
  /** null when no BPE has been recorded in this platform — which is NOT a
   *  finding about the patient and is rendered as such. */
  exam: BpeExamView | null;
  /** isPerioEnabled(), resolved on the server. With it off the whole screen is
   *  read-only and says why, rather than disappearing. */
  enabled: boolean;
  copy: BpeGateCopy;
  /** The engine's own notices for THIS exam — implant and monitoring refusals,
   *  rerouted sextants, the furcation advisory. Rendered verbatim; the standing
   *  limitations of the instrument live in the legend instead. */
  notices?: readonly PerioNotice[];
  /** The entry panel's scope and sentences. Omitted only where a BPE cannot be
   *  authored at all — a comparison view, say. It is NOT omitted when the gate is
   *  shut: the panel then renders with nothing on it to type into, because the
   *  shape of the feature is what the preview is for. */
  entry?: BpeEntrySeat;
  className?: string;
}) {
  const scores = exam?.scores ?? null;
  // DERIVED, NEVER PASSED IN. One call, and every consequence on the screen —
  // the headline, the sentence, the sextants to chart, the advisories — reads off
  // this one result.
  const requirement = chartingRequirement(scores ?? {});
  const retracted = Boolean(exam?.retractedAt);

  return (
    <section
      className={`space-y-2.5 ${className ?? ""}`}
      aria-label="Basic Periodontal Examination"
    >
      {/* THE GATE, FIRST, because with it off nothing below is a statement about
          this patient and a reader must know that before reading anything else.
          The sentence is the tested one and it explicitly redirects to Dentally,
          which is where this patient's BPE actually is. */}
      {!enabled ? (
        <Banner tone="neutral" title="Periodontal charting is switched off here">
          {copy.disabled}
        </Banner>
      ) : null}

      {/* A WITHDRAWN EXAM IS NOT THE STANDING SCORE. It stays on screen because a
          retraction is part of the record, but it is stated before the numbers
          rather than after them — a reader who takes the grid at face value and
          then finds the retraction underneath has already acted on it. */}
      {retracted ? (
        <Banner
          tone="danger"
          title={`Withdrawn ${exam?.retractedAt ? londonDateTimeLabel(exam.retractedAt) : ""}`.trim()}
        >
          {exam?.retractionReason
            ? `${exam.retractionReason} This examination remains on the record and is shown for that reason; it is not this patient's standing BPE.`
            : "This examination remains on the record and is shown for that reason; it is not this patient's standing BPE."}
        </Banner>
      ) : null}

      {/* THE FP17 CONSEQUENCE, where the person recording the score sees it. Only
          when the gate is on: with it off nothing is being recorded here and the
          double-entry warning would be noise that trains people past amber. */}
      {enabled ? (
        <Banner tone="warning" title="This score is also an NHS claim field">
          {copy.doubleEntry}
        </Banner>
      ) : null}

      {/* THE GRID. Two rows of three, upper above lower, patient's right on the
          viewer's left — the order SEXTANTS is already in, which is why the rows
          are sliced out of it rather than listed. The arch split reads the
          SextantId's own convention (types.ts: "Upper/Lower x Right/Anterior/
          Left"); it is the one structural fact this file knows about the ids, and
          it is not a second table of them. */}
      <div className="overflow-x-auto">
        <div className="min-w-[38rem] rounded-xl border border-line bg-card p-2.5">
          {ARCHES.map(({ label, sextants }, index) => (
            <div key={label}>
              <div className="flex items-center gap-2 px-0.5 pb-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
                  {label}
                </span>
                {/* The midline. A hairline, not a gap: it is where the arch
                    divides, and it keeps the six boxes on one rhythm. */}
                <span aria-hidden className="h-px flex-1 bg-line" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {sextants.map((sextant) => (
                  <SextantBox
                    key={sextant}
                    sextant={sextant}
                    score={scores?.[sextant] ?? null}
                    status={exam?.statuses?.[sextant] ?? "scorable"}
                    qualification={exam?.qualification ?? null}
                    enabled={enabled}
                    hasExam={exam !== null}
                    requiresChart={requirement.sextants.includes(sextant)}
                  />
                ))}
              </div>
              {index === 0 ? <div className="h-2" /> : null}
            </div>
          ))}
        </div>
      </div>

      {/* WHAT THIS NOW REQUIRES. The load-bearing output of the whole screening,
          and the reason it is a block rather than a chip: "code 4 in the lower
          left, so a full-mouth 6-point chart from the outset" is actionable and a
          red dot is not. */}
      {enabled && exam ? <RequirementPanel requirement={requirement} /> : null}

      {/* THE ENGINE'S NOTICES, verbatim and grouped by severity so a refusal is
          never buried under an advisory. */}
      {notices && notices.length > 0 ? (
        <ul className="space-y-1.5">
          {notices.map((notice, i) => (
            <li key={`${notice.code}-${i}`}>
              <Banner tone={NOTICE_TONE[notice.severity]} title={NOTICE_TITLE[notice.severity]}>
                {notice.message}
              </Banner>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ATTRIBUTION. Who, when, with what — GDC 4.1.4, and the amendment chain
          per 4.1.5. Quiet grey, one line, the same register the chart's status bar
          uses: this is provenance, not a warning. */}
      {exam ? <Attribution exam={exam} /> : null}

      {/* RECORDING ONE. Last in the section on purpose: everything above it is
          the STANDING examination and its consequences, and a clinician about to
          type six new numbers should have read what is already on the record —
          in particular a retraction, and in particular the FP17 banner, both of
          which sit above. With the gate shut this panel is still here and has
          nothing on it to type into. */}
      {entry ? (
        <BpeEntry
          client={entry.client}
          siteId={entry.siteId}
          patientId={entry.patientId}
          canSave={entry.canSave}
          clinician={entry.clinician}
          presentTeeth={entry.presentTeeth}
          implantTeeth={entry.implantTeeth}
          probe={exam?.probe}
          copy={entry.copy}
        />
      ) : null}
    </section>
  );
}

/**
 * The codes actually on this grid, for BpeLegend's `codesPresent`.
 *
 * Exported from here rather than recomputed by the shell so the legend it dims
 * cannot disagree with the grid it sits beside — the same argument the legend
 * itself makes for owning the band vocabulary. Returns [] for no exam, which is
 * correct: an unrecorded BPE has no codes, and the legend then shows all five at
 * full strength because none of them is the one on screen.
 */
export function bpeCodesPresent(exam: BpeExamView | null): BpeCode[] {
  if (!exam) return [];
  const seen = SEXTANTS.map((s) => exam.scores[s]?.code).filter(
    (c): c is BpeCode => c !== undefined && c !== null,
  );
  return [...new Set(seen)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The arches. Derived from SEXTANTS, in SEXTANTS' own order, so the grid cannot
// gain, lose or reorder a sextant without bpe.ts saying so.
// ---------------------------------------------------------------------------

const ARCHES: readonly { label: string; sextants: readonly SextantId[] }[] = [
  { label: "Upper", sextants: SEXTANTS.filter((s) => s.startsWith("U")) },
  { label: "Lower", sextants: SEXTANTS.filter((s) => s.startsWith("L")) },
];

// ---------------------------------------------------------------------------
// One box
// ---------------------------------------------------------------------------

/**
 * A sextant, in whichever of its states it is in.
 *
 * THE ORDER OF THE BRANCHES IS THE SAFETY PROPERTY. A score is only ever printed
 * as a score when there is one; otherwise the box falls through to a named,
 * dashed, grey state that says which kind of nothing it is. There is no path
 * through this function that renders an empty box.
 *
 * A sextant can legitimately hold BOTH a score and a non-scorable status — a
 * stored row that took a rerouted reading, for instance — so the status sentence
 * is rendered alongside the number rather than instead of it. Hiding one to keep
 * the box tidy is how a reading ends up attributed to a sextant that could not be
 * scored.
 */
function SextantBox({
  sextant,
  score,
  status,
  qualification,
  enabled,
  hasExam,
  requiresChart,
}: {
  sextant: SextantId;
  score: BpeScore | null;
  status: SextantStatus;
  qualification: SextantQualificationMap | null;
  enabled: boolean;
  hasExam: boolean;
  requiresChart: boolean;
}) {
  const band = score ? bpeBand(score) : null;
  const boxClass = band ? BAND_CLASS[band] : UNSCORED_CLASS;
  const present = qualification?.[sextant]?.presentTeeth ?? null;
  const received = qualification?.[sextant]?.receivedTeeth ?? [];

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${boxClass}`}
      aria-label={`${SEXTANT_LABEL[sextant]} sextant`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em]">{sextant}</span>
        <span className="text-[10.5px] font-medium capitalize opacity-80">
          {SEXTANT_LABEL[sextant]}
        </span>
      </div>

      {/* THE NUMBER, big enough to read across a surgery. serialiseBpeScore
          renders the star, so "3" and "3*" come from the engine's own writer and
          the grid cannot print a star the record does not hold. */}
      <div className="flex items-end gap-2 pt-0.5">
        <span className="text-[30px] font-semibold leading-[1] tabular-nums">
          {score ? serialiseBpeScore(score) : "–"}
        </span>
        {score ? (
          <span className="pb-[3px] text-[11px] font-medium leading-[1.25] opacity-90">
            {score.furcation ? "furcation" : null}
          </span>
        ) : (
          <span className="pb-[3px] text-[11px] font-semibold leading-[1.25]">
            {nullStateHeadline(status, enabled, hasExam)}
          </span>
        )}
      </div>

      {/* The engine's own definition of the code. On the box, not in a tooltip: a
          title attribute is not reachable by keyboard and is not dependably
          announced, and "the black band disappears" is the sentence that makes a
          4 mean something. */}
      <p className="pt-1 text-[11px] leading-[1.35]">
        {score ? BPE_CODE_MEANING[score.code] : nullStateSentence(sextant, status, enabled, hasExam, qualification)}
      </p>

      {/* A scored sextant that ALSO cannot be scored on its own teeth. Rare, and
          exactly the case a reader must not miss. */}
      {score && status !== "scorable" ? (
        <p className="pt-1 text-[11px] font-medium leading-[1.35]">
          {nullStateSentence(sextant, status, enabled, hasExam, qualification)}
        </p>
      ) : null}

      {/* Teeth donated by a neighbour that could not be scored. Stated because
          this box's number was rolled up from more than its own sextant. */}
      {received.length > 0 ? (
        <p className="pt-1 text-[11px] leading-[1.35] opacity-90">
          Includes {received.length === 1 ? "tooth" : "teeth"} {received.join(", ")} recorded from an
          adjacent sextant that could not be scored.
        </p>
      ) : null}

      {/* The tooth set. Canonical from SEXTANT_TEETH; when the caller supplied a
          qualification the teeth that are NOT present are struck through, so the
          reason a sextant is unscorable is visible rather than merely asserted. */}
      <div className="flex flex-wrap gap-x-1.5 pt-1.5 text-[10.5px] tabular-nums opacity-70">
        {SEXTANT_TEETH[sextant].map((tooth) => (
          <span
            key={tooth}
            className={present && !present.includes(tooth) ? "line-through opacity-60" : undefined}
          >
            {tooth}
          </span>
        ))}
      </div>

      {requiresChart ? (
        <p className="pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]">
          6-point chart required
        </p>
      ) : null}
    </div>
  );
}

/** The two-or-three word version of the null state, for the slot the digit would
 *  have occupied. Never blank, and never "0". */
function nullStateHeadline(status: SextantStatus, enabled: boolean, hasExam: boolean): string {
  if (!enabled) return "Not shown here";
  if (status === "no-teeth") return "No teeth";
  if (status === "insufficient-teeth") return "Too few teeth";
  return hasExam ? "No reading" : "Not recorded";
}

/**
 * The whole sentence underneath it, which is where the clinical work is done.
 *
 * AN UNSCORABLE SEXTANT NAMES WHERE ITS TEETH WENT. With a qualification map that
 * is the exact destination per tooth, taken from the engine's own reassignments;
 * without one it falls back to ADJACENT_SEXTANT, which is precise for the four
 * posterior sextants and deliberately vague for the two anterior ones — bpe.ts
 * leaves those null because an anterior sextant has a neighbour on EACH side and
 * the answer is only ever per tooth. Naming one of them would put a reading on
 * the wrong side of the mouth, so the sentence declines to.
 *
 * A tooth that reassigns to NOTHING is stated as such. Two crippled neighbours do
 * not rescue each other, and a reading recorded nowhere must be said out loud
 * rather than quietly scored somewhere plausible.
 */
function nullStateSentence(
  sextant: SextantId,
  status: SextantStatus,
  enabled: boolean,
  hasExam: boolean,
  qualification: SextantQualificationMap | null,
): string {
  if (!enabled) {
    return "Periodontal charting is off in this platform, so this box says nothing about this patient. Check Dentally.";
  }

  if (status === "no-teeth") {
    return "No teeth in this sextant, so there is nothing to examine. This is not a score of 0.";
  }

  if (status === "insufficient-teeth") {
    const reassignments = qualification?.[sextant]?.reassignments ?? [];
    const destinations = [...new Set(reassignments.map((r) => r.to))];
    const named = destinations.filter((d): d is SextantId => d !== null);
    const stranded = destinations.some((d) => d === null);

    const head = `Fewer than ${MIN_TEETH_PER_SEXTANT} qualifying teeth, so this sextant is not scored — never 0.`;

    if (named.length > 0) {
      const where = `Its remaining ${reassignments.length === 1 ? "tooth is" : "teeth are"} recorded with the ${listLabels(named)}.`;
      return stranded
        ? `${head} ${where} One or more could not be recorded anywhere: the adjacent sextant cannot be scored either.`
        : `${head} ${where}`;
    }
    if (stranded) {
      return `${head} Its remaining teeth could not be recorded anywhere, because the adjacent sextant cannot be scored either — those readings are held nowhere on this grid.`;
    }

    // No qualification map: fall back to the engine's fixed adjacency, which is
    // null for the anterior sextants by design.
    const fixed = ADJACENT_SEXTANT[sextant];
    return fixed
      ? `${head} Its remaining teeth are recorded with the ${SEXTANT_LABEL[fixed]} sextant.`
      : `${head} Its remaining teeth are recorded with the adjacent sextant on that tooth's own side of the midline.`;
  }

  return hasExam
    ? "No reading was taken here. That is the absence of a score, not a score of 0 — nothing on this screen says this sextant is healthy."
    : "No BPE has been recorded in this platform for this patient. That is not a finding about their periodontal health; check Dentally.";
}

// ---------------------------------------------------------------------------
// The protocol consequence
// ---------------------------------------------------------------------------

/**
 * A heading, a whole sentence, the sextants, and any advisory.
 *
 * THE SENTENCE IS THE ENGINE'S. `requirement.reason` is written by
 * chartingRequirement() as a complete sentence for exactly this slot, so the rule
 * — which code, which scope, which timing — is stated once in tested code and
 * merely displayed here. The heading below is a HEADING and not the rule: it
 * names the kind of chart, and the reason underneath says why and by when.
 */
function RequirementPanel({ requirement }: { requirement: ChartingRequirement }) {
  const escalated = requirement.kind !== "none";
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${escalated ? "border-tint-red-line bg-tint-red" : "border-line bg-card"}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
          What this now requires
        </span>
        <span
          className={`text-[14px] font-semibold tracking-[-0.1px] ${escalated ? "text-status-red" : "text-navy"}`}
        >
          {REQUIREMENT_TITLE[requirement.kind]}
        </span>
        {requirement.timing ? (
          <span
            className={`rounded-md px-1.5 py-[1px] text-[11px] font-medium ${escalated ? "bg-tint-red text-status-red" : "bg-card-muted text-muted"}`}
          >
            {TIMING_LABEL[requirement.timing]}
          </span>
        ) : null}
      </div>

      <p className="pt-1 text-[13px] leading-[1.5] text-ink">{requirement.reason}</p>

      {/* Which sextants, spelled out. "Full mouth" is all six and says so; a
          partial requirement names its own, so a chart taken of the wrong sextant
          is a mistake the screen made no contribution to. */}
      {requirement.sextants.length > 0 ? (
        <p className="pt-1 text-[12px] leading-[1.45] text-muted">
          Chart:{" "}
          <span className="font-medium text-ink">{listLabels(requirement.sextants)}</span>
        </p>
      ) : null}

      {/* Advisories qualify the requirement without changing it — the furcation
          note is the one that exists today, and it exists precisely so the
          engine's refusal to escalate on a star alone is visible rather than
          silent. */}
      {requirement.advisories.map((advisory) => (
        <p key={advisory} className="pt-1.5 text-[12px] leading-[1.45] text-muted">
          {advisory}
        </p>
      ))}
    </div>
  );
}

/** HEADINGS, not rules. The rule — which code produces which of these, over what
 *  scope and by when — is chartingRequirement()'s and is printed verbatim
 *  underneath as `reason`. */
const REQUIREMENT_TITLE: Record<ChartingRequirement["kind"], string> = {
  none: "No 6-point chart required by this screening",
  "sextant-6-point": "6-point chart of the affected sextants",
  "full-mouth-6-point": "Full-mouth 6-point chart",
};

const TIMING_LABEL: Record<"immediate" | "after-initial-therapy", string> = {
  immediate: "From the outset",
  "after-initial-therapy": "After initial therapy",
};

// ---------------------------------------------------------------------------
// Notices and attribution
// ---------------------------------------------------------------------------

type Tone = "neutral" | "warning" | "danger";

const NOTICE_TONE: Record<PerioNotice["severity"], Tone> = {
  refusal: "danger",
  warning: "warning",
  info: "neutral",
};

const NOTICE_TITLE: Record<PerioNotice["severity"], string> = {
  refusal: "Not recorded",
  warning: "Check this",
  info: "Note",
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-card-muted/60 text-ink",
  warning: "border-tint-amber-line bg-tint-amber text-status-amber",
  danger: "border-tint-red-line bg-tint-red text-status-red",
};

/** One statement, one shape, everywhere on this screen. The weight comes from the
 *  type and a single hairline tint, not from a row of chips: PRODUCT.md's verdict
 *  on the chart was that a drift of caveat chips read worse than Dentally's one
 *  line of grey text. */
function Banner({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-3.5 py-2 ${TONE_CLASS[tone]}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em]">{title}</p>
      <p className="pt-0.5 text-[12.5px] leading-[1.45]">{children}</p>
    </div>
  );
}

/**
 * WHO, WHEN, AND WITH WHAT.
 *
 * GDC Standard 4.1.4 puts the treating clinician's name on the record and 4.1.5
 * requires amendments to be clearly marked and dated, so none of this is
 * optional and none of it is behind a disclosure. The GDC number renders only
 * when the practice holds one: a blank is honest, an invented one is not.
 *
 * The timestamp goes through londonDateTimeLabel, which parses the ISO string the
 * server sent and reads no clock — a Date.now() in a render path is a hydration
 * bug this repo has already paid for once.
 */
function Attribution({ exam }: { exam: BpeExamView }) {
  const { clinician, at } = exam.recorded;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-[1.45] text-faint">
      <span>
        Recorded by <span className="font-medium text-ink">{clinician.name}</span>
        {clinician.gdcNumber ? ` (GDC ${clinician.gdcNumber})` : ""}
      </span>
      <span className="tabular-nums">{londonDateTimeLabel(at)}</span>
      <span>
        {PROBE_LABEL[exam.probe]}
        {exam.probeNote ? ` — ${exam.probeNote}` : ""}
      </span>
      {typeof exam.version === "number" ? (
        <span className="tabular-nums">Version {exam.version}</span>
      ) : null}
      {exam.supersedesId ? (
        <span className="text-ink">
          Amends an earlier examination
          {exam.amendmentReason ? `: ${exam.amendmentReason}` : ""}
        </span>
      ) : null}
    </div>
  );
}

/** "the upper right and upper anterior". Sentence-shaped, because these labels
 *  land inside prose. */
function listLabels(sextants: readonly SextantId[]): string {
  const labels = sextants.map((s) => SEXTANT_LABEL[s]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
