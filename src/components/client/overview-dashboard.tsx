"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Flame, ListChecks, Inbox, Info } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  EmptyState,
  DataTable,
  type Column,
  type Tone,
} from "@/components/primitives";
import { getClient, getSite } from "@/lib/mock";
import type { Lead } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

// The owner's proof-of-value view: what is actually coming in and what work is in
// hand. The headline performance figures (leads over the month, bookings, revenue
// recovered, cost per booking) build from live activity and light up as the Meta
// and Dentally sources connect, so nothing here is invented: the enquiries and the
// open-task count are live, and the rest is presented as an honest awaiting state.
// Rendered standalone at /owner/[client]/overview and embedded as the owner band on
// the client Home page.

const NOW = new Date();

const STAGE_TONE: Record<Lead["stage"], Tone> = {
  new: "info",
  contacting: "info", // transient in-flight claim; display like 'new'
  contacted: "info",
  qualifying: "warning",
  booked: "success",
  nurture_done: "neutral", // full nurture ran, no reply; retired warm
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

export function OverviewDashboard({
  hideHero = false,
  siteIds,
}: {
  hideHero?: boolean;
  /** The dashboard's selected site(s) (default N15); omitted → all of the
   *  client's sites. Scopes the site list so the band never names other sites
   *  under a single-site header. */
  siteIds?: string[];
}) {
  const params = useParams<{ client: string }>();
  const client = getClient(params.client);

  // Live leads from Speed-to-lead (real enquiries arriving via intake / the quiz).
  // Never falls back to a fixture: an empty or errored fetch stays null and the
  // panel shows an honest empty state, so no invented enquiry ever renders.
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
        // Keep the empty state on error.
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

  // Scope the site list to the dashboard's selected site (default N15); omitted →
  // all of the client's sites.
  const scopedSiteIds = siteIds && siteIds.length ? siteIds : client.siteIds;
  const allSites = scopedSiteIds.length >= client.siteIds.length;
  const scopedSiteName = allSites ? null : getSite(scopedSiteIds[0])?.name ?? null;

  const leads = [...(liveLeads ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const hotCount = leads.filter((l) => l.assessmentScore !== null && l.assessmentScore >= 75).length;

  // Real, live figures only: the enquiries currently in the pipeline, the hottest of
  // them, and the open task count. Nothing here is a period estimate.
  const statFigures = (
    <>
      <StatCard label="Live enquiries" value={leads.length} dot="bg-status-blue" />
      <StatCard label="Hot leads" value={hotCount} dot="bg-status-green" />
      <StatCard label="Open tasks" value={openTasks ?? 0} dot="bg-status-amber" />
    </>
  );

  return (
    <>
      {hideHero ? null : (
        <PageHeader
          title="Overview"
          description={
            allSites
              ? "Your proof-of-value view: the enquiries coming in and the work in hand. Headline performance figures build as your live sources connect."
              : `${scopedSiteName}: the enquiries coming in and the work in hand. Headline performance figures build as your live sources connect.`
          }
          stats={statFigures}
        />
      )}

      {hideHero ? <div className="flex flex-wrap gap-x-7 gap-y-4">{statFigures}</div> : null}

      {/* Honest awaiting note: the funnel and revenue figures have no live source
          yet, so they are named here rather than invented. They light up the day the
          Meta (spend and leads) and Dentally (bookings and revenue) sources connect. */}
      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          Leads over the month, consultations booked, revenue recovered and cost per booking build
          from live activity and appear here as your Meta and Dentally sources connect. The
          enquiries and open tasks below are live now.
        </p>
      </div>

      <SectionCard
        title="Recent enquiries"
        description="Live enquiries arriving through intake and the smile assessment."
        bodyClassName="p-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        }
      >
        <div className="p-5">
          {leads.length > 0 ? (
            <DataTable columns={ENQUIRY_COLUMNS} rows={leads} getRowKey={(l) => l.id} maxRows={6} />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No live enquiries yet"
              description="New enquiries from intake and the smile assessment will appear here as they arrive."
            />
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Your sites"
        description="Per-site figures build from live activity."
      >
        <ul className="divide-y divide-line">
          {scopedSiteIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <span className="font-semibold text-navy">{getSite(id)?.name ?? id}</span>
              <span className="text-xs text-muted">Awaiting live data</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </>
  );
}
