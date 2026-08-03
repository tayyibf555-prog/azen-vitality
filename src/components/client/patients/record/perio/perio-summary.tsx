import { SEXTANTS, SEXTANT_LABEL } from "@/lib/perio/bpe";
import {
  SITE_LABEL,
  computeStats,
  describeCoverage,
  summarisePocketChart,
} from "@/lib/perio/pocket-chart";
import type { PerioStats, PocketChartView, SiteRef } from "@/lib/perio/pocket-chart";
import type { SextantId } from "@/lib/perio/types";
import { londonDateTimeLabel } from "@/lib/time/london";

// ===========================================================================
// THE SIX-POINT CHART SUMMARY — the numbers, and the sentence that says what
// they are numbers OF.
//
// EVERY FIGURE ON THIS SCREEN IS THE ENGINE'S. Nothing here counts a bleeding
// site, averages a percentage or decides what "deepest" means. It calls
// summarisePocketChart() and prints what comes back, because a second
// implementation of "BOP %" that lives in a component is a second answer, and
// the one on screen is the one a clinician acts on. The only arithmetic in this
// file is turning a number into a string.
//
// THE SCOPE SENTENCE IS NOT DECORATION AND IT IS NOT OPTIONAL. A BPE code 3
// requires ONE sextant to be six-point charted, so a partial chart is the normal
// case rather than an error. "18% bleeding" computed over the lower right and
// printed on its own reads as a whole-mouth result — that is the "false
// completeness" failure CHARTING.md §6.3 says is the specific way this screen
// kills someone. So describeCoverage()'s sentence sits ABOVE the numbers, in the
// same visual weight as them, and a partial chart is additionally banded so it
// cannot be mistaken for a full one at a glance.
//
// A SEXTANT THAT HOLDS NO READINGS IS NEVER A ROW OF ZEROES. summarisePocketChart
// returns null for it, and null renders as "not charted" in its own quiet type.
// A row of zeroes is a clinical claim — no bleeding, no plaque, no pocket over
// 3mm — and printing that about a sextant nobody probed is writing a missed
// examination down as a clean result.
//
// A NULL PERCENTAGE IS NOT 0%. computeStats returns null for a percentage over
// zero recorded sites, and this file prints an em dash for it, never "0%".
//
// ATTRIBUTION IS PART OF THE SUMMARY, not a footnote. GDC Standard 4.1.4 puts
// the treating clinician's name on the record; 4.1.5 requires an amendment to be
// marked and dated, so a chart carrying supersedesId says so at the top rather
// than looking like an original observation.
//
// NO "use client", NO FUNCTION PROPS, NO CLOCK. Every prop is plain data, so
// this renders from a server shell or from inside a client one, and the only
// time it prints is the ISO instant already on the record.
// ===========================================================================

/** mm figures print with the unit; a bare number on a clinical screen is a unit
 *  the reader has to supply from memory. */
function mm(value: number | null): string {
  return value === null ? "—" : `${value}mm`;
}

/** A null percentage means NOTHING WAS RECORDED, which is not 0%. */
function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function siteRef(ref: SiteRef | null): string {
  return ref === null ? "" : `tooth ${ref.tooth}, ${SITE_LABEL[ref.site]}`;
}

function teethList(teeth: readonly number[]): string {
  return teeth.length === 0 ? "none" : teeth.join(", ");
}

// ---------------------------------------------------------------------------
// The headline tiles
// ---------------------------------------------------------------------------

/**
 * One figure. The caption is what it is a figure OF, and it is never dropped for
 * space: "18%" with no caption is the same failure as a percentage with no scope.
 */
function Tile({
  label,
  value,
  detail,
  tone = "plain",
}: {
  label: string;
  value: string;
  detail?: string | null;
  /** "alert" only where the engine's own threshold is crossed — never on a hunch. */
  tone?: "plain" | "alert";
}) {
  return (
    <div
      className={
        tone === "alert"
          ? "rounded-lg border border-tint-red-line bg-tint-red px-3 py-2"
          : "rounded-lg border border-line bg-card px-3 py-2"
      }
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div
        className={
          tone === "alert"
            ? "mt-0.5 text-[19px] font-semibold leading-none text-status-red"
            : "mt-0.5 text-[19px] font-semibold leading-none text-navy"
        }
      >
        {value}
      </div>
      {detail ? <div className="mt-1 text-[11px] leading-tight text-muted">{detail}</div> : null}
    </div>
  );
}

function StatTiles({ stats }: { stats: PerioStats }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Bleeding"
        value={pct(stats.bopPercent)}
        detail={`${stats.bleedingSites} of ${stats.sitesRecorded} sites`}
      />
      <Tile
        label="Plaque"
        value={pct(stats.plaquePercent)}
        detail={`${stats.plaqueSites} of ${stats.sitesRecorded} sites`}
      />
      <Tile
        label="Sites ≥4mm"
        value={String(stats.sites4mmPlus)}
        detail={pct(stats.percent4mmPlus) === "—" ? "no sites recorded" : `${pct(stats.percent4mmPlus)} of recorded sites`}
      />
      <Tile
        label="Sites ≥6mm"
        value={String(stats.sites6mmPlus)}
        detail="pockets a hygienist cannot reach the base of"
        tone={stats.sites6mmPlus > 0 ? "alert" : "plain"}
      />
      <Tile
        label="Deepest pocket"
        value={mm(stats.deepestPocket)}
        detail={siteRef(stats.deepestPocketAt) || "nothing probed"}
        tone={stats.deepestPocket !== null && stats.deepestPocket >= 6 ? "alert" : "plain"}
      />
      <Tile
        label="Worst attachment loss"
        value={mm(stats.worstCal)}
        detail={
          stats.worstCal === null
            ? "needs a depth and a recession at the same site"
            : siteRef(stats.worstCalAt)
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per sextant
// ---------------------------------------------------------------------------

function SextantRow({ sextant, stats }: { sextant: SextantId; stats: PerioStats | null }) {
  if (stats === null) {
    // NEVER A ROW OF ZEROES. See the header note: "not charted" is the absence of
    // a claim, and a zero is a claim.
    return (
      <tr className="border-t border-line">
        <th scope="row" className="py-1.5 pr-3 text-left font-medium text-muted">
          {SEXTANT_LABEL[sextant]}
        </th>
        <td colSpan={6} className="py-1.5 text-left text-faint italic">
          not charted — unexamined, which is not the same as healthy
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1.5 pr-3 text-left font-medium text-navy">
        {SEXTANT_LABEL[sextant]}
      </th>
      <td className="py-1.5 text-right tabular-nums text-ink">{stats.teethCharted}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">{stats.sitesRecorded}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">{pct(stats.bopPercent)}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">{pct(stats.plaquePercent)}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">
        {stats.sites4mmPlus}
        <span className="text-faint"> / </span>
        <span className={stats.sites6mmPlus > 0 ? "font-semibold text-status-red" : ""}>
          {stats.sites6mmPlus}
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums text-ink">{mm(stats.deepestPocket)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export function PerioSummary({
  chart,
  /**
   * PERIO_COPY.doubleEntry, when the caller wants it here.
   *
   * It is optional and NOT defaulted to a literal, because the sentence lives in
   * src/lib/perio/gate.ts, that module is `import "server-only"`, and a copy of
   * the words hard-coded here is a second version of a statement that must not
   * be able to drift. The shell normally renders it once above the whole tab; a
   * caller showing this summary on its own passes it in.
   */
  fp17Notice,
  /** Heading text. The comparison view reuses this component for each side. */
  title,
  /** Suppress the tiles' surrounding card, when a parent already draws one. */
  bare = false,
}: {
  chart: PocketChartView;
  fp17Notice?: string | null;
  title?: string;
  bare?: boolean;
}) {
  // THE ENGINE COMPUTES, THIS FILE PRINTS. Pure, deterministic, no clock, so it
  // is safe to run in a render path and safe to run again on every keystroke of
  // the entry grid, which is exactly what that screen does with it.
  const summary = summarisePocketChart(chart);
  const partial = summary.coverage === "partial";

  return (
    <section
      className={bare ? "space-y-3" : "space-y-3 rounded-xl border border-line bg-card p-4 shadow-sm"}
      aria-label={title ?? "Six-point chart summary"}
    >
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-navy">
            {title ?? "Six-point chart"}
          </h3>
          <p className="text-[11px] leading-tight text-faint">
            {/* GDC 4.1.4: the treating clinician, named, on the record. */}
            {chart.recorded.clinician.name}
            {chart.recorded.clinician.gdcNumber ? ` · GDC ${chart.recorded.clinician.gdcNumber}` : ""}
            {" · "}
            {londonDateTimeLabel(chart.recorded.at)}
            {" · probe "}
            {chart.probe}
          </p>
        </div>

        {/* THE SCOPE SENTENCE. Above the numbers, never below them, never behind
            a toggle. A partial chart is banded so the shape of the block says
            "partial" before a word of it is read. */}
        <p
          className={
            partial
              ? "rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-1.5 text-[12px] leading-snug text-status-amber"
              : "rounded-md border border-tint-green-line bg-tint-green px-2.5 py-1.5 text-[12px] leading-snug text-status-green"
          }
        >
          {describeCoverage(chart)}
        </p>

        {chart.supersedesId ? (
          <p className="rounded-md border border-tint-royal-line bg-tint-royal px-2.5 py-1.5 text-[12px] leading-snug text-status-royal">
            {/* GDC 4.1.5: an amendment is marked and dated, and the chart it
                replaced is still on the record rather than overwritten. */}
            This chart amends an earlier one, which is still on the record.
            {chart.amendmentReason ? ` Reason given: ${chart.amendmentReason}` : ""}
          </p>
        ) : null}
      </header>

      <StatTiles stats={summary.whole} />

      {/* PER SEXTANT. Same figures, same engine, one scope down — which is the
          scope a clinician treats in. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] border-collapse text-[12px]">
          <caption className="pb-1 text-left text-[11px] text-faint">
            By sextant. Percentages are of the sites recorded in that sextant and of nothing else.
          </caption>
          <thead>
            <tr className="text-[10.5px] uppercase tracking-[0.05em] text-faint">
              <th scope="col" className="pb-1 pr-3 text-left font-semibold">
                Sextant
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                Teeth
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                Sites
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                BOP
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                Plaque
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                ≥4 / ≥6mm
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                Deepest
              </th>
            </tr>
          </thead>
          <tbody>
            {SEXTANTS.map((sextant) => (
              <SextantRow key={sextant} sextant={sextant} stats={summary.bySextant[sextant]} />
            ))}
          </tbody>
        </table>
      </div>

      {/* TEETH OUTSIDE THE SEXTANT SCHEME. Third molars are in the whole-chart
          figures and in no sextant's, which is why the two sets of numbers above
          can legitimately fail to add up. Printed rather than reconciled. */}
      {chart.teethOutsideSextantScheme.length > 0 ? (
        <PerioOutsideSextantNote teeth={chart.teethOutsideSextantScheme} />
      ) : null}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
        {/* DENTALLY'S SCALES, IN DENTALLY'S WORDS. These labels read "Miller ≥I"
            and "Hamp" until this pass. Dentally records mobility in STAGES 1–3
            and furcation in GRADES 1–4 — their `m` and `f` keys cycle exactly
            those — and a screen that names a different scale than the one on the
            keyboard is a screen a hygienist has to translate. There is no stage
            0 and no grade 0: a tooth is listed here because a finding was
            recorded against it, and a tooth absent from the list is a tooth with
            no such finding, which is not the same as a tooth nobody tested. */}
        <div className="flex gap-2">
          <dt className="shrink-0 text-faint">Mobility (stages 1–3)</dt>
          <dd className="text-ink">{teethList(summary.whole.teethWithMobility)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-faint">Furcation (grades 1–4)</dt>
          <dd className="text-ink">{teethList(summary.whole.teethWithFurcation)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-faint">Suppuration</dt>
          <dd className="text-ink">
            {summary.whole.suppurationSites === 0
              ? "none recorded"
              : `${summary.whole.suppurationSites} site${summary.whole.suppurationSites === 1 ? "" : "s"}`}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-faint">Teeth charted</dt>
          <dd className="text-ink">
            {summary.whole.teethCharted} · {summary.whole.sitesRecorded} sites
          </dd>
        </div>
      </dl>

      {/* THE ENGINE'S OWN CAVEATS, as whole sentences, verbatim. They are written
          in pocket-chart.ts precisely so a component cannot paraphrase them into
          something weaker. */}
      {summary.caveats.length > 0 ? (
        <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] leading-snug text-muted">
          {summary.caveats.map((caveat) => (
            <li key={caveat} className="flex gap-2">
              <span aria-hidden className="text-faint">
                ·
              </span>
              <span>{caveat}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {fp17Notice ? (
        <p className="border-t border-line pt-2 text-[11.5px] leading-snug text-status-amber">
          {fp17Notice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Split out only so the entry screen can print the same sentence while a chart
 * is still being typed and has no built view yet.
 */
export function PerioOutsideSextantNote({ teeth }: { teeth: readonly number[] }) {
  return (
    <p className="rounded-md border border-line bg-card-muted px-2.5 py-1.5 text-[11.5px] leading-snug text-muted">
      {teeth.length === 1 ? "Tooth" : "Teeth"} {teeth.join(", ")}{" "}
      {teeth.length === 1 ? "sits" : "sit"} outside the six-sextant scheme, so{" "}
      {teeth.length === 1 ? "its readings are" : "their readings are"} in the whole-chart figures
      and in no sextant&rsquo;s.
    </p>
  );
}

/**
 * The same tiles over an arbitrary set of teeth.
 *
 * The comparison view needs statistics over the RESTRICTED set — the teeth and
 * sites present in both charts — and it gets them from computeStats, the same
 * function summarisePocketChart uses. Exported here rather than duplicated there
 * so both sides of a comparison are formatted by one piece of code; two
 * formatters is how a "4mm" becomes a "4" on one side of a diff.
 */
export function PerioStatTiles({ stats, scope }: { stats: PerioStats; scope: string }) {
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] leading-snug text-muted">{scope}</p>
      <StatTiles stats={stats} />
    </div>
  );
}

/** Re-exported so a caller can build restricted statistics without importing the
 *  engine twice over. Same function, no wrapper, no second implementation. */
export { computeStats };
