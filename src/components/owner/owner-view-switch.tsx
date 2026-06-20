"use client";

import { useState } from "react";
import { Activity, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Top-level toggle for the owner command view: practice Operations (running the
 * practice + automation results) vs Systems (the AI systems and their status).
 * Both panels are server-rendered and passed in; this only flips which is shown.
 */
export function OwnerViewSwitch({
  operations,
  systems,
}: {
  operations: React.ReactNode;
  systems: React.ReactNode;
}) {
  const [view, setView] = useState<"operations" | "systems">("operations");
  const tabs = [
    { key: "operations" as const, label: "Operations", Icon: Activity },
    { key: "systems" as const, label: "Systems", Icon: Cpu },
  ];

  return (
    <>
      <div className="inline-flex rounded-xl border border-line bg-card p-1 shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
        {tabs.map(({ key, label, Icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setView(key)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                active ? "bg-navy text-on-navy" : "text-muted hover:text-ink",
              )}
            >
              <Icon size={15} className="shrink-0" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="mt-5 space-y-6">{view === "operations" ? operations : systems}</div>
    </>
  );
}
