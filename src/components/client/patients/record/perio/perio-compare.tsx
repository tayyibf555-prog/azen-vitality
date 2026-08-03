import type { ReactNode } from "react";
import { SEXTANT_LABEL } from "@/lib/perio/bpe";
import {
  PerioValidationError,
  SITE_IDS,
  SITE_LABEL,
  diffPocketCharts,
} from "@/lib/perio/pocket-chart";
import type {
  PerioStats,
  PocketChartDiff,
  PocketChartView,
  SiteDiff,
  ToothComparison,
  ToothDiff,
} from "@/lib/perio/pocket-chart";
import { londonDateTimeLabel } from "@/lib/time/london";

// ===========================================================================
// THIS VISIT AGAINST THE LAST — the clinical point of the whole module.
//
// A single six-point chart is nearly useless. 192 numbers describe a mouth on
// one afternoon; what a clinician acts on is whether the numbers moved, which
// way, and where. PERIO.md §4 says to build the diff from the start, and this is
// it.
//
// THE ONE THING THIS SCREEN MUST NEVER DO. The naive comparison — the pocket was
// 9mm, the tooth is not in the later chart, therefore 9mm of improvement — turns
// the worst possible outcome into the best-looking number on the page. A patient
// whose two hopeless molars came out looks, on that arithmetic, like a treatment
// success. diffPocketCharts() already refuses to do it: teeth that are not in
// BOTH charts contribute to no headline figure and come back named, in three
// separate buckets that mean three different things —
//
//   lost-since      the caller told us the tooth is no longer in the mouth
//   not-recharted   it was charted before, its sextant was charted again, and it
//                   simply is not there. An extraction and an omission are
//                   indistinguishable from here and neither is an improvement.
//   new-since       charted this time and not last time, so it has no baseline
//
// This file's job is to make sure those three are IMPOSSIBLE TO MISS. They are
// rendered above the movement grid, in their own band, before a reader reaches a
// single green arrow — not folded into a footnote under the good news.
//
// EVERY NUMBER IS THE ENGINE'S. The counts, the restricted before/after
// statistics, the per-site movement and every caveat sentence come from
// diffPocketCharts(). Nothing here decides what "improved" means: the threshold
// is the caller's, the arithmetic is pocket-chart.ts's, and this file draws it.
//
// MOVEMENT IS DEFINED ON PROBING DEPTH, and the screen says so out loud. CAL is
// shown alongside because attachment loss is what stages the disease, but a
// pocket that shrank because the gum receded is not the same event as a pocket
// that shrank because the attachment came back, and a reader has to be able to
// see both columns to tell them apart.
//
// A REFUSAL IS CONTENT, NOT A CRASH. diffPocketCharts throws when the two charts
// belong to different patients or when the later one is dated before the earlier
// one. Both are caught and printed, because an error boundary swallowing "these
// two charts belong to different patients" would leave a clinician staring at a
// blank panel with no idea why.
//
// NO "use client", NO FUNCTION PROPS, NO CLOCK.
// ===========================================================================

const MOVEMENT_TONE = {
  improved: "text-status-green",
  worse: "text-status-red",
  unchanged: "text-muted",
  "not-comparable": "text-faint",
} as const;

const MOVEMENT_FILL = {
  improved: "bg-tint-green border-tint-green-line",
  worse: "bg-tint-red border-tint-red-line",
  unchanged: "bg-card border-line",
  "not-comparable": "bg-card-muted border-line",
} as const;

/** Sign-carrying millimetres. "−2mm" and "+2mm" are different findings and the
 *  sign is the whole message, so it is never dropped for tidiness. */
function signedMm(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0mm";
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}mm`;
}

function signedPct(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}%`;
}

function signedCount(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}`;
}

/** For pockets and bleeding, DOWN IS GOOD. Stated once here rather than inverted
 *  by hand at six call sites, which is how one tile ends up green for the wrong
 *  direction. */
function toneForFall(delta: number | null): "improved" | "worse" | "unchanged" {
  if (delta === null || delta === 0) return "unchanged";
  return delta < 0 ? "improved" : "worse";
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function mm(value: number | null): string {
  return value === null ? "—" : `${value}mm`;
}

// ---------------------------------------------------------------------------
// Chart identity — which two charts these are
// ---------------------------------------------------------------------------

function ChartStamp({ label, chart }: { label: string; chart: PocketChartView }) {
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold leading-tight text-navy">
        {londonDateTimeLabel(chart.recorded.at)}
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted">
        {chart.recorded.clinician.name}
        {chart.recorded.clinician.gdcNumber ? ` · GDC ${chart.recorded.clinician.gdcNumber}` : ""}
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-faint">
        {chart.coverage === "full-mouth"
          ? "full-mouth"
          : `partial — ${chart.chartedSextants.map((s) => SEXTANT_LABEL[s]).join(", ") || "nothing charted"}`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

function MovementBar({
  improved,
  worse,
  unchanged,
}: {
  improved: number;
  worse: number;
  unchanged: number;
}) {
  const total = improved + worse + unchanged;
  if (total === 0) {
    return (
      <p className="text-[12px] text-faint">
        No site was recorded in both charts, so no movement can be shown.
      </p>
    );
  }
  // Inline widths, not Tailwind arbitrary values: Tailwind v4 scans raw source,
  // so an interpolated w-[..%] class would never be generated.
  const w = (n: number) => `${Math.round((n / total) * 1000) / 10}%`;
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-3 w-full overflow-hidden rounded-full border border-line"
        role="img"
        aria-label={`${improved} sites improved, ${worse} worse, ${unchanged} unchanged, of ${total} compared`}
      >
        <div className="bg-success" style={{ width: w(improved) }} />
        <div className="bg-card-muted" style={{ width: w(unchanged) }} />
        <div className="bg-danger" style={{ width: w(worse) }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
        <span className="text-status-green">{improved} improved</span>
        <span className="text-muted">{unchanged} unchanged</span>
        <span className="text-status-red">{worse} worse</span>
        <span className="text-faint">of {total} sites recorded in both charts</span>
      </div>
    </div>
  );
}

function DeltaTile({
  label,
  before,
  after,
  delta,
  tone,
}: {
  label: string;
  before: string;
  after: string;
  delta: string;
  tone: "improved" | "worse" | "unchanged";
}) {
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5 text-[15px] font-semibold leading-none text-navy">
        <span className="text-muted">{before}</span>
        <span aria-hidden className="text-faint">
          →
        </span>
        <span>{after}</span>
      </div>
      <div className={`mt-1 text-[11.5px] font-medium ${MOVEMENT_TONE[tone]}`}>{delta}</div>
    </div>
  );
}

function Headline({ diff }: { diff: PocketChartDiff }) {
  const h = diff.headline;
  const before: PerioStats = h.before;
  const after: PerioStats = h.after;
  return (
    <div className="space-y-3">
      <MovementBar
        improved={h.sitesImproved}
        worse={h.sitesWorse}
        unchanged={h.sitesUnchanged}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <DeltaTile
          label="Bleeding"
          before={pct(before.bopPercent)}
          after={pct(after.bopPercent)}
          delta={signedPct(h.bopPercentChange)}
          tone={toneForFall(h.bopPercentChange)}
        />
        <DeltaTile
          label="Plaque"
          before={pct(before.plaquePercent)}
          after={pct(after.plaquePercent)}
          delta={signedPct(h.plaquePercentChange)}
          tone={toneForFall(h.plaquePercentChange)}
        />
        <DeltaTile
          label="Sites ≥4mm"
          before={String(before.sites4mmPlus)}
          after={String(after.sites4mmPlus)}
          delta={signedCount(h.sites4mmPlusChange)}
          tone={toneForFall(h.sites4mmPlusChange)}
        />
        <DeltaTile
          label="Sites ≥6mm"
          before={String(before.sites6mmPlus)}
          after={String(after.sites6mmPlus)}
          delta={signedCount(h.sites6mmPlusChange)}
          tone={toneForFall(h.sites6mmPlusChange)}
        />
        <DeltaTile
          label="Deepest pocket"
          before={mm(before.deepestPocket)}
          after={mm(after.deepestPocket)}
          delta={signedMm(h.deepestPocketChange)}
          tone={toneForFall(h.deepestPocketChange)}
        />
      </div>
      <p className="text-[11.5px] leading-snug text-muted">
        Both columns are computed over the same sites — the ones recorded in both charts — and over
        nothing else. A whole-chart percentage compared against a differently-shaped whole-chart
        percentage is how a mouth appears to improve by losing teeth.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE TEETH THAT ARE NOT IN BOTH CHARTS. Above the movement grid, always.
// ---------------------------------------------------------------------------

function ToothChangeBand({
  tone,
  heading,
  teeth,
  children,
}: {
  tone: "red" | "amber" | "royal";
  heading: string;
  teeth: readonly number[];
  children: ReactNode;
}) {
  if (teeth.length === 0) return null;
  const skin =
    tone === "red"
      ? "border-tint-red-line bg-tint-red text-status-red"
      : tone === "amber"
        ? "border-tint-amber-line bg-tint-amber text-status-amber"
        : "border-tint-royal-line bg-tint-royal text-status-royal";
  return (
    <div className={`rounded-lg border px-3 py-2 ${skin}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em]">
        {heading} · {teeth.join(", ")}
      </div>
      <p className="mt-1 text-[11.5px] leading-snug">{children}</p>
    </div>
  );
}

function TeethNotInBoth({ diff }: { diff: PocketChartDiff }) {
  const h = diff.headline;
  if (
    h.teethLostSince.length === 0 &&
    h.teethNotRecharted.length === 0 &&
    h.teethNewSince.length === 0
  ) {
    return null;
  }
  return (
    <div className="space-y-2">
      <ToothChangeBand tone="red" heading="No longer present" teeth={h.teethLostSince}>
        Losing a tooth is not an improvement. These readings are excluded from every figure above,
        and the pocket that was recorded there is listed in the notes at the foot of this panel.
      </ToothChangeBand>
      <ToothChangeBand tone="amber" heading="Charted before, missing now" teeth={h.teethNotRecharted}>
        The sextant was charted again and these teeth are not in it. This platform cannot tell an
        extraction from an omission, and neither one is an improvement, so they are excluded from
        every figure above rather than counted as resolved.
      </ToothChangeBand>
      <ToothChangeBand tone="royal" heading="No baseline" teeth={h.teethNewSince}>
        Charted this time and not last time. There is nothing to compare them against, so they are
        outside the movement figures.
      </ToothChangeBand>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-site movement
// ---------------------------------------------------------------------------

function SiteCell({ site }: { site: SiteDiff }) {
  const label =
    site.movement === "not-comparable"
      ? `Tooth ${site.tooth}, ${SITE_LABEL[site.site]}: ${site.reason ?? "not comparable"}`
      : `Tooth ${site.tooth}, ${SITE_LABEL[site.site]}: ${site.beforeDepth}mm to ${site.afterDepth}mm, ${site.movement}`;
  return (
    <div
      className={`flex min-w-[46px] flex-col items-center rounded border px-1 py-0.5 ${MOVEMENT_FILL[site.movement]}`}
      title={label}
    >
      <span className="text-[9px] uppercase tracking-[0.04em] text-faint">{site.site}</span>
      {site.movement === "not-comparable" ? (
        <span className="text-[11px] leading-tight text-faint">—</span>
      ) : (
        <>
          <span className="text-[11px] font-semibold leading-tight tabular-nums text-navy">
            {site.beforeDepth}
            <span aria-hidden className="px-0.5 font-normal text-faint">
              ›
            </span>
            {site.afterDepth}
          </span>
          <span className={`text-[9.5px] font-medium leading-tight ${MOVEMENT_TONE[site.movement]}`}>
            {signedMm(site.depthChange)}
          </span>
        </>
      )}
      {/* CAL alongside, because a pocket that shrank by recession is not the same
          event as one that shrank by re-attachment. Only when both charts hold
          the components it is computed from — it is never inferred. */}
      {site.calChange !== null ? (
        <span className="text-[9px] leading-tight text-muted" title="attachment loss change">
          CAL {signedMm(site.calChange)}
        </span>
      ) : null}
      {/* Bleeding is a state, not a measurement, so it shows as a change of state
          rather than as a number. */}
      {site.bleedingBefore || site.bleedingAfter ? (
        <span className={`text-[9px] leading-tight ${site.bleedingAfter ? "text-status-red" : "text-status-green"}`}>
          {site.bleedingBefore && site.bleedingAfter
            ? "BOP both"
            : site.bleedingAfter
              ? "BOP new"
              : "BOP gone"}
        </span>
      ) : null}
    </div>
  );
}

const NOT_COMPARED_REASON: Record<Exclude<ToothComparison, "compared">, string> = {
  "lost-since": "no longer present",
  "not-recharted": "charted before, missing now",
  "new-since": "no baseline",
  "outside-scope-before": "its sextant was not charted at the earlier visit",
  "outside-scope-after": "its sextant was not charted at the later visit",
};

function ToothRow({ tooth }: { tooth: ToothDiff }) {
  if (tooth.status !== "compared") {
    return (
      <li className="flex flex-wrap items-baseline gap-x-2 border-t border-line py-1.5 text-[12px]">
        <span className="w-9 shrink-0 font-semibold tabular-nums text-navy">{tooth.tooth}</span>
        <span className="text-faint">{NOT_COMPARED_REASON[tooth.status]}</span>
        {tooth.deepestBefore !== null || tooth.deepestAfter !== null ? (
          <span className="text-faint">
            (deepest {mm(tooth.deepestBefore)} → {mm(tooth.deepestAfter)})
          </span>
        ) : null}
      </li>
    );
  }
  const buccal = tooth.sites.filter((s) => SITE_IDS.indexOf(s.site) < 3);
  const lingual = tooth.sites.filter((s) => SITE_IDS.indexOf(s.site) >= 3);
  return (
    <li className="flex items-start gap-2 border-t border-line py-1.5">
      <div className="w-9 shrink-0 pt-1">
        <div className="text-[13px] font-semibold tabular-nums leading-none text-navy">
          {tooth.tooth}
        </div>
        <div className="mt-0.5 text-[9px] uppercase leading-none text-faint">
          {tooth.sextant ?? "—"}
        </div>
      </div>
      {/* Buccal row above lingual row, as every UK system draws it. */}
      <div className="flex min-w-0 flex-col gap-0.5 overflow-x-auto">
        <div className="flex gap-0.5">
          {buccal.map((site) => (
            <SiteCell key={site.site} site={site} />
          ))}
        </div>
        <div className="flex gap-0.5">
          {lingual.map((site) => (
            <SiteCell key={site.site} site={site} />
          ))}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export function PerioComparison({
  before,
  after,
  /**
   * How many millimetres count as movement. The engine's default is 1mm;
   * 2mm is the clinically conventional threshold because it allows for probing
   * error. Passed through untouched — this component must not quietly redefine
   * what "improved" means, which is why there is no default here either.
   */
  thresholdMm,
  /**
   * FDI numbers of the teeth actually in the mouth at the later visit.
   *
   * SUPPLYING THIS IS THE ONLY WAY the comparison can tell an extraction from a
   * tooth that was merely not re-charted. Neither is an improvement, but the
   * clinician needs to know which one happened, and without this every missing
   * tooth falls into the weaker "we cannot tell" bucket.
   */
  presentTeethAfter,
  fp17Notice,
}: {
  before: PocketChartView;
  after: PocketChartView;
  thresholdMm?: number;
  presentTeethAfter?: readonly number[];
  fp17Notice?: string | null;
}) {
  // A REFUSAL IS CONTENT. Different patients, or a later chart dated before the
  // earlier one: both throw, and both are things a clinician must be told in
  // words rather than shown as an empty panel.
  let diff: PocketChartDiff;
  try {
    diff = diffPocketCharts(before, after, { thresholdMm, presentTeethAfter });
  } catch (error) {
    const issues =
      error instanceof PerioValidationError
        ? error.issues
        : ["These two charts could not be compared, and this is a failure to compare them rather than a finding that nothing changed."];
    return (
      <section
        className="space-y-1.5 rounded-xl border border-tint-red-line bg-tint-red p-4"
        aria-label="Comparison refused"
      >
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-status-red">
          These charts were not compared
        </h3>
        {issues.map((issue) => (
          <p key={issue} className="text-[12px] leading-snug text-status-red">
            {issue}
          </p>
        ))}
      </section>
    );
  }

  const compared = diff.teeth.filter((t) => t.status === "compared");
  const notCompared = diff.teeth.filter((t) => t.status !== "compared");

  return (
    <section
      className="space-y-3 rounded-xl border border-line bg-card p-4 shadow-sm"
      aria-label="Six-point chart comparison"
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-navy">
            This visit against the last
          </h3>
          <p className="text-[11px] text-faint">
            Movement is measured on probing depth. A change of less than{" "}
            {thresholdMm ?? 1}mm reads as unchanged.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ChartStamp label="Earlier" chart={before} />
          <ChartStamp label="Later" chart={after} />
        </div>
      </header>

      {/* BEFORE A SINGLE GREEN ARROW. See the header note. */}
      <TeethNotInBoth diff={diff} />

      <Headline diff={diff} />

      <div>
        <h4 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
          Site by site · {compared.length} tooth{compared.length === 1 ? "" : "s"} compared
        </h4>
        {compared.length === 0 ? (
          <p className="py-2 text-[12px] text-faint">
            No tooth appears in both charts, so there is nothing to lay side by side.
          </p>
        ) : (
          <ul className="border-b border-line">
            {compared.map((tooth) => (
              <ToothRow key={tooth.tooth} tooth={tooth} />
            ))}
          </ul>
        )}
      </div>

      {notCompared.length > 0 ? (
        <div>
          <h4 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
            Not compared · {notCompared.length}
          </h4>
          <ul className="border-b border-line">
            {notCompared.map((tooth) => (
              <ToothRow key={tooth.tooth} tooth={tooth} />
            ))}
          </ul>
        </div>
      ) : null}

      {/* The engine's own sentences, verbatim. The extracted-tooth one is always
          in here, and it names the pocket that was recorded at the tooth that
          has gone — which is the number a clinician would otherwise have to go
          and look up to understand why the figures moved. */}
      {diff.caveats.length > 0 ? (
        <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] leading-snug text-muted">
          {diff.caveats.map((caveat) => (
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
