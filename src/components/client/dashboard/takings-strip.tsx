"use client";

import { formatPenceGbp } from "@/lib/dashboard/money";
import { PERIOD_LABELS, type DashboardPeriod } from "@/lib/dashboard/period";
import type { TakingsCell } from "@/lib/dashboard/takings";
import type { TakingsSource } from "@/lib/dashboard/view";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { cn, num } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The takings strip: five period cells across the full width, and the selector
// that drives every panel below.
//
// It is the first thing she reads, so the money is the only thing set large.
// Everything else on the cell (the period, the appointment count, where the
// figure came from) sits small and quiet underneath.
//
// Freshness is still on the face of it, but as a mark on the heading rather than
// a paragraph under the band. Today and yesterday are read live from Dentally;
// longer periods come from the nightly rollup. A cell that could be sourced
// neither way says so and gives the reason. It never shows £0.00.
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<TakingsSource, string> = {
  live: "live",
  rollup: "nightly",
};

function Cell({
  cell,
  source,
  selected,
  onSelect,
}: {
  cell: TakingsCell;
  source: TakingsSource | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const unavailable = cell.totalPence === null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "pressable group relative flex min-w-0 flex-col items-start gap-[3px] px-4 py-2.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        selected ? "bg-card-muted" : "hover:bg-card-muted/50",
      )}
    >
      {/* The selected period carries a solid rule along the top, so it reads as
          chosen from across a desk and not only by a fill that a projector loses. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-[3px]",
          selected ? "bg-navy" : "bg-transparent",
        )}
      />
      <span
        className={cn(
          "text-[10px] font-semibold uppercase tracking-[0.07em]",
          selected ? "text-navy" : "text-muted",
        )}
      >
        {PERIOD_LABELS[cell.period]}
      </span>

      {unavailable ? (
        <span title={cell.unavailableReason ?? undefined} className="text-[22px] font-medium leading-[1.1] text-faint">
          Unavailable
        </span>
      ) : (
        <span className="truncate text-[22px] font-bold leading-[1.1] tabular-nums tracking-[-0.6px] text-navy">
          {formatPenceGbp(cell.totalPence ?? 0)}
        </span>
      )}

      <span className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] font-medium leading-[1.2] text-muted">
        {cell.appointmentCount === null ? (
          <span title={cell.appointmentUnavailableReason ?? undefined} className="text-faint">
            appointments unavailable
          </span>
        ) : (
          <span className="tabular-nums">
            {num(cell.appointmentCount)} appointment{cell.appointmentCount === 1 ? "" : "s"}
          </span>
        )}
        {source ? (
          <span className="text-[10px] font-medium uppercase tracking-[0.07em] text-faint">
            {SOURCE_LABEL[source]}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function TakingsStripPanel({
  cells,
  sources,
  selected,
  onSelect,
  siteControl,
  caveats,
  onOpenCaveat,
}: {
  cells: TakingsCell[];
  sources: Partial<Record<DashboardPeriod, TakingsSource>>;
  selected: DashboardPeriod;
  onSelect: (period: DashboardPeriod) => void;
  /** The all-sites versus per-site toggle, rendered on the right of the strip. */
  siteControl: React.ReactNode;
  /** Where the figures came from, and anything left out of a total. */
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  return (
    <section aria-label="Takings">
      <div className="flex flex-col gap-1.5 border-b border-line pb-1.5 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-1.5">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">Takings</h2>
          <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
        </span>
        {siteControl}
      </div>

      {/* The cells bleed to the content edge, so the first figure sits on the
          same left rule as every heading and row on the page. */}
      <div
        role="tablist"
        aria-label="Choose a period"
        className="-mx-4 grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-3 lg:grid-cols-5"
      >
        {cells.map((cell) => (
          <Cell
            key={cell.period}
            cell={cell}
            source={sources[cell.period]}
            selected={cell.period === selected}
            onSelect={() => onSelect(cell.period)}
          />
        ))}
      </div>
    </section>
  );
}
