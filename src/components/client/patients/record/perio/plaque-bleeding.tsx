import { PERIO_SURFACES, describePlaqueBleedingScope } from "@/lib/perio/pocket-chart";
import type {
  ChartedSurface,
  ChartedToothSurfaces,
  PlaqueBleedingScores,
  PlaqueBleedingView,
  SurfaceState,
} from "@/lib/perio/pocket-chart";
import { SEXTANT_LABEL } from "@/lib/perio/bpe";
import { londonDateTimeLabel } from "@/lib/time/london";

// ===========================================================================
// PLAQUE AND BLEEDING BY SURFACE — Dentally's second perio tab, rendered.
//
// THIS IS NOT THE SIX-POINT CHART AND IT IS NOT DERIVED FROM IT. The pocket
// chart records bleeding and plaque per SITE, as a property of a probing.
// Dentally additionally has a "Plaque & Bleeding" tab where the clinician marks
// a tooth SURFACE, and "the percentages of available surfaces where bleeding,
// plaque or both is present are calculated automatically". They are two
// examinations: a plaque control record is taken with a disclosing agent, on
// surfaces that were never probed, often by a different person on a different
// day. Deriving one from the other would put a number on this screen that
// nobody measured, which is the one thing this module exists not to do.
//
// EVERY FIGURE HERE IS THE ENGINE'S. buildPlaqueBleedingChart() counts the
// surfaces, decides the denominator and writes the sentence naming it. Nothing
// in this file divides anything. A second implementation of "plaque %" living
// in a component is a second answer, and the one on screen is the one a
// hygienist shows the patient.
//
// THE DENOMINATOR IS PRINTED, NOT IMPLIED. `scores.denominator` is a whole
// sentence stating how many surfaces of how many teeth every percentage on this
// panel is a percentage OF, and it sits with the percentages rather than in a
// footnote. A plaque score of 12% over six teeth and a plaque score of 12% over
// a whole mouth are different clinical facts printed with the same characters.
//
// DENTALLY'S COLOURS, AND THE ONE HONEST SUBSTITUTION. Dentally paints a surface
// RED for bleeding, YELLOW for plaque and ORANGE for both. This palette declares
// no orange — and inventing `--tint-orange` here would be a colour utility that
// resolves to nothing, which this repo has shipped twice. So "both" is drawn as
// the bleeding fill inside an amber outline: the two findings it is made of,
// both visible. It is stated in the legend rather than left to be inferred.
//
// AND NOTHING IS TOLD BY COLOUR ALONE. Every cell carries its letters (P, B, PB)
// and an accessible name in words. A red/green deficit affects roughly one man
// in twelve, and a hygienist reading a plaque chart is exactly as likely to have
// one as anybody else.
//
// UNIVERSAL: no "use client", no state, no function props, no clock. The only
// time printed is the ISO instant already on the record.
// ===========================================================================

const SURFACE_LABEL: Record<(typeof PERIO_SURFACES)[number], string> = {
  mesial: "Mesial",
  buccal: "Buccal",
  distal: "Distal",
  lingual: "Lingual",
};

/** Letters, so the finding survives a greyscale print and a colour deficit. */
const STATE_MARK: Record<SurfaceState, string> = {
  clean: "·",
  plaque: "P",
  bleeding: "B",
  both: "PB",
};

/** Words, for the accessible name and the tooltip. Whole findings, not codes. */
const STATE_WORDS: Record<SurfaceState, string> = {
  clean: "examined, no plaque and no bleeding",
  plaque: "plaque",
  bleeding: "bleeding",
  both: "plaque and bleeding",
};

const STATE_CLASS: Record<SurfaceState, string> = {
  clean: "border-line bg-card text-faint",
  plaque: "border-tint-amber-line bg-tint-amber text-status-amber",
  bleeding: "border-tint-red-line bg-tint-red text-status-red",
  // Dentally's orange, expressed as its two ingredients: the bleeding fill,
  // ringed in the plaque colour. See the header note.
  both: "border-status-amber bg-tint-red text-status-red",
};

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

/** A null percentage means NOTHING WAS EXAMINED, which is not 0%. A 0% on an
 *  unexamined mouth is a claim of health nobody made. */
function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "plaque" | "bleeding" | "both";
}) {
  return (
    <div
      className={
        tone === "bleeding"
          ? "rounded-lg border border-tint-red-line bg-tint-red px-3 py-2"
          : tone === "plaque"
            ? "rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2"
            : "rounded-lg border border-status-amber bg-tint-red px-3 py-2"
      }
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div
        className={
          tone === "plaque"
            ? "mt-0.5 text-[19px] font-semibold leading-none text-status-amber"
            : "mt-0.5 text-[19px] font-semibold leading-none text-status-red"
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-tight text-muted">{detail}</div>
    </div>
  );
}

function ScoreTiles({ scores }: { scores: PlaqueBleedingScores }) {
  const of = `of ${scores.availableSurfaces} surfaces`;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Tile
        label="Plaque"
        value={pct(scores.plaquePercent)}
        detail={`${scores.plaqueSurfaces} ${of}`}
        tone="plaque"
      />
      <Tile
        label="Bleeding"
        value={pct(scores.bleedingPercent)}
        detail={`${scores.bleedingSurfaces} ${of}`}
        tone="bleeding"
      />
      <Tile
        label="Both"
        value={pct(scores.bothPercent)}
        detail={`${scores.bothSurfaces} ${of}`}
        tone="both"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The legend. Dentally's three colours, named, with the substitution stated.
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-muted">
      {(["clean", "plaque", "bleeding", "both"] as const).map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-flex h-5 w-6 items-center justify-center rounded border text-[10px] font-semibold ${STATE_CLASS[state]}`}
          >
            {STATE_MARK[state]}
          </span>
          <span>{STATE_WORDS[state]}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

function SurfaceCell({ tooth, surface }: { tooth: number; surface: ChartedSurface }) {
  // The whole finding in words, so a screen reader and a hover both get the
  // sentence rather than a letter that has to be decoded from the legend.
  const name = `Tooth ${tooth}, ${SURFACE_LABEL[surface.surface].toLowerCase()} surface: ${
    STATE_WORDS[surface.state]
  }`;
  return (
    <td className="py-0.5 pr-1">
      <span
        title={name}
        className={`inline-flex h-6 w-full min-w-[34px] items-center justify-center rounded border text-[10.5px] font-semibold tabular-nums ${
          STATE_CLASS[surface.state]
        }`}
      >
        <span className="sr-only">{name}</span>
        <span aria-hidden>{STATE_MARK[surface.state]}</span>
      </span>
    </td>
  );
}

function ToothRow({ tooth }: { tooth: ChartedToothSurfaces }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-0.5 pr-3 text-left font-medium tabular-nums text-navy">
        {tooth.tooth}
      </th>
      <td className="py-0.5 pr-3 text-left text-[11px] text-faint">
        {/* A tooth outside the six-sextant scheme is named as such rather than
            silently filed under nothing — the same rule the six-point summary
            follows for third molars. */}
        {tooth.sextant ? SEXTANT_LABEL[tooth.sextant] : "outside the sextant scheme"}
      </td>
      {tooth.surfaces.map((surface) => (
        <SurfaceCell key={surface.surface} tooth={tooth.tooth} surface={surface} />
      ))}
      <td className="py-0.5 pl-2 text-right text-[11px] tabular-nums text-muted">
        {pct(tooth.scores.plaquePercent)}
        <span className="text-faint"> / </span>
        {pct(tooth.scores.bleedingPercent)}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface PlaqueBleedingPanelProps {
  /** The standing examination, or null when none has been recorded HERE — which
   *  is not a finding about the patient, and the empty state says so. */
  record: PlaqueBleedingView | null;
  /** isPerioEnabled(). Changes what "there is none" means and where to look. */
  enabled: boolean;
  /** The read threw. Never flattened into "there are none": on this tab an empty
   *  result reads as a mouth with no plaque and no bleeding. */
  failed?: boolean;
  /** PERIO_COPY.readFailed, passed in because gate.ts is `import "server-only"`. */
  readFailedCopy?: string | null;
  /**
   * Why nothing can be recorded here yet, in the caller's words.
   *
   * Stated rather than left to be discovered: this platform can DISPLAY a plaque
   * and bleeding examination and cannot yet STORE one, and a clinician who
   * assumes otherwise records an examination that goes nowhere.
   */
  authoringNotice?: string | null;
}

export function PlaqueBleedingPanel({
  record,
  enabled,
  failed = false,
  readFailedCopy,
  authoringNotice,
}: PlaqueBleedingPanelProps) {
  return (
    <section
      className="space-y-3 rounded-xl border border-line bg-card p-4 shadow-sm"
      aria-label="Plaque and bleeding"
    >
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-navy">
            Plaque &amp; bleeding
          </h3>
          {record ? (
            <p className="text-[11px] leading-tight text-faint">
              {/* GDC 4.1.4: the treating clinician, named, on the record. */}
              {record.recorded.clinician.name}
              {record.recorded.clinician.gdcNumber
                ? ` · GDC ${record.recorded.clinician.gdcNumber}`
                : ""}
              {" · "}
              {londonDateTimeLabel(record.recorded.at)}
            </p>
          ) : null}
        </div>
        <p className="text-[11.5px] leading-snug text-muted">
          A separate examination from the six-point chart, and not derived from it. Plaque and
          bleeding are marked per tooth surface; the six-point chart records them per probed site.
        </p>
      </header>

      {failed ? (
        <p className="rounded-xl border border-tint-red-line bg-tint-red px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-status-red">
          {readFailedCopy ??
            "The plaque and bleeding examinations could not be read. This is a failure to read them, not a finding that there are none."}
        </p>
      ) : null}

      {record ? (
        <>
          {record.supersedesId ? (
            <p className="rounded-md border border-tint-royal-line bg-tint-royal px-2.5 py-1.5 text-[12px] leading-snug text-status-royal">
              {/* GDC 4.1.5. */}
              This examination amends an earlier one, which is still on the record.
              {record.amendmentReason ? ` Reason given: ${record.amendmentReason}` : ""}
            </p>
          ) : null}

          {/* THE SCOPE SENTENCE, ABOVE THE NUMBERS. "Teeth not examined are absent
              from these figures — they are not clean" is the engine's own wording
              and it is the difference between a plaque score and a claim about a
              mouth. */}
          <p className="rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-1.5 text-[12px] leading-snug text-ink">
            {describePlaqueBleedingScope(record)}
          </p>

          <ScoreTiles scores={record.scores} />

          {/* THE DENOMINATOR, WITH THE PERCENTAGES IT BELONGS TO. */}
          <p className="text-[11.5px] leading-snug text-muted">{record.scores.denominator}</p>

          <Legend />

          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-collapse text-[12px]">
              <caption className="pb-1 text-left text-[11px] text-faint">
                Every examined tooth has a row, including the ones found clean — a tooth examined
                and clean is a result, and leaving it out would shrink the total and raise every
                score.
              </caption>
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.05em] text-faint">
                  <th scope="col" className="pb-1 pr-3 text-left font-semibold">
                    Tooth
                  </th>
                  <th scope="col" className="pb-1 pr-3 text-left font-semibold">
                    Sextant
                  </th>
                  {PERIO_SURFACES.map((surface) => (
                    <th key={surface} scope="col" className="pb-1 pr-1 text-left font-semibold">
                      {SURFACE_LABEL[surface]}
                    </th>
                  ))}
                  <th scope="col" className="pb-1 pl-2 text-right font-semibold">
                    Plaque / bleeding
                  </th>
                </tr>
              </thead>
              <tbody>
                {record.teeth.map((tooth) => (
                  <ToothRow key={tooth.tooth} tooth={tooth} />
                ))}
              </tbody>
            </table>
          </div>

          {record.caveats.length > 0 ? (
            <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] leading-snug text-muted">
              {record.caveats.map((caveat) => (
                <li key={caveat} className="flex gap-2">
                  <span aria-hidden className="text-faint">
                    ·
                  </span>
                  <span>{caveat}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <NoExaminationYet enabled={enabled} failed={failed} />
      )}

      {authoringNotice ? (
        <p className="rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-1.5 text-[12px] leading-snug text-ink">
          {authoringNotice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The empty state, which on this tab is the dangerous one.
 *
 * A blank plaque panel reads as a mouth with no plaque, which is a clinical
 * claim. Each branch says which KIND of nothing this is, in words.
 */
function NoExaminationYet({ enabled, failed }: { enabled: boolean; failed: boolean }) {
  return (
    <div className="space-y-2 rounded-xl border border-line bg-card-muted/40 px-5 py-4">
      <h4 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">
        No plaque and bleeding examination in this platform
      </h4>
      <p className="text-[13.5px] font-medium leading-[1.5] text-ink">
        {failed
          ? "The plaque and bleeding examinations could not be read, so this is not a statement that none exist. Check Dentally, and try again."
          : enabled
            ? "No plaque and bleeding examination has been recorded here for this patient. That is not a finding about their oral hygiene — it means no such examination has been recorded in this platform."
            : "Periodontal charting is switched off here, so no plaque and bleeding examination can be read or recorded. This patient's, if they have one, is in Dentally."}
      </p>
      <p className="text-[12.5px] leading-[1.5] text-muted">
        A plaque and bleeding examination scores the mesial, buccal, distal and lingual surfaces of
        the teeth examined. The occlusal surface has no gingival margin, so it carries neither a
        plaque score nor bleeding on probing and is not counted.
      </p>
    </div>
  );
}
