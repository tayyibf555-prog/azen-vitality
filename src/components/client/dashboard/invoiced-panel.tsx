"use client";

import { axisTickLabel, barFraction, niceAxis } from "@/lib/dashboard/chart";
import { formatPenceGbp } from "@/lib/dashboard/money";
import type { InvoicedPanel as Panel } from "@/lib/dashboard/view";
import { num } from "@/lib/utils";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { Money, PanelTitle, Unavailable } from "./parts";

// ---------------------------------------------------------------------------
// The INVOICED panel: what was billed in the selected period, split paid and
// unpaid.
//
// Invoiced is not takings. Takings is what came through the till; invoiced is
// what went out on paper. The two panels sit next to each other and are read
// together, so unpaid is drawn as its own bar rather than left to be inferred.
//
// Drawn as a COLUMN CHART against a value axis, which is what Dentally does and
// what the practice manager is used to reading here. It replaced two horizontal
// progress bars: those showed each figure's share of the gross, so paid and
// unpaid each filled a different proportion of the same width and could not be
// compared against one another by eye. Against a shared axis they can, which is
// the entire question this panel answers.
//
// The axis arithmetic lives in lib/dashboard/chart.ts with tests, because an
// axis maximum below the tallest bar clips it silently and this is a money panel.
//
// THE PLOT FILLS THE PANEL, and that is a correction to a real defect. It used to
// be a fixed 104px block pinned to the foot of the cell with mt-auto, while the
// band's row height is set by whichever column has the most in it - Accounts with
// ten debtors, or Patients and plans with six figures and a contract line. So on
// a 1440 screen this panel rendered a headline, a caption, roughly a hundred and
// fifty pixels of nothing, and then a small chart: the emptiest thing on the
// screen, in a house style whose whole rule is that width and height get spent on
// information rather than on margin. The plot is now the flexible part of the
// column and grows into whatever the band's row height turns out to be, with
// MIN_PLOT_HEIGHT as its floor so it can never collapse below what it was.
//
// Every measurement in it was already proportional - the ticks and the gridlines
// position by percentage against axis.max - so only the bars had to change, from
// pixels computed against a constant to a percentage of the plot box.
// ---------------------------------------------------------------------------

/** The floor, and the height the plot used to be fixed at. Never shorter. */
const MIN_PLOT_HEIGHT = 104;

function Column({
  label,
  pence,
  axisMax,
  tone,
}: {
  label: string;
  pence: number;
  axisMax: number;
  tone: string;
}) {
  const fraction = barFraction(pence, axisMax);
  return (
    // The PERCENTAGE lives on this element rather than on the bar inside it. Its
    // parent is the absolutely positioned plot box, which has a definite height,
    // so a percentage resolves against the plot; the bar's own parent would be
    // auto-height and the percentage would resolve to nothing.
    //
    // A non-zero amount always draws at least a visible sliver: an unpaid balance
    // of forty pounds against a ten thousand pound axis is a real debt and must
    // not round away to an empty column that reads as "nothing outstanding".
    <div
      className="flex min-w-0 flex-1 justify-center"
      style={{ height: `${fraction * 100}%`, minHeight: pence > 0 ? 2 : 0 }}
    >
      {/* 84px, up from 54. The cap is a proportion in disguise: at 54 against a
          plot that now runs 250px tall the bars drew as two narrow stripes, which
          reads as a gauge rather than as the column chart Dentally puts here. The
          columns still have room either side of them at every width the panel is
          rendered at, so this widens the mark without crowding the pair. */}
      <div
        title={`${label}: ${formatPenceGbp(pence)}`}
        className="h-full w-full max-w-[84px] rounded-t-[2px]"
        style={{ background: tone }}
      />
    </div>
  );
}

export function InvoicedPanelView({
  panel,
  caveats,
  onOpenCaveat,
}: {
  panel: Panel;
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  const total = panel.totalPence.value;
  const paid = panel.paidPence.value;
  const unpaid = panel.unpaidPence.value;
  const drawable = total !== null && paid !== null && unpaid !== null;

  // The axis is scaled to the TALLEST BAR, not to the gross. Paid plus unpaid is
  // the gross, so scaling to the gross would leave both columns under half
  // height on every practice that collects most of what it bills, and the panel
  // would read as though little had been invoiced.
  const axis = niceAxis(drawable ? Math.max(paid, unpaid) : 0);

  return (
    <section aria-label="Invoiced" className="flex h-full min-w-0 flex-col">
      <PanelTitle>Invoiced</PanelTitle>

      <div className="flex items-baseline gap-1.5 pt-2">
        <Money metric={panel.totalPence} size="figure" className="leading-[1.1]" />
        <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
      </div>
      <span className="block text-[11px] font-medium text-muted">
        {panel.invoiceCount.value === null ? (
          "billed in this period"
        ) : (
          <>
            on {num(panel.invoiceCount.value)} invoice
            {panel.invoiceCount.value === 1 ? "" : "s"} in this period
          </>
        )}
      </span>

      {!drawable ? (
        <div className="pt-2">
          <Unavailable reason={panel.totalPence.reason} />
        </div>
      ) : (
        // min-h-0 so the flex child may actually shrink to its share; without it
        // a flex item's automatic minimum size is its content and the column
        // would overflow the band on a short row instead of filling a tall one.
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="flex flex-1 gap-1.5" style={{ minHeight: MIN_PLOT_HEIGHT }}>
            {/* The value axis. aria-hidden because the figures themselves are
                announced in the labelled list underneath; a screen reader
                reading six tick marks aloud is noise, not information.

                No height of its own any more: it is a stretch item beside the
                plot, so the two are the same height by construction rather than
                by two call sites agreeing on a constant. */}
            <div aria-hidden className="relative w-[22px] shrink-0">
              {axis.ticks.map((tick) => (
                // translate-y-1/2, POSITIVE, and that is a sign correction. `bottom`
                // puts the label's BOTTOM edge on its gridline, so centring it on that
                // line means moving DOWN by half its height; it moved up instead, and
                // every label on the axis therefore sat a full 12.5px clear above the
                // line it names - close enough to the NEXT line up to be read against
                // the wrong one. Nobody saw it while the plot was a fixed 104px block
                // pinned to the foot of the panel, because the whole axis was adrift
                // by the same amount and there was empty panel above it to be adrift
                // into. Filling the panel put the top label into the caption.
                <span
                  key={tick}
                  className="absolute right-0 translate-y-1/2 text-[9px] font-medium tabular-nums text-faint"
                  style={{ bottom: `${(tick / axis.max) * 100}%` }}
                >
                  {axisTickLabel(tick)}
                </span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              {axis.ticks.map((tick) => (
                <span
                  key={tick}
                  aria-hidden
                  className="absolute inset-x-0 h-px bg-line"
                  style={{ bottom: `${(tick / axis.max) * 100}%` }}
                />
              ))}
              {/* NO px- HERE. The figures underneath are laid out on the same two
                  tracks (pl-[28px] clears the axis column and its gap, then the same
                  gap-3), so any padding on this row alone shifts the bars inward and
                  the pair stop registering with their own labels: 4px outward each,
                  measured, which on a two-column chart reads as the labels belonging
                  to nothing in particular. The bars are capped well inside their
                  tracks, so flush against the plot edge costs no room. */}
              <div className="absolute inset-0 flex items-end gap-3">
                <Column label="Paid" pence={paid} axisMax={axis.max} tone="var(--status-green)" />
                <Column
                  label="Unpaid"
                  pence={unpaid}
                  axisMax={axis.max}
                  tone="var(--status-amber)"
                />
              </div>
            </div>
          </div>

          {/* The figures in words under the columns. This is what the chart is
              read FROM once the shape has been taken in, and it is what assistive
              tech gets instead of the axis.

              12.5px, which is the screen's DATA step and what every other numeral
              of this rank is set in. They were 12px - half a pixel off the scale
              and off nothing else on the page. */}
          <dl className="mt-1.5 flex gap-3 pl-[28px]">
            <div className="min-w-0 flex-1 text-center">
              <dt className="truncate text-[10px] font-medium text-muted">Paid</dt>
              <dd className="truncate text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
                {formatPenceGbp(paid)}
              </dd>
            </div>
            <div className="min-w-0 flex-1 text-center">
              <dt className="truncate text-[10px] font-medium text-muted">Unpaid</dt>
              <dd className="truncate text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
                {formatPenceGbp(unpaid)}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
