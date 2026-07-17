"use client";

import { useState } from "react";
import { LayoutGrid, PlusCircle, Images, BookOpen, ListChecks, LayoutTemplate } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Campaign, AdLibraryItem } from "@/lib/meta-ads/types";
import { MOCK_CAMPAIGNS } from "@/lib/meta-ads/mock";
import { findTreatment } from "@/lib/treatments/catalog";
import { LANDING_TREATMENT_KEYS } from "./landing-pages";
import { CampaignsTable } from "./campaigns-table";
import { CampaignBuilder } from "./campaign-builder";
import { AdLibrary } from "./ad-library";
import { LaunchGuide } from "./launch-guide";
import { LandingPagesTab } from "./landing-pages";

type TabKey = "campaigns" | "create" | "landing" | "library" | "guide";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "campaigns", label: "Campaigns", icon: LayoutGrid },
  { key: "create", label: "Create campaign", icon: PlusCircle },
  { key: "landing", label: "Landing pages", icon: LayoutTemplate },
  { key: "library", label: "Ad library", icon: Images },
  { key: "guide", label: "Guide", icon: BookOpen },
];

export function MetaAdsWorkspace({
  clientSlug,
  practiceName,
}: {
  clientSlug: string;
  practiceName: string;
}) {
  const [tab, setTab] = useState<TabKey>("campaigns");
  // Drafts the owner saves from the Create tab, newest first. Kept here so they
  // survive tab switches and show alongside the mock campaigns.
  const [drafts, setDrafts] = useState<Campaign[]>([]);
  // Treatment key seeded by "Recreate this" from the ad library, pre-selecting the
  // Landing pages generator. Cleared on any MANUAL tab click (see selectTab), so it
  // is only ever consumed by the one recreate navigation that set it.
  const [recreateTreatment, setRecreateTreatment] = useState<string | null>(null);

  const campaigns = [...drafts, ...MOCK_CAMPAIGNS];

  function handleSaveDraft(draft: Campaign) {
    setDrafts((prev) => [draft, ...prev]);
    setTab("campaigns");
  }

  // Manual navigation: clears any pending recreate seed so a hand-picked tab switch
  // never carries a stale pre-selection.
  function selectTab(next: TabKey) {
    setRecreateTreatment(null);
    setTab(next);
  }

  // "Recreate this" from a library creative: map its treatment to a supported
  // landing-page treatment key (when possible), seed it, and open the Landing tab.
  function handleRecreate(item: AdLibraryItem) {
    const matched = findTreatment(item.treatment);
    const key = matched && LANDING_TREATMENT_KEYS.includes(matched.key) ? matched.key : null;
    setRecreateTreatment(key);
    setTab("landing");
  }

  return (
    <div className="space-y-4">
      {/* Tab bar + the prominent step-by-step button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Meta Ads sections"
          className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
        >
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(key)}
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

        <button
          type="button"
          onClick={() => selectTab("guide")}
          className="pressable inline-flex items-center gap-2 rounded-lg border border-line-strong bg-card px-3.5 py-2 text-sm font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
        >
          <ListChecks size={16} className="text-muted" />
          How to launch (step by step)
        </button>
      </div>

      {/* Panels */}
      <div role="tabpanel">
        {tab === "campaigns" ? (
          <CampaignsTable campaigns={campaigns} onCreate={() => selectTab("create")} />
        ) : null}

        {tab === "create" ? (
          <CampaignBuilder
            clientSlug={clientSlug}
            practiceName={practiceName}
            onSaveDraft={handleSaveDraft}
            onOpenGuide={() => selectTab("guide")}
            onOpenLanding={() => selectTab("landing")}
          />
        ) : null}

        {tab === "landing" ? (
          <LandingPagesTab
            clientSlug={clientSlug}
            practiceName={practiceName}
            initialTreatment={recreateTreatment ?? undefined}
          />
        ) : null}

        {tab === "library" ? (
          <AdLibrary clientSlug={clientSlug} onRecreate={handleRecreate} />
        ) : null}

        {tab === "guide" ? <LaunchGuide /> : null}
      </div>
    </div>
  );
}
