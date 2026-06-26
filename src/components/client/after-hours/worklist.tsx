"use client";

import { useMemo, useState } from "react";
import { Filter, Phone, MessageSquare, MessageCircle } from "lucide-react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { AfterHoursCapture, CaptureChannel, CaptureStatus } from "@/lib/after-hours/types";
import { CaptureDrawer } from "./capture-drawer";

const STATUS_TONE: Record<CaptureStatus, Tone> = {
  new: "info",
  followed_up: "warning",
  booked: "success",
  closed: "neutral",
};
const STATUS_LABEL: Record<CaptureStatus, string> = {
  new: "New",
  followed_up: "Followed up",
  booked: "Booked",
  closed: "Closed",
};

const CHANNEL_LABEL: Record<CaptureChannel, string> = {
  call: "Call",
  sms: "SMS",
  whatsapp: "WhatsApp",
};
function ChannelIcon({ channel }: { channel: CaptureChannel }) {
  if (channel === "call") return <Phone size={13} className="text-muted" />;
  if (channel === "whatsapp") return <MessageCircle size={13} className="text-muted" />;
  return <MessageSquare size={13} className="text-muted" />;
}

/** Captured-at label, e.g. "Sun 28 Jun, 21:14". */
function capturedLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type FilterValue = "all" | "new" | "followed_up" | "booked" | "closed";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "followed_up", label: "Followed up" },
  { value: "booked", label: "Booked" },
  { value: "closed", label: "Closed" },
];

export function Worklist({ captures, nowIso }: { captures: AfterHoursCapture[]; nowIso: string }) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (filter === "all") return captures;
    return captures.filter((c) => c.status === filter);
  }, [captures, filter]);

  const selected = useMemo(
    () => captures.find((c) => c.id === selectedId) ?? null,
    [captures, selectedId],
  );

  const columns: Column<AfterHoursCapture>[] = [
    {
      key: "patient",
      header: "Patient",
      cell: (c) => <span className="font-semibold text-navy">{c.patientName}</span>,
    },
    {
      key: "from",
      header: "From",
      cell: (c) => <span className="tabular-nums text-muted">{c.fromNumber}</span>,
    },
    {
      key: "channel",
      header: "Channel",
      cell: (c) => (
        <span className="inline-flex items-center gap-1.5 text-ink">
          <ChannelIcon channel={c.channel} />
          {CHANNEL_LABEL[c.channel]}
        </span>
      ),
    },
    {
      key: "captured",
      header: "Captured",
      cell: (c) => <span className="text-muted">{capturedLabel(c.capturedAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => <StatusPill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusPill>,
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="Overnight captures"
        description="Missed calls and out-of-hours messages. Open one to follow up, mark it booked, or close it off."
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
          getRowKey={(c) => c.id}
          onRowClick={(c) => setSelectedId(c.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different status." className="m-4" />}
        />
      </SectionCard>

      {selected ? <CaptureDrawer capture={selected} nowIso={nowIso} onClose={() => setSelectedId(null)} /> : null}
    </>
  );
}
