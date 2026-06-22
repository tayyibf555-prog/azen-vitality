import {
  PageHeader,
  StatCard,
  SectionCard,
  DataTable,
  StatusPill,
  EmptyState,
  type Column,
  type Tone,
} from "@/components/primitives";
import { CalendarDays, CheckCircle2, Clock, UserX } from "lucide-react";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
import { getSite } from "@/lib/mock";
import { listAppointments, type AppointmentRecord } from "@/lib/dentally/read";

const STATE_TONE: Record<string, Tone> = {
  booked: "info",
  completed: "success",
  did_not_attend: "danger",
  cancelled: "neutral",
  pending: "info",
};
const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  completed: "Completed",
  did_not_attend: "No-show",
  cancelled: "Cancelled",
  pending: "Pending",
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}
function longDate(dayIso: string): string {
  return new Date(`${dayIso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

const COLUMNS: Column<AppointmentRecord>[] = [
  {
    key: "time",
    header: "Time",
    cell: (a) => (
      <span className="font-semibold tabular-nums text-navy">
        {hhmm(a.start)}
        <span className="ml-1 text-xs font-normal text-muted">{a.durationMin}m</span>
      </span>
    ),
  },
  { key: "patient", header: "Patient", cell: (a) => <span className="font-semibold text-navy">{a.patientName}</span> },
  { key: "reason", header: "Reason", cell: (a) => <span className="text-ink">{a.reason ?? "Appointment"}</span> },
  {
    key: "practitioner",
    header: "With",
    cell: (a) => <span className="text-muted">{a.practitioner ?? "Unassigned"}</span>,
  },
  { key: "site", header: "Site", cell: (a) => <span className="text-muted">{getSite(a.siteId)?.name ?? a.siteId}</span> },
  {
    key: "state",
    header: "Status",
    cell: (a) => <StatusPill tone={STATE_TONE[a.state] ?? "neutral"}>{STATE_LABEL[a.state] ?? a.state}</StatusPill>,
    align: "right",
  },
];

export async function TodayView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Today" description="This client could not be found." />;
  }

  const siteIds = getSites(client.id).map((s) => s.id);
  const today = NOW.toISOString().slice(0, 10);

  let appts: AppointmentRecord[] = [];
  try {
    appts = await listAppointments(siteIds, { from: today, to: today });
  } catch {
    appts = [];
  }

  const completed = appts.filter((a) => a.state === "completed").length;
  const upcoming = appts.filter((a) => a.state === "booked" || a.state === "pending").length;
  const noShows = appts.filter((a) => a.state === "did_not_attend").length;

  return (
    <>
      <PageHeader
        title="Today"
        description={`A live snapshot of ${longDate(today)} across every site, straight from the Dentally diary.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Appointments" value={String(appts.length)} icon={CalendarDays} hint="Booked in today" />
        <StatCard label="Completed" value={String(completed)} icon={CheckCircle2} hint="Seen so far" />
        <StatCard label="Still to come" value={String(upcoming)} icon={Clock} hint="Yet to arrive" />
        <StatCard label="No-shows" value={String(noShows)} icon={UserX} hint="Did not attend" />
      </div>

      <SectionCard title="Today's diary" description="Every appointment across your sites, in time order." bodyClassName="p-0">
        {appts.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Nothing booked today"
            description="When the diary fills up, today's appointments appear here."
            className="m-4"
          />
        ) : (
          <DataTable columns={COLUMNS} rows={appts} getRowKey={(a) => a.id} className="px-2 py-1" />
        )}
      </SectionCard>
    </>
  );
}
