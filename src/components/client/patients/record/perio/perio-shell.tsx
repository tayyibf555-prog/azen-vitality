import { SEXTANTS, SEXTANT_LABEL, chartingRequirement } from "@/lib/perio/bpe";
import { describeCoverage } from "@/lib/perio/pocket-chart";
import type { PlaqueBleedingView, PocketChartView } from "@/lib/perio/pocket-chart";
import { buildGumProfiles } from "@/lib/perio/gum-profile";
import type { ClinicianRef, PerioNotice, SextantId } from "@/lib/perio/types";
import { PerioGateNotice, type PerioGateCopy } from "./perio-gate-notice";
import { BpeGrid, bpeCodesPresent, type BpeExamView } from "./bpe-grid";
import { BpeLegend } from "./bpe-legend";
import { GumLine } from "./gum-line";
import { PerioSummary } from "./perio-summary";
import { PerioComparison } from "./perio-compare";
import { PerioTabs } from "./perio-tabs";
import { PlaqueBleedingPanel } from "./plaque-bleeding";
import { PocketChartEntry, PocketChartReadOnly } from "./pocket-chart";

// ===========================================================================
// THE PERIO TAB, ASSEMBLED.
//
// Universal and server-safe: no "use client", no state, no function props, no
// clock. tab-perio.tsx renders this directly from the server. The one client
// island is PocketChartEntry, which owns its own boundary and takes nothing but
// plain data — that is what lets a server parent render it without the
// build-green-throw-at-render failure this repo has already shipped once.
//
// THE ORDER IS CLINICAL, NOT DECORATIVE.
//
//   1. The gate. Which world the reader is in, before a single number.
//   2. BPE. The screening layer and the thing a clinician touches daily. It is
//      also what DECIDES whether a six-point chart is owed, so it cannot sit
//      below the chart it demands — and it sits ABOVE the tab strip, outside
//      both examinations, because it governs both of them.
//   3. The six-point chart tab: the standing chart's figures, then the GUM LINE
//      drawn from them, then the numbers, then the entry grid, then the
//      comparison. PERIO.md §4: "a single chart is nearly useless; the value is
//      this visit against the last."
//   4. The plaque and bleeding tab.
//
// TWO TABS, BECAUSE DENTALLY HAS TWO. The pocket chart and "Plaque & Bleeding"
// are separate examinations in Dentally and separate examinations clinically:
// one is taken with a probe, the other with a disclosing agent, and neither is
// derived from the other. Stacking them would read as one long examination. The
// strip is PerioTabs, a client island holding one piece of state and rendering
// two server-built slots.
//
// THE GUM LINE SITS WITH THE NUMBERS IT COMES FROM, not on a tab of its own.
// Dentally's own claim for their perio chart is that it "gives you a good
// visualization of the patient's mouth allowing you to see at a glance how oral
// health has improved or changed over treatment time" — at a glance is the whole
// claim, and a picture one click away from its numbers is not at a glance. It is
// drawn FROM the chart by buildGumProfiles() and cannot be drawn ON; the reading
// is still the record.
//
// STACKED RATHER THAN SIDE BY SIDE, deliberately. The summary is a seven-column
// table and the comparison is a per-tooth site grid; putting them in two columns
// halves both and moves the scroll INSIDE each panel, where a clinician cannot
// see that there is more. A page that scrolls once beats two panels that each
// scroll invisibly.
//
// NOTHING DERIVABLE IS A PROP. The charting requirement, which sextants an entry
// grid should open on and why, and the trigger recorded against a new chart all
// come out of chartingRequirement() — the engine's own tested function, reading
// the same scores the grid above prints. A shell that took `sextants` as a prop
// could open a chart on a sextant the screening never asked for.
//
// EVERY SENTENCE OF CLINICAL-SAFETY COPY ARRIVES AS A PROP, from PERIO_COPY in
// src/lib/perio/gate.ts. That module is `import "server-only"` by design (the
// flag must never reach a browser), so this file holds none of its words.
// ===========================================================================

export interface PerioShellCopy extends PerioGateCopy {
  /** PERIO_COPY.disabled. Rendered by BpeGrid, above the scores. */
  disabled: string;
  /** PERIO_COPY.doubleEntry — the FP17 consequence. Also BpeGrid's, for the same
   *  reason: it belongs beside the score it is about. */
  doubleEntry: string;
  /** PERIO_COPY.readFailed. A failure to read, never "there are none". */
  readFailed: string;
  /** PERIO_COPY.noAuthor. Why entry is refused with no named clinician. */
  noAuthor: string;
  /** PERIO_COPY.bpeEntryReadOnly. Why the BPE entry panel has nothing on it to
   *  type into while the gate is shut. */
  bpeEntryReadOnly: string;
  /** PERIO_COPY.saveFailed. Never phrased as if it might have half-succeeded. */
  saveFailed: string;
}

export interface PerioShellProps {
  clientSlug: string;
  siteId: string;
  patientId: string;
  /** isPerioEnabled(). With it false the tab renders read-only and says why. */
  enabled: boolean;
  /** canSavePerio(). Separate from `enabled` because gate.ts keeps them separate,
   *  so a future read-only preview mode has somewhere to diverge. */
  canSave: boolean;
  copy: PerioShellCopy;
  /** The standing BPE, or null when none has been recorded HERE — which is not a
   *  finding about the patient, and the grid says so in those words. */
  bpeExam: BpeExamView | null;
  /** The stored exam's id, so a chart recorded now names the screening that
   *  demanded it. Not on BpeExamView: that shape is the intersection of a stored
   *  row and a freshly scored one, and only one of those has an id. */
  bpeExamId: string | null;
  /** The BPE read threw. Distinct from "no BPE recorded" in every way that
   *  matters, and never flattened into it. */
  bpeFailed: boolean;
  /** The most recent finalised, unretracted six-point chart. */
  latestChart: PocketChartView | null;
  /** The one before it, for the comparison. Null when there is only one. */
  previousChart: PocketChartView | null;
  chartsFailed: boolean;
  /**
   * The standing plaque and bleeding examination — Dentally's second perio tab.
   *
   * Null means none has been recorded HERE, which is not a finding about this
   * patient's oral hygiene, and the panel says so in those words. It is a prop
   * rather than something derived from `latestChart` on purpose: a plaque
   * control record is a different examination taken on different surfaces, and
   * manufacturing one from the pocket chart would print a percentage nobody
   * measured.
   */
  plaqueBleeding?: PlaqueBleedingView | null;
  /** The plaque and bleeding read threw. Distinct from "none recorded". */
  plaqueBleedingFailed?: boolean;
  /** Charts that were read but could not be built into a view. Stated, never
   *  silently dropped: a chart missing from this screen with no explanation is
   *  the "false completeness" failure CHARTING.md §6.3 is written about. */
  chartIssues: readonly string[];
  /** The engine's notices for this exam — implant and monitoring refusals, the
   *  furcation advisory. Rendered verbatim by the grid. */
  notices: readonly PerioNotice[];
  /** GDC 4.1.4. Null when the server cannot name a signed-in clinician; entry is
   *  then refused rather than attributed to nobody. */
  clinician: ClinicianRef | null;
  /** An ISO instant from the server. Nothing here reads a clock. */
  openedAt: string;
  /**
   * FDI numbers of the teeth in the mouth.
   *
   * NOTHING FEEDS THIS TODAY, AND THAT IS NOT AN OVERSIGHT. tab-perio.tsx does
   * not pass it because there is nowhere to get it: Dentally's API does not
   * expose tooth status, which the FDI chart says on its own face — "we cannot
   * read tooth status; this chart draws the treatment items Dentally returns,
   * not the dentition itself". So this is a prop kept open for the day the data
   * exists, not a wire somebody forgot to connect.
   *
   * WHILE IT IS UNDEFINED THE SCREEN SAYS SO, in DentitionUnknown below, rather
   * than letting an extracted tooth read as an unexamined one. A dangling prop
   * that quietly defaults is how "we do not know" becomes "we checked" six
   * months later.
   */
  presentTeeth?: readonly number[];
}

export function PerioShell({
  clientSlug,
  siteId,
  patientId,
  enabled,
  canSave,
  copy,
  bpeExam,
  bpeExamId,
  bpeFailed,
  latestChart,
  previousChart,
  chartsFailed,
  plaqueBleeding = null,
  plaqueBleedingFailed = false,
  chartIssues,
  notices,
  clinician,
  openedAt,
  presentTeeth,
}: PerioShellProps) {
  // DERIVED FROM THE SAME SCORES THE GRID PRINTS. One call, and the sextants the
  // entry grid opens on cannot disagree with the requirement stated above them.
  const requirement = chartingRequirement(bpeExam?.scores ?? {});
  const demanded = requirement.sextants;
  // No screening demand does not mean no chart: PERIO.md §3.2 also charts anyone
  // in periodontal maintenance annually, and that chart is full-mouth.
  const entrySextants: readonly SextantId[] = demanded.length > 0 ? demanded : SEXTANTS;
  // WHETHER THIS PLATFORM KNOWS THE DENTITION AT ALL. An empty array is as
  // unknown as an absent one: a chart drawn over "no teeth are present" is not a
  // statement anybody made either.
  const dentitionKnown = Array.isArray(presentTeeth) && presentTeeth.length > 0;
  const entryTrigger =
    requirement.highest?.code === 4
      ? ("bpe-4" as const)
      : requirement.highest?.code === 3
        ? ("bpe-3" as const)
        : ("maintenance-annual" as const);

  return (
    <div className="space-y-4">
      <PerioGateNotice enabled={enabled} copy={copy} />

      {/* THE READS THAT FAILED, before anything they would have filled. A failed
          read is never allowed to render as an empty result: on this tab an empty
          result reads as "this patient has no periodontal findings", which is
          indistinguishable from a healthy BPE 0. */}
      {bpeFailed || chartsFailed ? (
        <p className="rounded-xl border border-tint-red-line bg-tint-red px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-status-red">
          {copy.readFailed}
          {bpeFailed && chartsFailed
            ? " Both the BPE history and the six-point charts are affected."
            : bpeFailed
              ? " This affects the BPE below."
              : " This affects the six-point charts below."}
        </p>
      ) : null}

      {chartIssues.length > 0 ? (
        <ul className="space-y-1.5">
          {chartIssues.map((issue) => (
            <li
              key={issue}
              className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink"
            >
              {issue}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 1. THE SCREENING LAYER. The grid carries its own gate banner, its own FP17
             banner and the engine's notices; the legend beneath it carries the two
             standing limits of the instrument — never for monitoring, never around
             implants — which hold whatever this particular patient's scores are. */}
      <BpeGrid
        exam={bpeExam}
        enabled={enabled}
        copy={{ disabled: copy.disabled, doubleEntry: copy.doubleEntry }}
        notices={notices}
        // THE SCREENING LAYER IS ALSO THE DAILY ACTION, so the grid hosts the
        // entry panel rather than the tab putting a second BPE block somewhere
        // else on the page. Plain data only: BpeEntry is the tab's second client
        // island and nothing crossing this line may be a function.
        entry={{
          client: clientSlug,
          siteId,
          patientId,
          canSave,
          clinician,
          presentTeeth,
          copy: {
            noAuthor: copy.noAuthor,
            readOnly: copy.bpeEntryReadOnly,
            saveFailed: copy.saveFailed,
          },
        }}
      />
      <BpeLegend
        probe={bpeExam?.probe}
        probeNote={bpeExam?.probeNote}
        codesPresent={bpeCodesPresent(bpeExam)}
      />

      {/* 2 AND 3. THE TWO EXAMINATIONS, ON THEIR OWN TABS, as Dentally has them.
             Both panels are built HERE, on the server, and handed to the island as
             slots; the island holds nothing but which one is showing. */}
      <PerioTabs
        chartPanel={
          <div className="space-y-4">
      {/* 2. THE SIX-POINT CHART. */}
      <section className="space-y-3" aria-label="Six-point periodontal charting">
        {/* WHAT THIS SCREEN DOES NOT KNOW, BEFORE ANY ARCH IS DRAWN. Every
            picture below — the gum line, the read-only grid, the entry grid —
            draws a full dentition, and none of them can tell an extracted tooth
            from an unexamined one. Said once, at the top, rather than left as a
            prop nobody passes. */}
        {enabled && !dentitionKnown ? <DentitionUnknown /> : null}

        {latestChart ? (
          <>
            <PerioSummary chart={latestChart} title="Standing six-point chart" />
            {/* THE PICTURE, BETWEEN THE FIGURES AND THE NUMBERS THEY CAME FROM.
                Recession puts the gingival margin somewhere, the pocket base sits
                at the attachment level, and the band between them is the pocket —
                so 0mm recession with a 3mm pocket and 3mm recession with a 0mm
                pocket stop looking identical, which as two numbers in a table they
                very nearly do.

                DERIVED, NEVER AN INPUT. buildGumProfiles reads the built chart;
                gum-line.tsx has no pointer handler and exports no inverse mapping.
                To change a reading you change the reading.

                THE SCOPE SENTENCE IS PASSED, not optional: a partial chart drawn
                without it reads as a whole mouth, which is the one failure this
                drawing is most able to cause. */}
            <GumLine
              profiles={buildGumProfiles(latestChart.teeth, { presentTeeth })}
              scopeNote={describeCoverage(latestChart)}
              heading="Gum line and pocket depth"
            />
            <PocketChartReadOnly
              chart={latestChart}
              presentTeeth={presentTeeth}
              title="Standing six-point chart"
            />
          </>
        ) : (
          <NoChartYet
            enabled={enabled}
            failed={chartsFailed}
            demanded={demanded}
            reason={requirement.reason}
          />
        )}

        {/* THE ENTRY GRID EXISTS ONLY WHEN A RECORD MAY BE AUTHORED. With the gate
            shut it is not rendered read-only, disabled or greyed: it is not on the
            page at all, so there is no input, no button and no field to type into.
            "Read-only" enforced by an attribute is a claim; a screen with nothing
            to type into is a fact. */}
        {/* GDC 4.1.4, IN THE GATE'S OWN WORDS. The entry grid states that nothing
            can be recorded without a signed-in clinician, but it states it in its
            own sentence; PERIO_COPY.noAuthor is the tested one, and it is the one
            the API refuses with. Printed here so the screen and the 503 a save
            would receive say the same thing. */}
        {canSave && !clinician ? (
          <p className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink">
            {copy.noAuthor}
          </p>
        ) : null}

        {canSave ? (
          <PocketChartEntry
            client={clientSlug}
            siteId={siteId}
            patientId={patientId}
            sextants={entrySextants}
            presentTeeth={presentTeeth}
            clinician={clinician}
            openedAt={openedAt}
            canSave={canSave}
            readOnlyNotice={clinician ? null : copy.noAuthor}
            trigger={entryTrigger}
            bpeExamId={bpeExamId}
            probe={bpeExam?.probe}
          />
        ) : null}
      </section>

      {/* THE COMPARISON — the clinical point of charting at all, and it belongs
          on the chart tab because it compares charts. */}
      {latestChart && previousChart ? (
        <PerioComparison
          before={previousChart}
          after={latestChart}
          presentTeethAfter={presentTeeth}
        />
      ) : (
        <NoComparisonYet enabled={enabled} charts={latestChart ? 1 : 0} />
      )}
          </div>
        }
        plaqueBleedingPanel={
          <PlaqueBleedingPanel
            record={plaqueBleeding}
            enabled={enabled}
            failed={plaqueBleedingFailed}
            readFailedCopy={copy.readFailed}
            // STATED, NOT DISCOVERED. The engine scores this examination and this
            // panel renders it, but no table holds one yet and no route writes
            // one — so a clinician who assumed otherwise would take a plaque
            // control record that goes nowhere. The sentence lives here rather
            // than in gate.ts because it is not a statement about the gate: it
            // stays true with the feature switched fully on.
            authoringNotice={
              enabled
                ? "Plaque and bleeding examinations can be displayed here but cannot yet be recorded here. Record this examination in Dentally; it will not appear on this panel."
                : null
            }
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The empty states. Four of them, and not one is a blank panel: every branch
// says which kind of nothing this is and what to do about it.
// ---------------------------------------------------------------------------

/**
 * THE DENTITION IS NOT KNOWN HERE, and the screen says so rather than implying
 * otherwise by drawing two complete arches.
 *
 * This is NOT a gap waiting to be plumbed. Dentally's API exposes no tooth
 * status at all — the FDI chart in this same record says it on its own face,
 * "we cannot read tooth status; this chart draws the treatment items Dentally
 * returns, not the dentition itself" — so there is no set of present teeth to
 * pass into `presentTeeth`, and inventing one from treatment items would be a
 * fabricated mouth on a clinical screen.
 *
 * WHY IT MATTERS ON THIS TAB PARTICULARLY. A tooth with no readings renders as
 * "not charted". If the tooth is actually gone, "not charted" is the safer of
 * the two wrong answers but it is still wrong, and it is wrong in the direction
 * of an outstanding examination that will never be done. The comparison has the
 * same shape one level up: without a present-teeth set, diffPocketCharts cannot
 * tell an extraction from an omission, and it says so in its own caveat.
 */
function DentitionUnknown() {
  return (
    <p
      className="rounded-xl border border-line bg-card-muted/40 px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink"
      aria-label="Which teeth are present is not known here"
    >
      <strong className="font-semibold">
        This platform does not know which teeth this patient has.
      </strong>{" "}
      Dentally does not publish tooth status, so nothing here can tell an extracted tooth from one
      that was simply not examined: both arches below are drawn in full whatever is actually in the
      mouth, and a tooth showing no readings may be absent rather than unrecorded. Dentally is the
      record for the dentition — check it before reading a blank column as an outstanding
      examination.
    </p>
  );
}

function NoChartYet({
  enabled,
  failed,
  demanded,
  reason,
}: {
  enabled: boolean;
  failed: boolean;
  demanded: readonly SextantId[];
  reason: string;
}) {
  return (
    <section
      className="space-y-2 rounded-xl border border-line bg-card-muted/40 px-5 py-4"
      aria-label="No six-point chart"
    >
      <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">
        No six-point chart in this platform
      </h3>
      <p className="text-[13.5px] font-medium leading-[1.5] text-ink">
        {failed
          ? "The six-point charts could not be read, so this is not a statement that none exist. Check Dentally, and try again."
          : enabled
            ? "No six-point periodontal chart has been recorded here for this patient. That is not a finding about their periodontal health — it means no chart has been taken in this platform."
            : "Periodontal charting is switched off here, so no chart can be read or recorded. This patient's periodontal chart, if they have one, is in Dentally."}
      </p>

      {/* THE PROTOCOL CONSEQUENCE, VERBATIM FROM THE ENGINE. Whether a chart is
          owed, and why, is chartingRequirement's answer, not this component's:
          "code 4 in the lower left" is actionable and a prompt to "consider
          charting" is not. */}
      {demanded.length > 0 ? (
        <p className="rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-2 text-[12.5px] leading-[1.5] text-ink">
          {reason}
          {enabled
            ? ` Start with the ${listLabels(demanded)}.`
            : " That chart has to be recorded in Dentally while this feature is switched off."}
        </p>
      ) : (
        <p className="text-[12.5px] leading-[1.5] text-muted">
          {enabled
            ? "A six-point chart is taken when a BPE scores 3 or 4, and annually for anyone in periodontal maintenance."
            : "A six-point chart is taken when a BPE scores 3 or 4, and annually for anyone in periodontal maintenance. Record it in Dentally."}
        </p>
      )}
    </section>
  );
}

function NoComparisonYet({ enabled, charts }: { enabled: boolean; charts: number }) {
  return (
    <section
      className="space-y-2 rounded-xl border border-line bg-card-muted/40 px-5 py-4"
      aria-label="No comparison"
    >
      <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">
        Nothing to compare yet
      </h3>
      <p className="text-[13.5px] leading-[1.5] text-ink">
        {charts === 1
          ? "A comparison needs two charts. There is one here, so the change over time cannot be shown — and change over time is what a periodontal chart is for."
          : enabled
            ? "A comparison needs two six-point charts recorded here. There are none yet."
            : "A comparison needs two six-point charts recorded here, and periodontal charting is switched off. Compare in Dentally."}
      </p>
      <p className="text-[12.5px] leading-[1.5] text-muted">
        A BPE cannot stand in for this. It is a screening instrument and cannot measure treatment
        response; only a repeat six-point chart can.
      </p>
    </section>
  );
}

/** Sextant names in a sentence, from the engine's own labels rather than a second
 *  table of them. */
function listLabels(sextants: readonly SextantId[]): string {
  const names = sextants.map((s) => `${SEXTANT_LABEL[s]} sextant`);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
