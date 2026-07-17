"use client";

import { useState } from "react";
import { Inbox, Sliders, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/primitives";
import { ResponsesTable } from "./responses-table";
import { CampaignsPanel } from "./campaigns-panel";
import type { AssessmentResponse } from "@/lib/smile-assessment/types";

// Tabbed Smile Assessment workspace. Two tabs, one panel at a time, so reading
// submissions and managing assessment campaigns no longer stack full-width in the
// same scroll (mirrors the onboarding / meta-ads workspaces: active = blue-deep
// pill, role=tablist/tab/tabpanel).
//   - Submissions (default): every quiz submission, or the empty state.
//   - Assessments: the create-form plus the shareable per-campaign links.
// All data-fetching stays in the async SmileAssessmentView server component; this
// client wrapper only owns which panel is visible.

type TabKey = "submissions" | "assessments";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "submissions", label: "Submissions", icon: Inbox },
  { key: "assessments", label: "Assessments", icon: Sliders },
];

export function SmileAssessmentWorkspace({
  clientSlug,
  responses,
  nowIso,
}: {
  clientSlug: string;
  responses: AssessmentResponse[];
  nowIso: string;
}) {
  const [tab, setTab] = useState<TabKey>("submissions");

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Smile Assessment sections"
        className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
      >
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`smile-tab-${key}`}
              aria-selected={active}
              aria-controls={`smile-panel-${key}`}
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

      <div role="tabpanel" id={`smile-panel-${tab}`} aria-labelledby={`smile-tab-${tab}`}>
        {tab === "submissions" ? (
          responses.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No assessments yet"
              description="Embed the quiz on the practice website and link it to /assess. Submissions POST to the public endpoint and appear here the instant they land, with high scorers already contacted. This view is mock safe, so it stays empty until a submission arrives."
            />
          ) : (
            <ResponsesTable responses={responses} nowIso={nowIso} />
          )
        ) : (
          <CampaignsPanel clientSlug={clientSlug} />
        )}
      </div>
    </div>
  );
}
