"use client";

import { formatPenceGbp } from "@/lib/dashboard/money";
import { PERIOD_LABELS, type DashboardPeriod } from "@/lib/dashboard/period";
import type { TakingsCell } from "@/lib/dashboard/takings";
import { cn, num } from "@/lib/utils";
import { FOCUS } from "./parts";

// ---------------------------------------------------------------------------
// VARIANT C: the takings strip.
//
// Set the way Dentally sets it, because that shape is the one thing on the
// screen a practice manager reads without looking: five period cells on a light
// grey strip, and the CHOSEN one raised out of it as a white card with its label
// in blue. Raising the selection reads from across a desk and survives a
// projector, which a tinted fill and a navy top rule did not.
//
// What is gone, and why: a "LIVE" tag on every one of the five cells. Five
// identical tags on one strip tell a reader nothing the strip's own heading did
// not, and they cost the money figures the contrast they need. Where each
// figure came from is a fact about the whole strip, so it is said once, quietly,
// in the grey line under the band.
//
// A cell that could not be sourced says "Unavailable" and carries its reason.
// It never prints £0.00: on a takings screen a plausible zero gets believed.
// ---------------------------------------------------------------------------

function Cell({
  cell,
  selected,
  onSelect,
}: {
  cell: TakingsCell;
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
      title={`Show ${PERIOD_LABELS[cell.period].toLowerCase()} across every panel on this screen`}
      className={cn(
        "pressable relative flex min-w-0 flex-col items-center gap-[3px] rounded-[9px] px-2 py-2.5 text-center transition-all duration-150",
        FOCUS,
        selected
          ? "bg-white shadow-[0_1px_2px_rgba(11,32,73,0.06),0_6px_16px_rgba(11,32,73,0.08)]"
          : "hover:bg-white/70",
      )}
    >
      <span
        className={cn(
          "text-[11px] font-semibold leading-[1.2]",
          selected ? "text-blue-royal" : "text-muted",
        )}
      >
        {PERIOD_LABELS[cell.period]}
      </span>

      {unavailable ? (
        <span
          title={cell.unavailableReason ?? undefined}
          className="text-[19px] font-medium leading-[1.1] text-faint"
        >
          Unavailable
          {cell.unavailableReason ? <span className="sr-only">. {cell.unavailableReason}</span> : null}
        </span>
      ) : (
        <span className="w-full truncate text-[24px] font-bold leading-[1.1] tabular-nums tracking-[-0.8px] text-navy">
          {formatPenceGbp(cell.totalPence ?? 0)}
        </span>
      )}

      <span className="text-[11px] font-medium leading-[1.2] text-muted">
        {cell.appointmentCount === null ? (
          <span title={cell.appointmentUnavailableReason ?? undefined} className="text-faint">
            appointments unavailable
          </span>
        ) : (
          <span className="tabular-nums">
            {num(cell.appointmentCount)} appointment{cell.appointmentCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
    </button>
  );
}

export function TakingsStrip({
  cells,
  selected,
  onSelect,
}: {
  cells: TakingsCell[];
  selected: DashboardPeriod;
  onSelect: (period: DashboardPeriod) => void;
}) {
  return (
    <section aria-label="Takings">
      <div
        role="tablist"
        aria-label="Choose a period"
        className="grid grid-cols-2 gap-1 rounded-[12px] bg-[#e9eff8] p-1 sm:grid-cols-3 lg:grid-cols-5"
      >
        {cells.map((cell) => (
          <Cell
            key={cell.period}
            cell={cell}
            selected={cell.period === selected}
            onSelect={() => onSelect(cell.period)}
          />
        ))}
      </div>
    </section>
  );
}
