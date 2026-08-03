import {
  BPE_CODE_MEANING,
  DEFAULT_PROBE,
  MIN_TEETH_PER_SEXTANT,
  chartingRequirement,
  isBpeCode,
} from "@/lib/perio/bpe";
import type { BpeCode, BpeScore, PerioProbe } from "@/lib/perio/types";

/**
 * THE BPE LEGEND — what every box on the grid means, and what the instrument
 * itself is not.
 *
 * WHY A LEGEND AT ALL ON A SIX-BOX GRID. Because the grid carries three things a
 * number alone cannot: a severity colour, a `*`, and a box that is deliberately
 * NOT a number. CHARTING.md 6.3 names the failure mode this whole module exists
 * to prevent — "false completeness", a page that reads as authoritative and
 * therefore reads its own silence as a clean result. A colour with no key, or a
 * grey box with no explanation, is that failure in miniature. Everything the
 * grid can draw is named here, and nothing here is behind a toggle.
 *
 * IT OWNS THE VOCABULARY THE GRID PAINTS WITH, which is why `bpeBand`,
 * `BAND_CLASS` and `PROBE_LABEL` are exported from this file rather than
 * duplicated in bpe-grid.tsx. Two hand-written colour tables is exactly how a
 * legend comes to describe a chart it no longer matches — the same argument
 * chart-legend.tsx makes for rendering its swatches through surfaceStyle().
 *
 * THE CODE SET IS DERIVED, NOT TYPED OUT. `BPE_CODES` reads the keys of the
 * engine's own BPE_CODE_MEANING and filters them through the engine's own
 * isBpeCode, so a legend listing a code the engine does not know, or omitting one
 * it does, cannot be written here.
 *
 * TWO SENTENCES HERE ARE STANDING SCOPE STATEMENTS, NOT ENGINE OUTPUT, and the
 * distinction matters. bpe.ts emits monitoringRefusal() and implantRefusal() only
 * when a particular patient trips them, and those situation-specific sentences
 * render on the grid as notices. The two lines under LIMITS below are the
 * permanent properties of the instrument (PERIO.md 3.1, CHARTING.md 6.1): a BPE
 * never measures treatment response and is never used around implants, whether or
 * not this patient happens to trigger a refusal today. A clinician reading the
 * legend of a clean screening still needs to know both.
 *
 * NO "use client". Pure presentation, no function props, no state — so the shell
 * may render it from either side of the boundary. It deliberately imports nothing
 * from src/lib/perio/gate.ts, which is `server-only`: pulling that in would make
 * this component unimportable from a client component for the sake of two strings
 * the caller already has.
 */

/**
 * The four visual bands a score can fall into, named by CONSEQUENCE rather than
 * by code.
 *
 * That is the whole reason the colour is worth having. 1 and 2 differ from each
 * other clinically but demand the same next step; 3 and 4 differ in SCOPE (one
 * sextant vs the whole mouth) and in TIMING (after initial therapy vs
 * immediately), which is the difference that actually changes what happens to the
 * patient. So the colour encodes the obligation and the printed digit encodes the
 * code, and neither channel has to carry both.
 */
export type BpeBand = "healthy" | "finding" | "sextant-chart" | "full-mouth-chart";

/**
 * THE BAND IS DERIVED FROM THE ENGINE, NOT DECIDED HERE.
 *
 * chartingRequirement() is the single authority on what a code demands, so this
 * asks it rather than re-expressing "3 means the sextant, 4 means the mouth" in a
 * component — a second copy of that rule is precisely the kind that drifts and
 * then delays a full assessment a patient needed today.
 *
 * The score is handed to it under one arbitrary sextant key because the
 * requirement's KIND depends only on the highest code in the mouth, never on
 * which sextant holds it; `drivenBy` is the field that names the sextant, and
 * this function does not read it.
 *
 * Code 0 is split out from the other non-escalating codes for a clinical reason,
 * not a cosmetic one: 0 is the only code that is a positive claim of health
 * ("no bleeding, no calculus, no pocket deeper than 3.5mm" — BPE_CODE_MEANING),
 * while 1 and 2 are findings that happen not to demand a 6-point chart. Painting
 * them the same green would make a mouth full of calculus look clean.
 */
export function bpeBand(score: BpeScore): BpeBand {
  if (score.code === 0) return "healthy";
  const kind = chartingRequirement({ UR: { code: score.code, furcation: false } }).kind;
  if (kind === "full-mouth-6-point") return "full-mouth-chart";
  if (kind === "sextant-6-point") return "sextant-chart";
  return "finding";
}

/**
 * Existing tint tokens only — no new CSS variable is declared by this feature and
 * no raw hex appears in it. A var() naming a token that was never declared paints
 * its fallback forever and shipped twice on the chart; the cheapest defence
 * available to a .tsx file (which vitest cannot collect) is to introduce no new
 * token at all.
 *
 * Every class string is written out LITERALLY because Tailwind v4 scans raw
 * source: an interpolated `bg-tint-${tone}` compiles to nothing and paints a
 * clinical severity as transparent.
 */
export const BAND_CLASS: Record<BpeBand, string> = {
  healthy: "border-tint-green-line bg-tint-green text-status-green",
  finding: "border-tint-amber-line bg-tint-amber text-status-amber",
  "sextant-chart": "border-tint-red-line bg-tint-red text-status-red",
  "full-mouth-chart": "border-status-red bg-tint-red text-status-red",
};

/** The neutral, DASHED treatment every box that carries no score wears. Dashed
 *  and grey so it cannot be mistaken for a band, and never empty: a blank box on
 *  a BPE grid reads as "healthy" to a busy clinician, which is the entire
 *  clinical hazard of this module. */
export const UNSCORED_CLASS = "border-dashed border-line-strong bg-card-muted text-muted";

/**
 * The probe, in words. The reading is meaningless without it: the 3.5–5.5mm black
 * band that separates code 3 from code 4 is a property of the WHO 621 probe, not
 * of the mouth (types.ts, PerioProbe).
 */
export const PROBE_LABEL: Record<PerioProbe, string> = {
  "who-621": "WHO 621",
  "who-cpi": "WHO CPI",
  other: "Other probe",
};

/** Derived from the engine's own meaning table and validated by the engine's own
 *  code guard, so this list cannot gain a code bpe.ts does not accept or lose one
 *  it does. */
const BPE_CODES: readonly BpeCode[] = Object.keys(BPE_CODE_MEANING)
  .map(Number)
  .filter(isBpeCode)
  .sort((a, b) => a - b);

export function BpeLegend({
  probe = DEFAULT_PROBE,
  probeNote = null,
  /** The codes actually on the grid right now. Present codes are shown at full
   *  strength and absent ones dimmed, so a clinician reading a mouth of 0s and a
   *  single 4 can find the 4's row without reading five. Nothing is hidden: an
   *  omitted row is a mark on the grid with no key. */
  codesPresent,
  className,
}: {
  probe?: PerioProbe;
  probeNote?: string | null;
  codesPresent?: readonly BpeCode[];
  className?: string;
}) {
  const present = codesPresent ? new Set<BpeCode>(codesPresent) : null;

  return (
    <div
      className={`rounded-xl border border-line bg-card px-4 py-2.5 text-[12.5px] leading-[1.35] text-muted ${className ?? ""}`}
      role="group"
      aria-label="BPE legend"
    >
      {/* THE CODES. One row, in engine order, each with its swatch, its digit and
          the engine's own sentence. The sentences are BPE_CODE_MEANING verbatim —
          they are the definitions the probe band encodes, and a paraphrase of
          "the black band disappears" is a paraphrase of the boundary between a
          sextant chart and a full-mouth one. */}
      <Line label="Codes">
        {BPE_CODES.map((code) => {
          const dim = present !== null && !present.has(code);
          return (
            <span
              key={code}
              className={`inline-flex items-start gap-2 ${dim ? "opacity-45" : ""}`}
            >
              <span
                aria-hidden
                className={`inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border text-[11px] font-semibold tabular-nums ${BAND_CLASS[bpeBand({ code, furcation: false })]}`}
              >
                {code}
              </span>
              <span className="max-w-[24rem]">{BPE_CODE_MEANING[code]}</span>
            </span>
          );
        })}
      </Line>

      {/* THE STAR IS NOT A SIXTH CODE. It is additive, so "0*" and "4*" are both
          real, which is why it gets its own line rather than a sixth swatch — a
          reader who learns it as a fifth severity has learnt the chart wrong. The
          sentence also states, out loud, that it does not by itself change the
          charting requirement, because bpe.ts deliberately does not escalate on it
          and a clinician is entitled to know that the screen is not deciding. */}
      <Line label="Modifier">
        <span className="inline-flex items-start gap-2">
          <span
            aria-hidden
            className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-card text-[12px] font-semibold text-navy"
          >
            *
          </span>
          <span className="max-w-[34rem]">
            Furcation involvement. It sits on top of any code — <b>0*</b> and <b>4*</b> are both
            real scores — and it does not by itself raise the charting requirement below. Whether
            it should is the clinician&rsquo;s judgement, and the grid says so where it appears.
          </span>
        </span>
      </Line>

      {/* THE STATE THAT IS NOT A NUMBER. Named here, in the same place as the
          codes, because the whole point is that it is a peer of them and not an
          absence of them. */}
      <Line label="Not scored">
        <span className="inline-flex items-start gap-2">
          <span
            aria-hidden
            className={`inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border text-[12px] font-semibold ${UNSCORED_CLASS}`}
          >
            –
          </span>
          <span className="max-w-[38rem]">
            A grey dashed box is <b>never a zero</b>. A sextant needs at least {MIN_TEETH_PER_SEXTANT}{" "}
            qualifying teeth to be scored at all; one that has fewer is recorded with the adjacent
            sextant instead, and each box names which. A box may also mean simply that no reading
            was taken. Code 0 is a claim that the sextant is healthy — this is the absence of a
            claim, and the two are not interchangeable.
          </span>
        </span>
      </Line>

      {/* The probe is data about the reading, not decoration: change the probe and
          the 3/4 boundary moves. */}
      <Line label="Probe">
        <span className="inline-flex items-center gap-2">
          <b className="font-semibold text-ink">{PROBE_LABEL[probe]}</b>
          {probe === "who-621" ? (
            <span>0.5mm ball end, black band 3.5–5.5mm, 20–25g force.</span>
          ) : (
            <span>The 3.5–5.5mm band that separates code 3 from code 4 is a property of the probe.</span>
          )}
          {probeNote ? <span className="text-ink">{probeNote}</span> : null}
        </span>
      </Line>

      {/* THE TWO PERMANENT LIMITS. Not conditional, not dismissible, and not the
          same thing as the engine's per-patient refusals — see the banner. */}
      <Line label="Limits">
        <span className="max-w-[30rem]">
          A BPE <b>cannot measure the response to treatment</b>. Only a repeat 6-point chart can, so
          a fall from 4 to 2 between screenings is not evidence of improvement.
        </span>
        <span className="max-w-[26rem]">
          A BPE is <b>never used around implants</b>. Peri-implant probing is recorded separately and
          an implant does not count towards a sextant&rsquo;s {MIN_TEETH_PER_SEXTANT} teeth.
        </span>
      </Line>
    </div>
  );
}

/**
 * One labelled line of the set, with a fixed-width gutter label so every line
 * starts on one vertical edge. Lifted in shape from chart-legend.tsx on purpose:
 * a clinician moving between the FDI chart and the perio screen should not have
 * to learn two legend layouts, and a ragged left edge is what makes a dense block
 * read as loose. Rows are separated by a hairline rather than by space, which
 * costs a pixel instead of a gap.
 */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-1.5 border-t border-line py-1.5 first:border-t-0 first:pt-0 last:pb-0">
      <span className="w-[68px] shrink-0 pt-[1px] text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
        {label}
      </span>
      {children}
    </div>
  );
}
