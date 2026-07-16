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
          className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-card p-1 shadow-[0_1px_2px_rgba(10,14,26,0.04)]"
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

        {tab !== "builder" ? (
          <button
            type="button"
            onClick={() => setTab("builder")}
            className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-card px-3.5 py-2 text-sm font-semibold text-navy shadow-[0_1px_2px_rgba(10,14,26,0.04)] transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
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
