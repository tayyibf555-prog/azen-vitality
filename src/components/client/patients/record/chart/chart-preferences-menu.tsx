import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChartPreferences } from "@/lib/charting/types";

/**
 * Dentally's chart preferences, and there is exactly ONE of this file.
 *
 * DENTALLY.md:113 says the same preferences open from the chevron beside the PD/DD
 * segment OR from the settings cog in the bottom-right cluster. The chevron lives in
 * treatment-panel.tsx and the cog in chart-tools.tsx, which are owned by two different
 * builders: without a single owned file each would write its own menu and the two
 * would drift in wording and in which preferences they carried. Both controls call
 * onOpenPreferences and the workspace renders this once.
 *
 * EVERY TOGGLE HAS A REAL CONSUMER, because a preference carried with no behaviour is
 * furniture and the reader learns to distrust the whole menu:
 *   locked      - chartReducer rule 7 rejects every charting intent while it is on.
 *   combined    - archRows() returns both dentitions, so a mixed-dentition child's
 *                 chart is not half missing.
 *   hover       - suppresses the per-tooth history tooltip.
 *   collapsed   - collapses the treatment list. The arch takes the freed width only
 *                 as far as arch-metrics' MAX_TOOTH cap; past that the columns stop
 *                 growing and the surplus becomes the air the arch centres in. The
 *                 hint below says so, because a control that stops must not be
 *                 described as one that keeps going.
 *   favourites  - favourites sort to the top of the treatment list.
 *   sort        - name or code order in the treatment list.
 *
 * State lives in the workspace and persistence is its job; this file takes the
 * current preferences and hands back the next ones. Display preferences only:
 * nothing clinical is decided here.
 */

const ROWS: { key: keyof ChartPreferences; label: string; hint: string }[] = [
  { key: "locked", label: "Locked chart", hint: "Refuses every charting click until it is unlocked." },
  { key: "combined", label: "Combined chart", hint: "Draws the permanent and deciduous arches together." },
  { key: "hover", label: "Hover chart", hint: "Shows a tooth's history when it is hovered or focused." },
  { key: "panelCollapsed", label: "Collapse treatment list", hint: "Hides the left panel. The arch widens up to full size, then centres." },
  { key: "favouritesFirst", label: "Favourites on top", hint: "Sorts starred treatments above the rest." },
];

export function ChartPreferencesMenu({
  open,
  preferences,
  onChange,
  onClose,
  className,
}: {
  open: boolean;
  preferences: ChartPreferences;
  onChange: (next: ChartPreferences) => void;
  onClose: () => void;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus the panel when it opens, so a keyboard user who pressed the chevron is
  // inside the menu rather than still on the control that opened it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Chart preferences"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "z-30 w-[262px] rounded-xl border border-line-strong bg-card p-3 shadow-lg focus:outline-none",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <h4 className="text-[12.5px] font-semibold tracking-[-0.1px] text-navy">Chart preferences</h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chart preferences"
          className="pressable rounded-md p-[3px] text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      <ul className="py-1">
        {ROWS.map((row) => {
          const checked = Boolean(preferences[row.key]);
          return (
            <li key={row.key}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-[5px] transition-colors hover:bg-band">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onChange({ ...preferences, [row.key]: e.target.checked })}
                  className="mt-[3px] size-[13px] shrink-0 accent-[var(--blue-dark)]"
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium leading-[1.35] text-ink">{row.label}</span>
                  <span className="block text-[11px] leading-[1.4] text-faint">{row.hint}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-line pt-2">
        <span className="mb-1 block text-[11px] font-medium text-muted">Sort the treatment list by</span>
        <div role="group" aria-label="Sort the treatment list by" className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[2px]">
          {(["name", "code"] as const).map((sort) => (
            <button
              key={sort}
              type="button"
              aria-pressed={preferences.sort === sort}
              onClick={() => onChange({ ...preferences, sort })}
              className={cn(
                "pressable rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                preferences.sort === sort ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
              )}
            >
              {sort === "name" ? "Name" : "Code"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
