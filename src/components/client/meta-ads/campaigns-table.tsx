"use client";

import { Megaphone, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import type { Campaign } from "@/lib/meta-ads/types";
import { budget, count, money, multiple, objectiveLabel, percent } from "./format";

const STATUS: Record<Campaign["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  learning: { label: "Learning", tone: "warning" },
  paused: { label: "Paused", tone: "neutral" },
  draft: { label: "Draft", tone: "info" },
};

// The publish lifecycle of a SAVED campaign against Meta, distinct from the analytics
// status above. Set by the publish adapter (co-pilot or the owner publish action):
//   ready     - assembled and ready, not yet pushed to Meta
//   published - created on Meta in PAUSED status (the client activates it in Ads Manager)
//   error     - a publish attempt failed; publishError carries the honest reason
// Empty for every campaign today (nothing publishes until the Meta account connects), so
// the table renders exactly as before until real publish state is threaded in.
export interface CampaignPublishState {
  state: "ready" | "published" | "error";
  publishedAt?: string | null;
  publishError?: string | null;
  /** The most recent insights snapshot, once the hourly sweep has captured any. */
  insight?: {
    spendGbp: number | null;
    impressions: number | null;
    clicks: number | null;
    leads: number | null;
  } | null;
}

const PUBLISH_STATUS: Record<CampaignPublishState["state"], { label: string; tone: Tone }> = {
  ready: { label: "Ready to publish", tone: "info" },
  published: { label: "Published (paused on Meta)", tone: "success" },
  error: { label: "Publish error", tone: "danger" },
};

/** True when an insights snapshot carries at least one captured figure. */
function hasInsightFigures(insight: CampaignPublishState["insight"]): boolean {
  return Boolean(
    insight &&
      (insight.spendGbp !== null ||
        insight.impressions !== null ||
        insight.clicks !== null ||
        insight.leads !== null),
  );
}

// One metric cell: a small label over a larger, tabular-aligned value.
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-navy">{value}</dd>
    </div>
  );
}

function CampaignRow({ campaign, publish }: { campaign: Campaign; publish?: CampaignPublishState }) {
  const s = STATUS[campaign.status];
  const m = campaign.metrics;
  const isDraft = campaign.status === "draft";
  const p = publish ? PUBLISH_STATUS[publish.state] : null;
  const insightFigures = hasInsightFigures(publish?.insight);

  return (
    <li className="border-b border-line py-4 first:pt-1 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-navy">{campaign.name}</span>
            {p ? <StatusPill tone={p.tone}>{p.label}</StatusPill> : <StatusPill tone={s.tone}>{s.label}</StatusPill>}
          </div>
          <p className="mt-1 text-xs text-muted">
            <span className="text-ink">{campaign.treatment}</span>
            <span className="px-1.5 text-line-strong">/</span>
            <span className="text-ink">{objectiveLabel(campaign.objective)}</span>
            <span className="px-1.5 text-line-strong">/</span>
            <span className="font-semibold tabular-nums text-ink">{budget(campaign.dailyBudgetGbp)}</span> a day
          </p>
        </div>
      </div>

      {/* Publish state (persisted campaigns) takes precedence over the analytics status.
          When Meta insights have been captured, they light the numbers; otherwise an
          honest one-line state. Falls back to the original draft/metrics rendering for
          campaigns with no publish state. */}
      {publish ? (
        insightFigures && publish.insight ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
            <Metric label="Spend" value={publish.insight.spendGbp === null ? "—" : money(publish.insight.spendGbp)} />
            <Metric label="Impressions" value={publish.insight.impressions === null ? "—" : count(publish.insight.impressions)} />
            <Metric label="Clicks" value={publish.insight.clicks === null ? "—" : count(publish.insight.clicks)} />
            <Metric label="Leads" value={publish.insight.leads === null ? "—" : count(publish.insight.leads)} />
          </dl>
        ) : (
          <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
            {publish.state === "published"
              ? "Created on Meta in paused status. Review and activate it in Ads Manager. Performance figures appear here once it starts delivering."
              : publish.state === "error"
                ? `Publishing to Meta did not complete${publish.publishError ? `: ${publish.publishError}` : "."} Nothing is live; it is still ready to retry.`
                : "Ready to publish to Meta."}
          </p>
        )
      ) : isDraft ? (
        <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
          Saved as a draft. Launch it in Meta to start collecting performance figures here.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Spend" value={money(m.spendGbp)} />
          <Metric label="Leads" value={count(m.leads)} />
          <Metric label="Cost / lead" value={money(m.cplGbp, true)} />
          <Metric label="Bookings" value={count(m.bookings)} />
          <Metric label="CTR" value={percent(m.ctr)} />
          <Metric label="Rough return" value={multiple(m.roughReturnX)} />
        </dl>
      )}
    </li>
  );
}

export function CampaignsTable({
  campaigns,
  metaConnected = false,
  publishStates,
  onCreate,
}: {
  campaigns: Campaign[];
  /** True only when the practice's Meta account is connected. Drives the honest
   *  caption about where live performance figures come from. */
  metaConnected?: boolean;
  /** Publish/insight state per campaign id, for campaigns pushed to Meta. Absent today
   *  (nothing publishes until the Meta account connects), so rows render unchanged. */
  publishStates?: Record<string, CampaignPublishState>;
  onCreate: () => void;
}) {
  return (
    <SectionCard
      title="Campaigns"
      description={
        metaConnected
          ? "Your live, learning and paused campaigns, plus any drafts you have saved. Performance figures cover the last 30 days."
          : "The campaigns you have drafted. Live performance figures appear here once your Meta account is connected."
      }
      actions={
        <Button variant="primary" size="sm" onClick={onCreate}>
          <Plus size={15} /> Create campaign
        </Button>
      }
    >
      {campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Start from a ready-made template, generate compliant ad copy, and save it as a draft. Your campaigns and their performance will appear here."
        >
          <Button variant="primary" size="sm" onClick={onCreate}>
            <Plus size={15} /> Create campaign
          </Button>
        </EmptyState>
      ) : (
        <ul>
          {campaigns.map((c) => (
            <CampaignRow key={c.id} campaign={c} publish={publishStates?.[c.id]} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
