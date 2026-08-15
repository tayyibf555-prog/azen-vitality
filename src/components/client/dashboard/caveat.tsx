"use client";

import { caveatSummary, leadCaveat, type Caveat } from "./caveats";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// How the dashboard's caveats are shown.
//
// Two affordances, both giving the whole sentence:
//
//   CaveatMark  a 13px glyph beside the figure it qualifies. Hovering it, or
//               reading it with a screen reader, gives every caveat that figure
//               carries in full. Clicking opens it in the row below the band.
//
//   CaveatRow   one quiet line under the middle band listing each caveat as a
//               chip. Opening a chip prints the full sentence beneath it.
//
// The glyph is "!" for anything qualifying money or claims that could not be
// counted and "i" for the rest, so the difference survives with colour ignored.
// ---------------------------------------------------------------------------

const CHIP_TEXT_ID = "dashboard-caveat-text";

export function CaveatMark({
  caveats,
  onOpen,
  className,
}: {
  caveats: Caveat[];
  onOpen: (id: string) => void;
  className?: string;
}) {
  if (caveats.length === 0) return null;
  const lead = leadCaveat(caveats);
  const material = caveats.some((c) => c.material);
  const text = caveatSummary(caveats);
  return (
    <button
      type="button"
      onClick={() => (lead ? onOpen(lead.id) : undefined)}
      title={text}
      aria-label={text}
      className={cn(
        "inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border align-middle transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        material
          ? "border-tint-amber-line bg-tint-amber text-status-amber hover:border-status-amber"
          : "border-line-strong bg-card text-faint hover:border-navy/40 hover:text-muted",
        className,
      )}
    >
      {/* 9px: the screen's smallest drawn step, shared with the invoiced axis
          ticks and the row initials. It was 8.5px, a size used nowhere else. */}
      <span aria-hidden className="text-[9px] font-bold leading-none">
        {material ? "!" : "i"}
      </span>
    </button>
  );
}

/**
 * The single footnote line under the middle band.
 *
 * `lead` is the freshness and scope line she already reads there. `openId` is
 * lifted so a mark beside a figure can open the matching chip; the row keeps its
 * own state in step when a chip is clicked directly.
 */
export function CaveatRow({
  lead,
  caveats,
  openId,
  onOpenChange,
}: {
  lead: React.ReactNode;
  caveats: Caveat[];
  openId: string | null;
  onOpenChange: (id: string | null) => void;
}) {
  // ONE QUIET LINE, not a row of chips.
  //
  // This used to print every caveat as its own pill, three of them styled amber,
  // so the screen announced five problems before a single figure had been read.
  // The owner's verdict on the result was that ours looked worse than Dentally,
  // whose equivalent screen carries one line of grey text.
  //
  // Nothing is hidden and nothing is softened: every sentence is still here, in
  // full, one disclosure away. What changed is that a footnote now LOOKS like a
  // footnote. Amber is reserved for warnings, so a caveat that merely explains
  // how a figure is sourced no longer borrows the colour of one that matters.
  const open = caveats.find((c) => c.id === openId) ?? null;
  const material = caveats.filter((c) => c.material).length;
  const summary =
    caveats.length === 0
      ? null
      : material > 0
        ? `${material} figure${material === 1 ? "" : "s"} qualified`
        : "About these figures";

  return (
    <div className="pt-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] font-normal text-faint">{lead}</span>
        {summary ? (
          <button
            type="button"
            aria-expanded={openId !== null}
            aria-controls={CHIP_TEXT_ID}
            // Opens on the first caveat, or closes whichever is open. One
            // control, so there is nothing to scan along.
            onClick={() => onOpenChange(openId === null ? (caveats[0]?.id ?? null) : null)}
            className="pressable rounded text-[11px] font-normal text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            {summary}
          </button>
        ) : null}
      </div>

      {/* Opened: every caveat in full, as sentences. The material ones lead,
          because those are the figures somebody might act on. */}
      <div id={CHIP_TEXT_ID} hidden={open === null} className="mt-1.5 space-y-1">
        {[...caveats]
          .sort((a, b) => Number(b.material) - Number(a.material))
          .map((c) => (
            <p
              key={c.id}
              className={cn(
                "text-[11px] leading-[1.45]",
                c.material ? "font-medium text-ink" : "font-normal text-muted",
              )}
            >
              <span className="font-semibold">{c.label}.</span> {c.text}
            </p>
          ))}
      </div>
    </div>
  );
}
