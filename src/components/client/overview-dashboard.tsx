"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  TrendingUp,
  CalendarCheck,
  PoundSterling,
  Target,
  Flame,
  ListChecks,
  ShieldAlert,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  SampleBadge,
  SampleNote,
  DataTable,
  BarChart,
  ProgressMeter,
  Tabs,
  type Column,
  type Tone,
} from "@/components/primitives";
import { getClient, getClientMetrics, getSite, getSiteMetrics, LEADS, NOW } from "@/lib/mock";
import type { Lead, SiteMetrics } from "@/lib/types";
import { gbp, compact, relativeTime } from "@/lib/utils";

// The owner's proof-of-value view: is the platform paying off, and is any site
// off target. Rendered standalone at /owner/[client]/overview and embedded as the
// owner-only band on the client Home page. Every figure is computed or mock-
// labelled — NEVER a hardcoded delta (an invented +12% an owner can falsify
// against Dentally poisons trust in every real number).

const STAGE_TONE: Record<Lead["stage"], Tone> = {
  new: "info",
  contacting: "info", // transient in-flight claim; display like 'new'
  contacted: "info",
  qualifying: "warning",
  booked: "success",
  lost: "neutral",
};

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 75) return "success";
  if (score >= 50) return "warning";
  return "neutral";
}

function speedCell(seconds: number | null) {
  if (seconds === null) return <StatusPill tone="danger">No response</StatusPill>;
  const tone: Tone = seconds <= 30 ? "success" : seconds <= 120 ? "warning" : "danger";
  const label = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

const ENQUIRY_COLUMNS: Column<Lead>[] = [
  {
    key: "name",
    header: "Enquiry",
    cell: (l) => (
      <div>
        <span className="font-semibold text-navy">{l.name}</span>
        <span className="block text-xs text-muted">{getSite(l.siteId)?.name ?? l.siteId}</span>
      </div>
    ),
  },
  { key: "interest", header: "Interest", cell: (l) => l.treatmentInterest },
  {
    key: "score",
    header: "Assessment",
    cell: (l) => (
      <StatusPill tone={scoreTone(l.assessmentScore)}>
        {l.assessmentScore === null ? "Not scored" : l.assessmentScore}
      </StatusPill>
    ),
  },
  { key: "source", header: "Source", cell: (l) => <span className="text-muted">{l.source}</span> },
  { key: "speed", header: "Speed-to-lead", cell: (l) => speedCell(l.firstResponseSeconds) },
  {
    key: "stage",
    header: "Stage",
    cell: (l) => (
      <StatusPill tone={STAGE_TONE[l.stage]} className="capitalize">
        {l.stage}
      </StatusPill>
    ),
  },
  {
    key: "when",
    header: "When",
    cell: (l) => <span className="text-muted">{relativeTime(l.createdAt, NOW)}</span>,
    align: "right",
  },
];

const SITE_COLUMNS: Column<SiteMetrics>[] = [
  {
    key: "site",
    header: "Site",
    cell: (m) => <span className="font-semibold text-navy">{getSite(m.siteId)?.name ?? m.siteId}</span>,
  },
  { key: "leads", header: "Leads in", cell: (m) => compact(m.leadsIn), align: "right" },
  { key: "booked", header: "Booked", cell: (m) => compact(m.consultationsBooked), align: "right" },
  { key: "cpb", header: "Cost / booking", cell: (m) => gbp(m.costPerBooking), align: "right" },
  {
    key: "recall",
    header: "Recall recovery",
    cell: (m) => (
      <div className="flex items-center justify-end gap-2">
        <ProgressMeter value={m.recallRecoveryRate} className="w-20" />
        <span className="w-9 text-right tabular-nums">{Math.round(m.recallRecoveryRate * 100)}%</span>
      </div>
    ),
    align: "right",
  },
  {
    key: "treatment",
    header: "Treatment recovery",
    cell: (m) => <span className="tabular-nums">{Math.round(m.treatmentRecoveryRate * 100)}%</span>,
    align: "right",
  },
  {
    key: "noshow",
    header: "No-show",
    cell: (m) => (
      <StatusPill tone={m.noShowRate > 0.13 ? "danger" : m.noShowRate > 0.1 ? "warning" : "success"}>
        {Math.round(m.noShowRate * 100)}%
      </StatusPill>
    ),
    align: "right",
  },
  {
    key: "revenue",
    header: "Revenue recovered",
    cell: (m) => <span className="font-semibold text-navy tabular-nums">{gbp(m.recoveredRevenue)}</span>,
    align: "right",
  },
];

// Exception thresholds for the by-site strip: only sites breaching these speak.
// Pilot values — tune with the practice once real Dentally data flows.
const NOSHOW_MAX = 0.13;
const RECALL_MIN = 0.45;

export function OverviewDashboard({
  hideHero = false,
  variant = "standalone",
  siteIds,
}: {
  hideHero?: boolean;
  /** "embedded" = the owner band on Home: revenue lives in the Home header card,
   *  so the emphasised stat is dropped to avoid saying the same number twice. */
  variant?: "standalone" | "embedded";
  /** The dashboard's selected site(s) (default N15); omitted → all of the
   *  client's sites. Scopes the by-site breakdown so the band never names other
   *  sites under a single-site header. */
  siteIds?: string[];
}) {
  const params = useParams<{ client: string }>();
  const client = getClient(params.client);

  // Live leads from Speed-to-lead (real enquiries arriving via intake / the quiz),
  // so the "Recent enquiries" panel reflects what is actually coming in. Falls
  // back to the mock when empty/erroring so the panel never blanks.
  const [liveLeads, setLiveLeads] = useState<Lead[] | null>(null);
  useEffect(() => {
    let active = true;
    setLiveLeads(null);
    if (!params.client) return;
    fetch(`/api/speed-to-lead/list?client=${encodeURIComponent(params.client)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("leads fetch failed"))))
      .then((j: { ok?: boolean; leads?: Lead[] }) => {
        if (active && j.ok && Array.isArray(j.leads) && j.leads.length > 0) {
          setLiveLeads(j.leads);
        }
      })
      .catch(() => {
        // Keep the mock fallback on error.
      });
    return () => {
      active = false;
    };
  }, [params.client]);

  // Live open-task count from the Task queue, linking into the worklist.
  const [openTasks, setOpenTasks] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setOpenTasks(null);
    if (!params.client) return;
    fetch(`/api/task-queue/list?client=${encodeURIComponent(params.client)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("tasks fetch failed"))))
      .then((j: { ok?: boolean; counts?: { total?: number } }) => {
        if (active && j.ok && typeof j.counts?.total === "number") {
          setOpenTasks(j.counts.total);
        }
      })
      .catch(() => {
        // Keep nothing on error.
      });
    return () => {
      active = false;
    };
  }, [params.client]);

  if (!client) {
    return <PageHeader title="Overview" description="This client could not be found." />;
  }

  const metrics = getClientMetrics(client.id);
  // Scope the band to the dashboard's selected site (default N15); omitted → all
  // sites. When a single site is selected the by-site breakdown, exceptions and
  // headline totals all derive from that site, so nothing contradicts the header.
  const scopedSiteIds = siteIds && siteIds.length ? siteIds : client.siteIds;
  const allSites = scopedSiteIds.length >= client.siteIds.length;
  // Copy-ready name of the single selected site (null when All sites), so hints
  // and subtitles name the site instead of claiming an all-sites scope.
  const scopedSiteName = allSites ? null : getSite(scopedSiteIds[0])?.name ?? null;
  const siteMetrics = getSiteMetrics(scopedSiteIds);

  const totalLeads = siteMetrics.reduce((a, s) => a + s.leadsIn, 0);
  const totalBooked = siteMetrics.reduce((a, s) => a + s.consultationsBooked, 0);
  const totalRevenue = siteMetrics.reduce((a, s) => a + s.recoveredRevenue, 0);
  const avgCostPerBooking = siteMetrics.length
    ? Math.round(siteMetrics.reduce((a, s) => a + s.costPerBooking, 0) / siteMetrics.length)
    : 0;

  // The weekly revenue trend is only held practice-wide; when a single site is
  // selected, scale it by that site's share of recovered revenue so the chart
  // matches the scoped figures rather than showing the whole group.
  const clientRevenue = metrics?.recoveredRevenue ?? 0;
  const revenueShare = allSites || clientRevenue <= 0 ? 1 : totalRevenue / clientRevenue;
  const trend = (metrics?.trend ?? []).map((t) => ({ ...t, value: Math.round(t.value * revenueShare) }));

  const leads = [...(liveLeads ?? LEADS)].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const hotCount = leads.filter((l) => l.assessmentScore !== null && l.assessmentScore >= 75).length;

  // Exceptions only: silence means on target.
  const exceptions = siteMetrics
    .map((m) => {
      const breaches: string[] = [];
      if (m.noShowRate > NOSHOW_MAX)
        breaches.push(`No-shows ${Math.round(m.noShowRate * 100)}% (target under ${Math.round(NOSHOW_MAX * 100)}%)`);
      if (m.recallRecoveryRate < RECALL_MIN)
        breaches.push(
          `Recall recovery ${Math.round(m.recallRecoveryRate * 100)}% (target over ${Math.round(RECALL_MIN * 100)}%)`,
        );
      return { site: getSite(m.siteId)?.name ?? m.siteId, breaches };
    })
    .filter((e) => e.breaches.length > 0);

  return (
    <>
      {hideHero ? null : (
        <PageHeader
          hero
          title="Overview"
          description={
            allSites
              ? "Your cross-site view of the funnel: what came in, what was booked, and the revenue recovered."
              : `${scopedSiteName}: what came in, what was booked, and the revenue recovered.`
          }
        />
      )}

      {/* One section-level note covers every figure below: the KPI cards, the
          weekly revenue chart and the by-site table are all sample until the live
          sources connect. Kept lightweight per-card via the "Sample" hints too. */}
      <SampleNote>Sample data, not yet from your live sources. These figures are for the pilot only.</SampleNote>

      <div className={variant === "embedded" ? "grid grid-cols-3 gap-4" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
        <StatCard
          label="Leads in"
          value={compact(allSites ? (metrics?.leadsIn ?? totalLeads) : totalLeads)}
          icon={TrendingUp}
          hint={`Sample · ${allSites ? "across all sites, last 30 days" : `${scopedSiteName}, last 30 days`}`}
        />
        <StatCard
          label="Consultations booked"
          value={compact(allSites ? (metrics?.consultationsBooked ?? totalBooked) : totalBooked)}
          icon={CalendarCheck}
          hint="Sample figure"
        />
        {variant === "standalone" ? (
          <StatCard
            emphasis
            label="Revenue recovered"
            value={gbp(allSites ? (metrics?.recoveredRevenue ?? totalRevenue) : totalRevenue)}
            icon={PoundSterling}
            hint="Sample until live data connects"
          />
        ) : null}
        <StatCard
          label="Cost per booking"
          value={gbp(avgCostPerBooking)}
          icon={Target}
          hint="Sample · blended average"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Revenue recovered"
          description={allSites ? "Recovered revenue per week across all sites" : `Recovered revenue per week at ${scopedSiteName}`}
          className="lg:col-span-2"
          actions={<SampleBadge />}
        >
          {trend.length > 0 ? (
            <BarChart data={trend} format={(v) => gbp(v)} height={200} />
          ) : (
            <p className="text-sm text-muted">No trend data yet.</p>
          )}
        </SectionCard>

        <SectionCard
          title="By site"
          description="Exceptions only. Silence means on target."
        >
          {exceptions.length === 0 ? (
            <p className="text-sm text-muted">
              {allSites ? "All sites on target this month." : `${scopedSiteName} on target this month.`}
            </p>
          ) : (
            <ul className="space-y-2.5">
              {exceptions.map((e) => (
                <li key={e.site} className="rounded-xl bg-warning/10 px-3.5 py-2.5">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                    <ShieldAlert size={14} className="shrink-0" />
                    {e.site}
                  </p>
                  <p className="mt-0.5 text-xs text-warning/90">{e.breaches.join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">
            Full breakdown in the By site tab below.
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title="Funnel detail"
        description={
          allSites
            ? "Recent enquiries and per-site performance across the funnel."
            : `Recent enquiries and ${scopedSiteName} performance across the funnel.`
        }
        bodyClassName="p-0"
      >
        <Tabs
          className="p-5"
          tabs={[
            {
              key: "enquiries",
              label: "Recent enquiries",
              content: (
                <DataTable
                  columns={ENQUIRY_COLUMNS}
                  rows={leads}
                  getRowKey={(l) => l.id}
                  maxRows={6}
                />
              ),
            },
            {
              key: "site",
              label: "By site",
              content: (
                // The by-site table is all sample; the sibling "Recent enquiries"
                // tab is LIVE, so the caption is scoped to this tab only.
                <div className="space-y-3">
                  <SampleNote>Sample data, not yet from your live sources.</SampleNote>
                  <DataTable
                    columns={SITE_COLUMNS}
                    rows={siteMetrics}
                    getRowKey={(m) => m.siteId}
                  />
                </div>
              ),
            },
          ]}
          actions={
            <>
              <StatusPill tone="success">
                <Flame size={12} />
                {hotCount} hot
              </StatusPill>
              {openTasks && openTasks > 0 ? (
                <a
                  href={`/c/${client.slug}/task-queue`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-blue-dark/20 bg-blue-dark/10 px-2.5 py-0.5 text-xs font-semibold text-blue-dark transition-colors hover:bg-blue-dark/15"
                >
                  <ListChecks size={12} />
                  {openTasks} {openTasks === 1 ? "task needs attention" : "tasks need attention"}
                </a>
              ) : null}
            </>
          }
        />
      </SectionCard>
    </>
  );
}
