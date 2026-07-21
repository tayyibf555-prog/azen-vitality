import { ExternalLink, LayoutTemplate, Trophy } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { listPages } from "@/lib/landing/repository";
import { funnelVariantSummary, type FunnelVariantCounters } from "@/lib/funnel/events";
import { mintPreviewToken } from "@/lib/landing/preview-token";
import type { LandingPage, LandingPageStatus } from "@/lib/landing/types";
import {
  deriveLandingOverview,
  summariseLandingOverview,
  type LandingOverviewInput,
  type LandingPageOverview,
  type VariantStat,
} from "@/lib/landing/overview";

// GROWTH > Landing pages. The owner's place to PREVIEW every campaign landing page
// and read which is converting. Generation stays in the Meta Ads workspace (the
// co-pilot and that tab both POST /api/landing-pages); this section does not build
// pages, it watches them.
//
// SERVER component. It reads the page list and each page's per-variant funnel
// counters, mints any draft preview token, then hands everything to the pure
// deriveLandingOverview (which reuses the SHARED decideAutoPromotion for the winner
// marker). No client interactivity — the preview action is a plain new-tab link — so
// there is no RSC boundary to cross and no client bundle. Design language: hairlines,
// tint chips and numbers/tables only, never a chart.

export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // last 30 days, matching the results card + auto-promote sweep

const ZERO: FunnelVariantCounters = { views: 0, ctaClicks: 0, leads: 0 };

const STATUS_TONE: Record<LandingPageStatus, Tone> = {
  draft: "warning",
  live: "success",
  archived: "neutral",
};

const STATUS_LABEL: Record<LandingPageStatus, string> = {
  draft: "Draft",
  live: "Live",
  archived: "Archived",
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Server load: page list (site-scoped) + each page's own A/B counters + draft token. */
async function loadOverview(
  clientId: string,
  clientSlug: string,
  siteIds: string[],
  isAllSites: boolean,
): Promise<LandingPageOverview[]> {
  let pages: LandingPage[] = [];
  try {
    pages = await listPages(clientId);
  } catch {
    pages = []; // no DB / no key in this environment: degrade to the empty state
  }

  // Honour the top-bar site selection: a site-scoped page shows only under its own
  // site (or "All sites"); a page with no site (null) always shows.
  const scoped = pages.filter((p) => isAllSites || p.siteId === null || siteIds.includes(p.siteId));

  const now = Date.now();
  const fromIso = new Date(now - WINDOW_MS).toISOString();
  const toIso = new Date(now).toISOString();

  const items: LandingOverviewInput[] = await Promise.all(
    scoped.map(async (page) => {
      let summary = { a: ZERO, b: ZERO };
      try {
        summary = await funnelVariantSummary({
          clientId,
          surface: "landing",
          fromIso,
          toIso,
          landingSlug: page.slug,
        });
      } catch {
        // Keep zeros for this page: a summary error must not blank the whole section.
      }
      const previewToken = page.status === "draft" ? mintPreviewToken(page.id) : null;
      return { page, summary, previewToken };
    }),
  );

  return deriveLandingOverview({
    clientSlug,
    items,
    treatmentName: (key) => TREATMENTS.find((t) => t.key === key)?.name ?? key,
  });
}

export async function LandingPagesView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Landing pages" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);
  const rows = await loadOverview(client.id, clientSlug, scope.siteIds, scope.isAllSites);
  const totals = summariseLandingOverview(rows);

  return (
    <>
      <PageHeader
        title="Landing pages"
        description={`Preview every campaign landing page and see which is converting, for ${scope.label}. Performance covers the last 30 days.`}
        stats={
          <>
            <StatCard label="Pages" value={totals.pages} dot="bg-status-blue" />
            <StatCard label="Live" value={totals.live} dot="bg-status-green" />
            <StatCard label="Views (30d)" value={totals.totalViews} dot="bg-line-strong" />
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No landing pages yet"
          description={
            scope.isAllSites
              ? "Campaign landing pages are created in Meta Ads, under the Landing pages tab. Once you generate one, preview it and watch its performance here."
              : `No landing pages for ${scope.label} yet. Create one in Meta Ads (Landing pages tab), or switch the site selector to see pages from another site.`
          }
        />
      ) : (
        <SectionCard
          title="Your landing pages"
          description="Ranked so the best-performing live pages come first. Preview any page in a new tab; drafts open with a private preview link."
        >
          <ul className="space-y-3">
            {rows.map((row) => (
              <PageCard key={row.page.id} row={row} />
            ))}
          </ul>
        </SectionCard>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------- */

function PageCard({ row }: { row: LandingPageOverview }) {
  const { page } = row;
  return (
    <li className="rounded-[10px] border border-line bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-navy">{row.treatmentName}</span>
            <StatusPill tone={STATUS_TONE[page.status]}>{STATUS_LABEL[page.status]}</StatusPill>
            {page.winnerVariant ? (
              <StatusPill tone="info">
                <Trophy size={12} /> Winner {page.winnerVariant.toUpperCase()}
              </StatusPill>
            ) : null}
            {row.performingWell && !page.winnerVariant ? (
              <StatusPill tone="success">Performing well</StatusPill>
            ) : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted">{row.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="text-right">
            <div className="text-[22px] font-bold tabular-nums tracking-[-0.4px] text-navy">
              {row.totalViews.toLocaleString("en-GB")}
            </div>
            <p className="text-[11px] font-medium text-muted">Views (30d)</p>
          </div>
          {row.previewPath ? (
            <a
              href={row.previewPath}
              target="_blank"
              rel="noreferrer"
              className="pressable inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
            >
              <ExternalLink size={14} />
              {page.status === "draft" ? "Preview draft" : "Preview"}
            </a>
          ) : (
            <span className="text-xs text-faint">
              {page.status === "archived" ? "Archived" : "Preview unavailable"}
            </span>
          )}
        </div>
      </div>

      <VariantTable variants={row.variants} />

      <p className="mt-2.5 text-xs text-muted">
        {!row.hasData
          ? "No visits recorded yet. Numbers appear here as traffic reaches the page."
          : row.decision.promote
            ? row.decision.reason
            : `Not enough data to call a winner yet. ${row.decision.reason}`}
      </p>
    </li>
  );
}

function VariantTable({ variants }: { variants: { a: VariantStat; b: VariantStat } }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            {["Variant", "Views", "Clicks (rate)", "Leads (conv.)"].map((h, i) => (
              <th
                key={h}
                className={
                  "px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint " +
                  (i === 0 ? "text-left" : "text-right")
                }
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <VariantRow v={variants.a} />
          <VariantRow v={variants.b} />
        </tbody>
      </table>
    </div>
  );
}

function VariantRow({ v }: { v: VariantStat }) {
  return (
    <tr className={"border-b border-line last:border-0 " + (v.winning ? "bg-tint-blue/40" : "")}>
      <td className="px-3 py-2.5 text-ink">
        <span className="inline-flex items-center gap-2">
          <span className="font-semibold text-navy">Variant {v.key.toUpperCase()}</span>
          {v.winning ? (
            <StatusPill tone="info">
              <Trophy size={12} /> {v.promoted ? "Winner" : "Winning"}
            </StatusPill>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-ink">{v.views.toLocaleString("en-GB")}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-ink">
        {v.ctaClicks.toLocaleString("en-GB")}
        <span className="ml-1 text-faint">({pct(v.ctaRate)})</span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-ink">
        {v.leads.toLocaleString("en-GB")}
        <span className="ml-1 text-faint">({pct(v.leadRate)})</span>
      </td>
    </tr>
  );
}
