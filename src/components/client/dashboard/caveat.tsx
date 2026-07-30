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

function Glyph({ material }: { material: boolean }) {
  return (
    <span
      aria-hidden
      className="flex h-[12px] w-[12px] shrink-0 items-center justify-center rounded-full border border-current text-[8.5px] font-bold leading-none"
    >
      {material ? "!" : "i"}
    </span>
  );
}

/** The mark beside a qualified figure. Renders nothing when there is nothing to say. */
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
      <span aria-hidden className="text-[8.5px] font-bold leading-none">
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
  const open = caveats.find((c) => c.id === openId) ?? null;
  return (
    <div className="pt-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-normal text-faint">{lead}</span>
        <span className="flex flex-wrap items-center gap-1 sm:ml-auto sm:justify-end">
          {caveats.map((c) => {
            const isOpen = c.id === openId;
            return (
              <button
                key={c.id}
                type="button"
                aria-expanded={isOpen}
                aria-controls={CHIP_TEXT_ID}
                onClick={() => onOpenChange(isOpen ? null : c.id)}
                title={c.text}
                className={cn(
                  "pressable inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[11px] font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  isOpen
                    ? "border-line-strong bg-card-muted text-navy"
                    : c.material
                      ? "border-tint-amber-line bg-tint-amber text-status-amber hover:border-status-amber"
                      : "border-line bg-card text-muted hover:border-line-strong hover:text-navy",
                )}
              >
                <Glyph material={c.material} />
                {c.label}
              </button>
            );
          })}
        </span>
      </div>
      <p
        id={CHIP_TEXT_ID}
        hidden={open === null}
        className="mt-1 text-[11px] font-normal leading-[1.45] text-muted"
      >
        {open?.text}
      </p>
    </div>
  );
}
