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
          className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-card p-1 shadow-[0_1px_2px_rgba(10,14,26,0.04)]"
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

        <button
          type="button"
          onClick={() => selectTab("guide")}
          className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-card px-3.5 py-2 text-sm font-semibold text-navy shadow-[0_1px_2px_rgba(10,14,26,0.04)] transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
        >
          <ListChecks size={16} className="text-blue-dark" />
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
