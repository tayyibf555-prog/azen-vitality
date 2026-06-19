"use client";

import { useMemo, useState } from "react";
import {
  SectionCard,
  StatusPill,
  DataTable,
  EmptyState,
  type Column,
  type Tone,
} from "@/components/primitives";
import { cn, gbp, relativeTime } from "@/lib/utils";
import { Filter } from "lucide-react";
import type { OpportunityStatus, TreatmentOpportunity } from "@/lib/coordinator/types";
import { OpportunityDrawer } from "./opportunity-drawer";

const DAY = 86_400_000;

const STATUS_TONE: Record<OpportunityStatus, Tone> = {
  stalled: "warning",
  accepted: "info",
  in_progress: "neutral",
  completed: "success",
};

const STATUS_LABEL: Record<OpportunityStatus, string> = {
  stalled: "Stalled",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
};

type FilterValue = "all" | OpportunityStatus;

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "accepted", label: "Accepted" },
  { value: "stalled", label: "Stalled" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

function daysStalled(acceptedAt: string, now: Date): number {
  if (!acceptedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(acceptedAt).getTime()) / DAY));
}

export function Worklist({
  opportunities,
  nowIso,
}: {
  opportunities: TreatmentOpportunity[];
  nowIso: string;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Server already ranks by priorityScore desc. Keep a stable, defensive sort.
  const ranked = useMemo(
    () => [...opportunities].sort((a, b) => b.priorityScore - a.priorityScore),
    [opportunities],
  );

  const rows = useMemo(
    () => (filter === "all" ? ranked : ranked.filter((o) => o.status === filter)),
    [ranked, filter],
  );

  const rankByIndex = useMemo(() => {
    const map = new Map<string, number>();
    ranked.forEach((o, i) => map.set(o.id, i + 1));
    return map;
  }, [ranked]);

  const selected = useMemo(
    () => opportunities.find((o) => o.id === selectedId) ?? null,
    [opportunities, selectedId],
  );

  const columns: Column<TreatmentOpportunity>[] = [
    {
      key: "rank",
      header: "#",
      cell: (o) => <span className="font-semibold text-muted tabular-nums">{rankByIndex.get(o.id)}</span>,
      className: "w-10",
    },
    {
      key: "patient",
      header: "Patient",
      cell: (o) => <span className="font-semibold text-navy">{o.patientName}</span>,
    },
    {
      key: "treatment",
      header: "Treatment",
      cell: (o) => <span className="text-ink">{o.treatment}</span>,
    },
    {
      key: "planned",
      header: "Planned",
      cell: (o) => <span className="tabular-nums">{gbp(o.plannedValue)}</span>,
      align: "right",
    },
    {
      key: "outstanding",
      header: "Outstanding",
      cell: (o) => (
        <span className="font-semibold text-navy tabular-nums">{gbp(o.amountOutstanding)}</span>
      ),
      align: "right",
    },
    {
      key: "stalled",
      header: "Days stalled",
      cell: (o) => <span className="tabular-nums text-muted">{daysStalled(o.acceptedAt, now)}</span>,
      align: "right",
    },
    {
      key: "lastTouch",
      header: "Last touch",
      cell: (o) => (
        <span className="text-muted">
          {o.lastTouchAt ? relativeTime(o.lastTouchAt, now) : "Never"}
        </span>
      ),
      align: "right",
    },
    {
      key: "status",
      header: "Status",
      cell: (o) => (
        <StatusPill tone={STATUS_TONE[o.status] ?? "neutral"}>
          {STATUS_LABEL[o.status] ?? o.status}
        </StatusPill>
      ),
    },
  ];

  return (
    <>
      <SectionCard
        title="Worklist"
        description="Ranked by recoverable value. Open any patient to draft and approve outreach."
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
          getRowKey={(o) => o.id}
          onRowClick={(o) => setSelectedId(o.id)}
          className="px-2 py-1"
          empty={
            <EmptyState
              title="Nothing matches this filter"
              description="Try a different status to see more opportunities."
              className="m-4"
            />
          }
        />
      </SectionCard>

      {selected ? (
        <OpportunityDrawer
          opportunity={selected}
          nowIso={nowIso}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </>
  );
}
