"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Optional count/badge shown after the label. */
  badge?: React.ReactNode;
  content: React.ReactNode;
}

/**
 * Segmented tab control for progressive disclosure: keep the primary panel in
 * view and tuck secondary detail one click away instead of stacking everything
 * down the page. Only the active panel is mounted, so switching tabs keeps each
 * screen to roughly one viewport. Matches the house segmented style
 * (the mock switch: white bar, small radius, navy active chip).
 */
export function Tabs({
  tabs,
  defaultKey,
  className,
  tablistClassName,
  actions,
}: {
  tabs: TabItem[];
  defaultKey?: string;
  className?: string;
  tablistClassName?: string;
  /** Optional controls rendered on the right of the tab bar. */
  actions?: React.ReactNode;
}) {
  const [active, setActive] = useState(defaultKey ?? tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div className={cn("space-y-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          className={cn(
            "inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]",
            tablistClassName,
          )}
        >
          {tabs.map(({ key, label, icon: Icon, badge }) => {
            const isActive = key === current?.key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(key)}
                className={cn(
                  "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  isActive ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                )}
              >
                {Icon ? <Icon size={15} className="shrink-0" /> : null}
                {label}
                {badge != null && badge !== "" ? (
                  <span
                    className={cn(
                      "ml-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                      isActive ? "bg-white/20 text-white" : "bg-[#f0f3f8] text-muted",
                    )}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      <div role="tabpanel">{current?.content}</div>
    </div>
  );
}
