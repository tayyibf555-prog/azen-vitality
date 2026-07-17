"use client";

import { useState } from "react";
import { Inbox, Wrench, Share2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SubmissionsWorklist } from "./submissions-worklist";
import { FormBuilder } from "./form-builder";
import { FormsPanel } from "./forms-panel";

// Tabbed onboarding workspace. Three tabs:
//   - Forms: owner-created onboarding forms, each a shareable /onboard/<client>/<slug>
//     link to send to patients (mirrors the Smile Assessment campaigns).
//   - Submissions: the staff worklist of completed onboarding forms.
//   - Form builder: pick the questions new patients answer, with a live phone preview.
// The tab bar mirrors the meta-ads / compliance workspaces (active = blue-deep pill,
// role=tablist/tab/tabpanel).

type TabKey = "forms" | "submissions" | "builder";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "forms", label: "Forms", icon: Share2 },
  { key: "submissions", label: "Submissions", icon: Inbox },
  { key: "builder", label: "Form builder", icon: Wrench },
];

export function OnboardingWorkspace({
  clientSlug,
  practiceName,
}: {
  clientSlug: string;
  practiceName: string;
}) {
  const [tab, setTab] = useState<TabKey>("forms");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Onboarding sections"
          className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
        >
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`onboarding-tab-${key}`}
                aria-selected={active}
                aria-controls={`onboarding-panel-${key}`}
                onClick={() => setTab(key)}
                className={cn(
                  "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                )}
              >
                <Icon size={15} />
                {label}
              </button>
            );
          })}
        </div>

        {tab !== "builder" ? (
          <button
            type="button"
            onClick={() => setTab("builder")}
            className="pressable inline-flex items-center gap-2 rounded-lg border border-line-strong bg-card px-3.5 py-2 text-sm font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            <Wrench size={16} className="text-muted" />
            Build form
          </button>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={`onboarding-panel-${tab}`}
        aria-labelledby={`onboarding-tab-${tab}`}
      >
        {tab === "forms" ? (
          <FormsPanel clientSlug={clientSlug} />
        ) : tab === "submissions" ? (
          <SubmissionsWorklist clientSlug={clientSlug} />
        ) : (
          <FormBuilder clientSlug={clientSlug} practiceName={practiceName} />
        )}
      </div>
    </div>
  );
}
