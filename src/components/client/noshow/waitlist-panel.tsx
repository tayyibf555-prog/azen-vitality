"use client";

import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { relativeTime } from "@/lib/utils";
import type { WaitlistEntry, WaitlistStatus } from "@/lib/noshow/types";

const STATUS_TONE: Record<WaitlistStatus, Tone> = {
  waiting: "info",
  offered: "warning",
  booked: "success",
  removed: "neutral",
};
const STATUS_LABEL: Record<WaitlistStatus, string> = {
  waiting: "Waiting",
  offered: "Offered",
  booked: "Booked in",
  removed: "Removed",
};

export function WaitlistPanel({ entries, nowIso }: { entries: WaitlistEntry[]; nowIso: string }) {
  const now = new Date(nowIso);
  const rows = [...entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const columns: Column<WaitlistEntry>[] = [
    { key: "patient", header: "Patient", cell: (e) => <span className="font-semibold text-navy">{e.patientName}</span> },
    { key: "treatment", header: "Wants", cell: (e) => <span className="text-muted">{e.treatment ?? "Any appointment"}</span> },
    { key: "with", header: "With", cell: (e) => <span className="text-muted">{e.practitionerPref ?? "Any"}</span> },
    { key: "since", header: "Waiting since", cell: (e) => <span className="text-muted">{relativeTime(e.createdAt, now)}</span>, align: "right" },
    { key: "status", header: "Status", cell: (e) => <StatusPill tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</StatusPill>, align: "right" },
  ];

  return (
    <SectionCard
      title="Waitlist"
      description="Patients wanting a sooner slot. When a defended appointment cancels, the freed time is offered here automatically, in turn, until someone takes it."
      bodyClassName="p-0"
    >
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(e) => e.id}
        className="px-2 py-1"
        empty={
          <EmptyState
            title="No one on the waitlist yet"
            description="Add patients who want an earlier appointment and they will be offered freed slots automatically."
            className="m-4"
          />
        }
      />
    </SectionCard>
  );
}
