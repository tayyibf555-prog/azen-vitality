"use client";

import { useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { AssessmentBand, AssessmentResponse } from "@/lib/smile-assessment/types";

const BAND_TONE: Record<AssessmentBand, Tone> = {
  high: "success",
  medium: "info",
  low: "neutral",
};
const BAND_LABEL: Record<AssessmentBand, string> = { high: "High", medium: "Medium", low: "Low" };

const CHANNEL_LABEL: Record<string, string> = {
  sms: "Text",
  email: "Email",
  whatsapp: "WhatsApp",
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

type FilterValue = "all" | "high" | "medium" | "low";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function ResponsesTable({
  responses,
  nowIso,
}: {
  responses: AssessmentResponse[];
  nowIso: string;
}) {
  const [filter, setFilter] = useState<FilterValue>("all");

  // Newest first; high scorers float to the top so the team sees the fast-tracks.
  const ranked = useMemo(
    () =>
      [...responses].sort((a, b) => {
        if (a.rawScore !== b.rawScore) return b.rawScore - a.rawScore;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    [responses],
  );

  const rows = useMemo(() => {
    if (filter === "all") return ranked;
    return ranked.filter((r) => r.band === filter);
  }, [ranked, filter]);

  const columns: Column<AssessmentResponse>[] = [
    {
      key: "name",
      header: "Name",
      cell: (r) => <span className="font-semibold text-navy">{r.firstName}</span>,
    },
    {
      key: "interest",
      header: "Interest",
      cell: (r) => <span className="text-ink">{r.treatmentInterest || "General enquiry"}</span>,
    },
    {
      key: "channel",
      header: "Channel",
      cell: (r) => <span className="text-muted">{r.channel ? CHANNEL_LABEL[r.channel] ?? r.channel : "—"}</span>,
    },
    {
      key: "when",
      header: "Submitted",
      cell: (r) => <span className="text-muted">{ago(r.createdAt, nowIso)}</span>,
    },
    {
      key: "band",
      header: "Band",
      cell: (r) => <StatusPill tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</StatusPill>,
    },
    {
      key: "score",
      header: "Score",
      cell: (r) => (
        <span className={cn("font-semibold tabular-nums", r.band === "high" ? "text-success" : "text-muted")}>
          {r.rawScore}
        </span>
      ),
      align: "right",
    },
  ];

  return (
    <SectionCard
      title="Assessments"
      description="Every quiz submission, highest intent first. High scorers are fast-tracked to Speed-to-lead and contacted instantly."
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
        getRowKey={(r) => r.id}
        className="px-2 py-1"
        empty={<EmptyState title="Nothing matches this filter" description="Try a different band." className="m-4" />}
      />
    </SectionCard>
  );
}
