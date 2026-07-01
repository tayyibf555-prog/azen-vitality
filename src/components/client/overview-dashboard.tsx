"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  TrendingUp,
  CalendarCheck,
  PoundSterling,
  Clock,
  Target,
  Flame,
  ListChecks,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  DataTable,
  BarChart,
  ProgressMeter,
  Tabs,
  type Column,
  type Tone,
} from "@/components/primitives";
import {
  getClient,
  getClientMetrics,
  getSite,
  getSiteMetrics,
  BRIEF_ITEMS,
  LEADS,
  NOW,
} from "@/lib/mock";
import type { BriefItem, Lead, SiteMetrics } from "@/lib/types";
import { gbp, compact, relativeTime, cn } from "@/lib/utils";

const PRIORITY_RANK: Record<BriefItem["priority"], number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_TONE: Record<BriefItem["priority"], Tone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};
const METRIC_LABEL: Record<BriefItem["metric"], string> = {
  bookings: "Bookings",
  revenue: "Revenue",
  time: "Time saved",
  risk: "Risk",
};
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

export function OverviewDashboard({ hideHero = false }: { hideHero?: boolean }) {
  const params = useParams<{ client: string }>();
  const client = getClient(params.client);

  // Live daily-brief headline. Computed on read by /api/daily-brief from the
  // real module repositories; falls back to the mock so the section never blanks.
  const [liveBrief, setLiveBrief] = useState<BriefItem[] | null>(null);
  useEffect(() => {
    let active = true;
    // Reset on client change so a switch never renders the previous client's
    // brief while the new fetch is in flight or if it errors (falls back to mock).
    setLiveBrief(null);
    if (!params.client) return;
    fetch(`/api/daily-brief?client=${encodeURIComponent(params.client)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("brief fetch failed"))))
      .then((j: { ok?: boolean; brief?: { headline?: BriefItem[] } }) => {
        if (active && j.ok && Array.isArray(j.brief?.headline)) {
          setLiveBrief(j.brief.headline);
        }
      })
      .catch(() => {
        // Network or server error: keep the mock fallback (liveBrief stays null).
      });
    return () => {
      active = false;
    };
  }, [params.client]);

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

  // Live open-task count from the Task queue (computed across every module). A
  // small "needs attention" line links straight into the worklist. Resets on
  // client change and falls back to nothing (null) on error so it never misleads.
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
  const siteMetrics = getSiteMetrics(client.siteIds);

  const totalLeads = siteMetrics.reduce((a, s) => a + s.leadsIn, 0);
  const totalBooked = siteMetrics.reduce((a, s) => a + s.consultationsBooked, 0);
  const avgCostPerBooking = siteMetrics.length
    ? Math.round(siteMetrics.reduce((a, s) => a + s.costPerBooking, 0) / siteMetrics.length)
    : 0;

  const briefSource = liveBrief ?? BRIEF_ITEMS;
  const briefs = [...briefSource]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    .slice(0, 5);

  const leads = [...(liveLeads ?? LEADS)].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const hotCount = leads.filter((l) => l.assessmentScore !== null && l.assessmentScore >= 75).length;

  return (
    <>
      {hideHero ? null : (
        <PageHeader
          hero
          title="Overview"
          description="Your live, cross-site view of the full funnel across all three practices, with the revenue and hours recovered."
        />
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          label="Leads in"
          value={compact(metrics?.leadsIn ?? totalLeads)}
          icon={TrendingUp}
          delta={{ value: 12, goodWhenUp: true }}
          hint="Across all sites, last 30 days"
        />
        <StatCard
          label="Consultations booked"
          value={compact(metrics?.consultationsBooked ?? totalBooked)}
          icon={CalendarCheck}
          delta={{ value: 9, goodWhenUp: true }}
        />
        <StatCard
          emphasis
          label="Revenue recovered"
          value={gbp(metrics?.recoveredRevenue ?? 0)}
          icon={PoundSterling}
          delta={{ value: 18, goodWhenUp: true }}
        />
        <StatCard
          label="Hours saved"
          value={`${metrics?.hoursSaved ?? 0}h`}
          icon={Clock}
          delta={{ value: 14, goodWhenUp: true }}
        />
        <StatCard
          label="Cost per booking"
          value={gbp(avgCostPerBooking)}
          icon={Target}
          delta={{ value: 6, goodWhenUp: false }}
          hint="Blended average"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Revenue recovered"
          description="Recovered revenue per week across all sites"
          className="lg:col-span-2"
        >
          {metrics ? (
            <BarChart data={metrics.trend} format={(v) => gbp(v)} height={200} />
          ) : (
            <p className="text-sm text-muted">No trend data yet.</p>
          )}
        </SectionCard>

        <SectionCard
          title="Today"
          description="Highest-priority actions right now"
        >
          <ul className="space-y-3">
            {briefs.map((b) => (
              <li key={b.id} className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    b.priority === "high"
                      ? "bg-danger"
                      : b.priority === "medium"
                        ? "bg-warning"
                        : "bg-line-strong",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug text-navy">{b.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{b.detail}</p>
                </div>
                <StatusPill tone={PRIORITY_TONE[b.priority]} className="shrink-0">
                  {METRIC_LABEL[b.metric]}
                </StatusPill>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <SectionCard
        title="Funnel detail"
        description="Recent enquiries and per-site performance across the funnel."
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
                <DataTable
                  columns={SITE_COLUMNS}
                  rows={siteMetrics}
                  getRowKey={(m) => m.siteId}
                />
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
