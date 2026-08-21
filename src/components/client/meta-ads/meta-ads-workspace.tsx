"use client";

import { useState } from "react";
import { LayoutGrid, PlusCircle, Images, BookOpen, ListChecks, LayoutTemplate, Radar } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Campaign } from "@/lib/meta-ads/types";
import type { StoredWinningAd } from "@/lib/meta-ads/winning-repository";
import { CampaignsTable, type CampaignPublishState } from "./campaigns-table";
import { CampaignBuilder } from "./campaign-builder";
import { AdLibrary } from "./ad-library";
import { LaunchGuide } from "./launch-guide";
import { LandingPagesTab } from "./landing-pages";
import { TrackingPanel } from "./tracking-panel";

type TabKey = "campaigns" | "create" | "landing" | "library" | "tracking" | "guide";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "campaigns", label: "Campaigns", icon: LayoutGrid },
  { key: "create", label: "Create campaign", icon: PlusCircle },
  { key: "landing", label: "Landing pages", icon: LayoutTemplate },
  { key: "library", label: "Ad library", icon: Images },
  // TRACKING lives here rather than in Settings because it is a decision about
  // this practice's ADVERTISING: the pixel it reports to is the one behind the
  // campaigns built two tabs to the left, and an owner setting up ads should not
  // have to know that "measurement" is filed somewhere else.
  { key: "tracking", label: "Tracking", icon: Radar },
  { key: "guide", label: "Guide", icon: BookOpen },
];

export function MetaAdsWorkspace({
  clientSlug,
  practiceName,
  metaConnected = false,
  publishStates,
  winningAds = [],
  imageGenConfigured = false,
}: {
  clientSlug: string;
  practiceName: string;
  /** True only when the practice's Meta account is connected. Until then there are
   *  no live campaigns to show, so the table carries the owner's own drafts only. */
  metaConnected?: boolean;
  /** Publish/insight state per saved campaign id, for campaigns pushed to Meta. Absent
   *  until the Meta account connects and something publishes; drives the honest publish
   *  status and the insight numbers on each campaign row. */
  publishStates?: Record<string, CampaignPublishState>;
  /** The ranked winning-ads library, read server-side from the real store. Empty when
   *  ingest has not run; the Ad library tab then shows an honest empty state, never
   *  fabricated samples. */
  winningAds?: StoredWinningAd[];
  /** True only when the SERVER holds an image key (resolved in MetaAdsView). Drives
   *  the honest "copy only, no creative" note on the recreate button. */
  imageGenConfigured?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("campaigns");
  // Drafts the owner saves from the Create tab, newest first. Kept here so they
  // survive tab switches.
  const [drafts, setDrafts] = useState<Campaign[]>([]);

  // The owner's own drafts, plus live campaigns once the Meta account is connected.
  // No fabricated campaigns: when Meta is not connected there is nothing live to add,
  // so the table shows the drafts (or its empty state) and never invented spend.
  // Live campaigns wire in here when the Meta adapter lands.
  const campaigns = [...drafts];

  function handleSaveDraft(draft: Campaign) {
    setDrafts((prev) => [draft, ...prev]);
    setTab("campaigns");
  }

  function selectTab(next: TabKey) {
    setTab(next);
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
          <CampaignsTable
            campaigns={campaigns}
            metaConnected={metaConnected}
            publishStates={publishStates}
            onCreate={() => selectTab("create")}
          />
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
          <LandingPagesTab clientSlug={clientSlug} practiceName={practiceName} />
        ) : null}

        {tab === "library" ? (
          <AdLibrary
            winningAds={winningAds}
            clientSlug={clientSlug}
            imageGenConfigured={imageGenConfigured}
            // A recreate lands a DRAFT server-side; adding it here is only so the
            // Campaigns tab reflects it without a reload. It stays a draft.
            onRecreated={(draft) => setDrafts((prev) => [draft, ...prev])}
            onOpenDrafts={() => selectTab("campaigns")}
          />
        ) : null}

        {tab === "tracking" ? <TrackingPanel clientSlug={clientSlug} /> : null}

        {tab === "guide" ? <LaunchGuide /> : null}
      </div>
    </div>
  );
}
