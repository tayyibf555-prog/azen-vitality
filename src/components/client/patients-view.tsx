"use client";

import { Users, CalendarX, MessageSquareOff } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  DataTable,
  type Column,
  type Tone,
} from "@/components/primitives";
import { PATIENTS, getSite, NOW, type PatientRecord, type PatientStatus } from "@/lib/mock";
import { relativeTime } from "@/lib/utils";

const STATUS_TONE: Record<PatientStatus, Tone> = {
  no_show: "warning",
  abandoned_inquiry: "neutral",
};

const STATUS_LABEL: Record<PatientStatus, string> = {
  no_show: "No show",
  abandoned_inquiry: "Abandoned inquiry",
};

const columns: Column<PatientRecord>[] = [
  {
    key: "name",
    header: "Patient",
    cell: (p) => <span className="font-semibold text-navy">{p.name}</span>,
  },
  {
    key: "treatment",
    header: "Treatment",
    cell: (p) => <span className="text-ink">{p.treatment}</span>,
  },
  {
    key: "status",
    header: "Status",
    cell: (p) => <StatusPill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</StatusPill>,
  },
  {
    key: "phone",
    header: "Phone",
    cell: (p) => <span className="tabular-nums text-ink">{p.phone}</span>,
  },
  {
    key: "site",
    header: "Site",
    cell: (p) => <span className="text-muted">{getSite(p.siteId)?.name ?? p.siteId}</span>,
  },
  {
    key: "lastContact",
    header: "Last contact",
    align: "right",
    cell: (p) => <span className="text-muted">{relativeTime(p.lastContactAt, NOW)}</span>,
  },
];

/**
 * Patient database. Mock test data only, used to exercise the outreach systems
 * without contacting anyone real. Every record routes to the single test
 * handset on purpose.
 */
export function PatientsView() {
  const total = PATIENTS.length;
  const noShows = PATIENTS.filter((p) => p.status === "no_show").length;
  const abandoned = total - noShows;

  return (
    <>
      <PageHeader
        title="Patient database"
        description="Test data for outreach testing only. These are not real patients and every record points to a single test handset, so the no-show and abandoned-inquiry systems can be exercised safely."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Patients" value={String(total)} icon={Users} hint="In the test set" />
        <StatCard label="No shows" value={String(noShows)} icon={CalendarX} hint="Missed an appointment" />
        <StatCard
          label="Abandoned inquiries"
          value={String(abandoned)}
          icon={MessageSquareOff}
          hint="Enquired then went quiet"
        />
      </div>

      <SectionCard
        title="Patients"
        description="A spacious, readable list of the mock patients available for outreach testing."
      >
        <DataTable
          columns={columns}
          rows={PATIENTS}
          getRowKey={(p) => p.id}
        />
      </SectionCard>
    </>
  );
}
