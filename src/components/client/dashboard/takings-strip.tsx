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
// a paragraph under the band. EVERY period is read live from Dentally now — the
// endpoint takes start_date/end_date and answers with the exact total for the
// window, so ninety days costs the same single request today does. (This comment
// used to say the long periods came from the nightly rollup "because Dentally does
// not filter payments by date"; that was false and it is what understated the
// practice's takings.) A cell that could not be sourced says so and gives the
// reason. It never shows £0.00 in place of a figure it does not have.
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
      className={cn(
        // Padding tracks the shell's gutter (px-4 sm:px-5 lg:px-6), because the
        // strip bleeds out by exactly that much. See the bleed comment below.
        "pressable group relative flex min-w-0 flex-col items-start gap-[3px] px-4 py-2.5 text-left transition-colors sm:px-5 lg:px-6",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        // THE SELECTED CELL IS RAISED, NOT TINTED - and that is an inversion.
        //
        // It used to be the other way up: the strip sat on the page and the chosen
        // period was painted card-muted, i.e. the chosen cell was the DARKER one.
        // That is the opposite of what Dentally does and the opposite of what a
        // physical control does; the eye reads the recessed cell as the disabled
        // one. Now the strip is the muted surface and TODAY is the card lifted off
        // it, which is also why the cells are tabs: this is a role="tablist".
        selected ? "bg-card shadow-chip" : "hover:bg-card/60",
      )}
    >
      {/* The selected period also carries a rule along the top, so it reads as
          chosen from across a desk and not only by a fill that a projector loses.
          Two cues, neither of them a hue: the cell is LIGHTER than the strip and
          lifted off it, and it is the one with the rule. The rule is 2px now
          rather than 3px because it is no longer carrying the job alone. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-[2px]",
          selected ? "bg-navy" : "bg-transparent",
        )}
      />
      {/* The period caption. Sentence case, at the screen's META step: this is a
          tab's caption, not a heading, and the file's own rule directly above is
          that "the money is the only thing set large". It used to be 10px caps -
          one of fifteen instances of a hand-copied uppercase class string, none
          of which agreed with PRODUCT.md's "prefer sentence case". Selection is
          still legible here in the ink weight, but it is the third cue and not
          the load-bearing one; see the lift and the rule above. */}
      <span className={cn("text-[11px] font-semibold", selected ? "text-navy" : "text-muted")}>
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
      </span>
    </button>
  );
}

export function TakingsStripPanel({
  cells,
  selected,
  onSelect,
  siteControl,
  caveats,
  onOpenCaveat,
}: {
  cells: TakingsCell[];
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
          {/* ONE HEADING TREATMENT ON THIS SCREEN. This <h2>, the appointment
              list's <h2> and every PanelTitle are peers a reader takes in
              together, and they used to be 12px sentence case, 10px uppercase
              and 10px uppercase respectively - three looks for one rank. They
              are all .text-title now, which is also SectionCard's <h3>. */}
          <h2 className="text-title text-navy">Takings</h2>
          <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
        </span>
        {siteControl}
      </div>

      {/* The cells bleed to the content edge, so the first figure sits on the same
          left rule as every heading and row on the page. That claim used to be
          false above sm: the bleed was a flat -mx-4 while the shell's gutter grows
          to px-5 and px-6, so the strip stopped 8px short of the edge at lg. The
          bleed and the cells' own padding now both track the gutter.

          NO BOTTOM RULE. There was one, and twelve pixels below it the band opened
          on a border-t of its own: two parallel hairlines with nothing between
          them. The strip is a filled surface now, so its own edge is the boundary
          and the band keeps the pair of rules that belong to the band. */}
      <div
        role="tablist"
        aria-label="Choose a period"
        className="-mx-4 grid grid-cols-2 divide-x divide-line bg-card-muted sm:-mx-5 sm:grid-cols-3 lg:-mx-6 lg:grid-cols-5"
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
