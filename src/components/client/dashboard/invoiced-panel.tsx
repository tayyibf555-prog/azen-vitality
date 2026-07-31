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
// ---------------------------------------------------------------------------

const PLOT_HEIGHT = 104;

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
  // A non-zero amount always draws at least a visible sliver: an unpaid balance
  // of forty pounds against a ten thousand pound axis is a real debt and must
  // not round away to an empty column that reads as "nothing outstanding".
  const height = pence > 0 ? Math.max(2, Math.round(fraction * PLOT_HEIGHT)) : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-end">
      <div
        title={`${label}: ${formatPenceGbp(pence)}`}
        className="w-full max-w-[54px] rounded-t-[2px]"
        style={{ height, background: tone }}
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
        <div className="mt-auto pt-3">
          <div className="flex gap-1.5">
            {/* The value axis. aria-hidden because the figures themselves are
                announced in the labelled list underneath; a screen reader
                reading six tick marks aloud is noise, not information. */}
            <div
              aria-hidden
              className="relative w-[22px] shrink-0"
              style={{ height: PLOT_HEIGHT }}
            >
              {axis.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-[9px] font-medium tabular-nums text-faint"
                  style={{ bottom: `${(tick / axis.max) * 100}%` }}
                >
                  {axisTickLabel(tick)}
                </span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1" style={{ height: PLOT_HEIGHT }}>
              {axis.ticks.map((tick) => (
                <span
                  key={tick}
                  aria-hidden
                  className="absolute inset-x-0 h-px bg-line"
                  style={{ bottom: `${(tick / axis.max) * 100}%` }}
                />
              ))}
              <div className="absolute inset-0 flex items-end gap-3 px-2">
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
              tech gets instead of the axis. */}
          <dl className="mt-1.5 flex gap-3 pl-[28px]">
            <div className="min-w-0 flex-1 text-center">
              <dt className="truncate text-[10px] font-medium text-muted">Paid</dt>
              <dd className="truncate text-[12px] font-bold tabular-nums tracking-[-0.2px] text-navy">
                {formatPenceGbp(paid)}
              </dd>
            </div>
            <div className="min-w-0 flex-1 text-center">
              <dt className="truncate text-[10px] font-medium text-muted">Unpaid</dt>
              <dd className="truncate text-[12px] font-bold tabular-nums tracking-[-0.2px] text-navy">
                {formatPenceGbp(unpaid)}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
