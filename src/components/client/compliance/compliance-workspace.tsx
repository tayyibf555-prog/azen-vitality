"use client";

import { useState } from "react";
import { Gauge, CalendarCheck, FileText, GraduationCap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReadinessPanel } from "./readiness-panel";
import { AuditsList } from "./audits-list";
import { PoliciesList } from "./policies-list";
import { TrainingMatrix } from "./training-matrix";

type TabKey = "readiness" | "audits" | "policies" | "training";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "readiness", label: "Readiness", icon: Gauge },
  { key: "audits", label: "Audits & checks", icon: CalendarCheck },
  { key: "policies", label: "Policies", icon: FileText },
  { key: "training", label: "Training", icon: GraduationCap },
];

// The Compliance workspace: a tabbed shell over the readiness view, the audit and
// check calendar, the policy library and the training matrix. All data is pulled
// from the pure lib layer inside the child panels, so this component just owns the
// active tab.
export function ComplianceWorkspace({ clientSlug }: { clientSlug: string }) {
  const [tab, setTab] = useState<TabKey>("readiness");

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Compliance sections"
        className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-card p-1"
      >
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`compliance-tab-${key}`}
              aria-selected={active}
              aria-controls={`compliance-panel-${key}`}
              onClick={() => setTab(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40",
                active
                  ? "bg-blue-dark/[0.08] text-blue-deep"
                  : "text-muted hover:bg-card-muted hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`compliance-panel-${tab}`}
        aria-labelledby={`compliance-tab-${tab}`}
      >
        {tab === "readiness" ? <ReadinessPanel clientSlug={clientSlug} /> : null}
        {tab === "audits" ? <AuditsList /> : null}
        {tab === "policies" ? <PoliciesList /> : null}
        {tab === "training" ? <TrainingMatrix /> : null}
      </div>
    </div>
  );
}
