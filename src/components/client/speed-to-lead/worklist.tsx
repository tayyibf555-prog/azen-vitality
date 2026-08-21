"use client";

import { useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { Lead, LeadStage } from "@/lib/types";
import { sourceLabel } from "@/lib/speed-to-lead/source-label";
import { funnelProgressLabel } from "@/lib/smile-assessment/funnel-progress";
import { LeadDrawer } from "./lead-drawer";

/**
 * The funnel sub-line's ink, by tone. A table cell is the wrong place for a pill —
 * eight rows of them turn the Source column into a wall of badges — so the
 * indicator is one small line of coloured text under the source it belongs to, and
 * the drawer carries the full sentence.
 *
 * The amber is the same literal the drawer already uses for warning copy: there is
 * no `text-warning` token in this palette, and inventing one for this line would
 * put a ninth amber in the app.
 */
const FUNNEL_INK: Record<"success" | "warning" | "info", string> = {
  success: "text-success",
  warning: "text-[#9a6700]",
  info: "text-muted",
};

const STAGE_TONE: Record<LeadStage, Tone> = {
  new: "info",
  contacting: "info", // transient in-flight claim; display like 'new'
  contacted: "success",
  qualifying: "info",
  booked: "success",
  nurture_done: "neutral", // full nurture ran, no reply
  lost: "neutral",
};
const STAGE_LABEL: Record<LeadStage, string> = {
  new: "New",
  contacting: "New", // transient; reads as still-new to staff
  contacted: "Contacted",
  qualifying: "Qualifying",
  booked: "Booked",
  nurture_done: "Nurtured",
  lost: "Lost",
};

const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
};

/** Relative "time ago" for an ISO timestamp, against now. */
function ago(iso: string, nowIso: string): string {
  const ms = new Date(nowIso).getTime() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** SLA pill: <=30s success, <=120s warning, contacted-but-slower danger, none = danger "No response". */
function SlaPill({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <StatusPill tone="danger">No response</StatusPill>;
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const tone: Tone = seconds <= 30 ? "success" : seconds <= 120 ? "warning" : "danger";
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

type FilterValue = "all" | "new" | "contacted" | "booked" | "lost";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "booked", label: "Booked" },
  { value: "lost", label: "Lost" },
];

export function Worklist({
  leads,
  nowIso,
  doNotContactLeadIds = [],
}: {
  leads: Lead[];
  nowIso: string;
  /** Lead ids whose linked patient is marked do_not_contact - flagged for staff review
   *  before acting. Resolved server-side by the lead's own linked patient id. */
  doNotContactLeadIds?: string[];
}) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dncSet = useMemo(() => new Set(doNotContactLeadIds), [doNotContactLeadIds]);

  // Newest first; uncontacted leads float to the top so the team sees the race.
  const ranked = useMemo(
    () =>
      [...leads].sort((a, b) => {
        const aNew = a.firstResponseSeconds === null ? 1 : 0;
        const bNew = b.firstResponseSeconds === null ? 1 : 0;
        if (aNew !== bNew) return bNew - aNew;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    [leads],
  );

  const rows = useMemo(() => {
    if (filter === "all") return ranked;
    if (filter === "contacted") return ranked.filter((l) => l.stage === "contacted" || l.stage === "qualifying");
    return ranked.filter((l) => l.stage === filter);
  }, [ranked, filter]);

  const selected = useMemo(() => leads.find((l) => l.id === selectedId) ?? null, [leads, selectedId]);

  const columns: Column<Lead>[] = [
    {
      key: "name",
      header: "Name",
      cell: (l) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-navy">{l.name}</span>
          {dncSet.has(l.id) ? <StatusPill tone="danger">Marked do not contact</StatusPill> : null}
        </span>
      ),
    },
    {
      key: "interest",
      header: "Interest",
      cell: (l) => <span className="text-ink">{l.treatmentInterest || "General enquiry"}</span>,
    },
    {
      key: "source",
      header: "Source",
      // The funnel indicator folds in HERE rather than into a column of its own:
      // it is a fact about the source (only a Smile Assessment funnel has one), it
      // is absent for most leads, and a ninth column would cost every row width for
      // a cell that is usually empty. sourceLabel is untouched — the sub-line is a
      // second line, never a change to the label's own words.
      cell: (l) => {
        const funnel = l.funnelProgress ? funnelProgressLabel(l.funnelProgress, nowIso) : null;
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-muted">{sourceLabel(l.source)}</span>
            {funnel ? (
              <span className={cn("mt-0.5 text-xs font-semibold", FUNNEL_INK[funnel.tone])}>
                {funnel.short}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "score",
      header: "Score",
      cell: (l) =>
        l.assessmentScore !== null ? (
          <span className="font-semibold tabular-nums text-ink">{l.assessmentScore}</span>
        ) : (
          <span className="text-muted">Direct enquiry</span>
        ),
    },
    {
      key: "channel",
      header: "Channel",
      cell: (l) => <span className="text-muted">{CHANNEL_LABEL[l.channel] ?? l.channel}</span>,
    },
    { key: "created", header: "Enquired", cell: (l) => <span className="text-muted">{ago(l.createdAt, nowIso)}</span> },
    {
      key: "sla",
      header: "First response",
      cell: (l) => <SlaPill seconds={l.firstResponseSeconds} />,
    },
    {
      key: "stage",
      header: "Stage",
      cell: (l) => <StatusPill tone={STAGE_TONE[l.stage]}>{STAGE_LABEL[l.stage]}</StatusPill>,
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="Enquiries"
        description="Every new enquiry, newest first, with uncontacted leads floated to the top."
        actions={
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-muted" />
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                    filter === f.value
                      ? "border-blue-dark/30 bg-[#f0f4f9] text-side-ink"
                      : "border-line-strong bg-card text-muted hover:bg-card-muted",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          maxRows={8}
          getRowKey={(l) => l.id}
          onRowClick={(l) => setSelectedId(l.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different stage." className="m-4" />}
        />
      </SectionCard>

      {/* The SAME `nowIso` the rows are rendered against, deliberately: the quiet
          period is computed at display time, and a drawer using its own clock could
          call a lead "abandoned" while the row behind it still said "not finished
          yet" — one lead, two sentences, on the same screen. */}
      {selected ? (
        <LeadDrawer lead={selected} nowIso={nowIso} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}
