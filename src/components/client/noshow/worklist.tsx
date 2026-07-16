"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { Filter } from "lucide-react";
import type { NoshowStatus, NoshowTarget, RiskBand } from "@/lib/noshow/types";
import { TargetDrawer } from "./target-drawer";

const RISK_TONE: Record<RiskBand, Tone> = {
  high: "warning",
  medium: "info",
  low: "neutral",
};
const RISK_LABEL: Record<RiskBand, string> = { high: "High risk", medium: "Medium", low: "Low" };

/** Future appointment label, e.g. "Sun 28 Jun, 09:00". */
function apptLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

const STATUS_TONE: Record<NoshowStatus, Tone> = {
  scheduled: "info",
  confirmed: "success",
  cancelled: "neutral",
  attended: "success",
  no_show: "warning",
};
const STATUS_LABEL: Record<NoshowStatus, string> = {
  scheduled: "Awaiting",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  attended: "Attended",
  no_show: "No-show",
};

type FilterValue = "all" | "high" | "scheduled" | "confirmed" | "cancelled";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "high", label: "High risk" },
  { value: "scheduled", label: "Awaiting" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
];

export function Worklist({ targets, nowIso }: { targets: NoshowTarget[]; nowIso: string }) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Ranked by risk (highest first), then soonest appointment.
  const ranked = useMemo(
    () =>
      [...targets].sort(
        (a, b) =>
          b.riskScore - a.riskScore ||
          new Date(a.appointmentStartAt).getTime() - new Date(b.appointmentStartAt).getTime(),
      ),
    [targets],
  );
  const rows = useMemo(() => {
    if (filter === "all") return ranked;
    if (filter === "high") return ranked.filter((t) => t.riskBand === "high");
    return ranked.filter((t) => t.status === filter);
  }, [ranked, filter]);

  const selected = useMemo(() => targets.find((t) => t.id === selectedId) ?? null, [targets, selectedId]);

  const columns: Column<NoshowTarget>[] = [
    { key: "patient", header: "Patient", cell: (t) => <span className="font-semibold text-navy">{t.patientName}</span> },
    {
      key: "appt",
      header: "Appointment",
      cell: (t) => <span className="font-semibold text-navy">{apptLabel(t.appointmentStartAt)}</span>,
    },
    {
      key: "risk",
      header: "Risk",
      cell: (t) => <StatusPill tone={RISK_TONE[t.riskBand]}>{RISK_LABEL[t.riskBand]}</StatusPill>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <StatusPill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</StatusPill>,
    },
    {
      key: "score",
      header: "Score",
      cell: (t) => <span className={cn("font-semibold tabular-nums", t.riskBand === "high" ? "text-[#9a6700]" : "text-muted")}>{t.riskScore}</span>,
      align: "right",
    },
    {
      key: "with",
      header: "With",
      cell: (t) => <span className="text-muted">{t.practitioner ?? "Any"}</span>,
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="Upcoming appointments"
        description="Ranked by no-show risk. Open a patient to confirm, cancel and free the slot, or rebook."
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
          getRowKey={(t) => t.id}
          onRowClick={(t) => setSelectedId(t.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different status." className="m-4" />}
        />
      </SectionCard>

      {selected ? <TargetDrawer target={selected} nowIso={nowIso} onClose={() => setSelectedId(null)} /> : null}
    </>
  );
}
