import {
  PageHeader,
  StatCard,
  SectionCard,
  DataTable,
  EmptyState,
  type Column,
} from "@/components/primitives";
import { PoundSterling, ReceiptText, Users } from "lucide-react";
import { getClient, NOW } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { getSite } from "@/lib/mock";
import { gbp, relativeTime } from "@/lib/utils";
import { listOutstanding, type OutstandingRecord } from "@/lib/dentally/read";

export async function PaymentsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Payments" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const now = NOW;

  let rows: OutstandingRecord[] = [];
  try {
    rows = await listOutstanding(siteIds);
  } catch {
    rows = [];
  }

  const totalOutstanding = rows.reduce((sum, r) => sum + r.outstanding, 0);
  const patientCount = new Set(rows.map((r) => r.patientId)).size;

  const columns: Column<OutstandingRecord>[] = [
    { key: "patient", header: "Patient", cell: (r) => <span className="font-semibold text-navy">{r.patientName}</span> },
    { key: "plan", header: "Treatment plan", cell: (r) => <span className="text-ink">{r.planName}</span> },
    { key: "site", header: "Site", cell: (r) => <span className="text-muted">{getSite(r.siteId)?.name ?? r.siteId}</span> },
    {
      key: "planned",
      header: "Plan value",
      cell: (r) => <span className="tabular-nums text-muted">{gbp(r.planned)}</span>,
      align: "right",
    },
    {
      key: "outstanding",
      header: "Outstanding",
      cell: (r) => <span className="font-semibold tabular-nums text-navy">{gbp(r.outstanding)}</span>,
      align: "right",
    },
    {
      key: "accepted",
      header: "Accepted",
      cell: (r) => <span className="text-muted">{r.acceptedAt ? relativeTime(r.acceptedAt, now) : "Unknown"}</span>,
      align: "right",
    },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        description="Outstanding balances across accepted treatment plans, live from Dentally. Ranked by what is owed."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard label="Outstanding" value={gbp(totalOutstanding)} icon={PoundSterling} hint="Across open plans" />
        <StatCard label="Open plans" value={rows.length} icon={ReceiptText} hint="With a balance" />
        <StatCard label="Patients" value={patientCount} icon={Users} hint="Owing money" />
      </div>

      <SectionCard title="Outstanding balances" description="Highest owed first." bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="Nothing outstanding"
            description="When accepted plans carry a balance, they appear here."
            className="m-4"
          />
        ) : (
          <DataTable columns={columns} rows={rows} getRowKey={(r, i) => `${r.patientId}-${i}`} maxRows={8} className="px-2 py-1" />
        )}
      </SectionCard>
    </>
  );
}
