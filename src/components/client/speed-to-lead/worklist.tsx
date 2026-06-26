"use client";

import { useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { Lead, LeadStage } from "@/lib/types";
import { LeadDrawer } from "./lead-drawer";

const STAGE_TONE: Record<LeadStage, Tone> = {
  new: "info",
  contacted: "success",
  qualifying: "info",
  booked: "success",
  lost: "neutral",
};
const STAGE_LABEL: Record<LeadStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualifying: "Qualifying",
  booked: "Booked",
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

export function Worklist({ leads, nowIso }: { leads: Lead[]; nowIso: string }) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    { key: "name", header: "Name", cell: (l) => <span className="font-semibold text-navy">{l.name}</span> },
    {
      key: "interest",
      header: "Interest",
      cell: (l) => <span className="text-ink">{l.treatmentInterest || "General enquiry"}</span>,
    },
    { key: "source", header: "Source", cell: (l) => <span className="text-muted capitalize">{l.source}</span> },
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
        description="Every new enquiry, newest first. Uncontacted leads float to the top. Open one to mark its outcome or resend first contact."
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
                      ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
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
          getRowKey={(l) => l.id}
          onRowClick={(l) => setSelectedId(l.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different stage." className="m-4" />}
        />
      </SectionCard>

      {selected ? <LeadDrawer lead={selected} onClose={() => setSelectedId(null)} /> : null}
    </>
  );
}
