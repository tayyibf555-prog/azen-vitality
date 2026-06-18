"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Users,
  CalendarCheck,
  PoundSterling,
  Clock,
  Plug,
  RefreshCw,
  SearchX,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  EmptyState,
  DataTable,
  ProgressMeter,
  type Column,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { getClient, getClientMetrics, getSite, getSiteMetrics, NOW } from "@/lib/mock";
import { gbp, relativeTime } from "@/lib/utils";
import type { SiteMetrics } from "@/lib/types";

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function noShowTone(rate: number) {
  if (rate >= 0.12) return "danger" as const;
  if (rate >= 0.08) return "warning" as const;
  return "success" as const;
}

export default function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const client = getClient(clientId);

  if (!client) {
    return (
      <div className="py-10">
        <EmptyState
          icon={SearchX}
          title="Client not found"
          description="We could not find a client matching that reference. It may have been removed or the link is out of date."
        >
          <Button asChild variant="primary">
            <Link href="/agency">Back to cockpit</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }

  const metrics = getClientMetrics(client.id);
  const siteMetrics = getSiteMetrics(client.siteIds);

  const columns: Column<SiteMetrics>[] = [
    {
      key: "site",
      header: "Site",
      cell: (row) => <span className="font-semibold text-navy">{getSite(row.siteId)?.name ?? row.siteId}</span>,
    },
    {
      key: "leadsIn",
      header: "Leads in",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.leadsIn.toLocaleString("en-GB")}</span>,
    },
    {
      key: "booked",
      header: "Booked",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.consultationsBooked.toLocaleString("en-GB")}</span>,
    },
    {
      key: "cpb",
      header: "Cost per booking",
      align: "right",
      cell: (row) => <span className="tabular-nums">{gbp(row.costPerBooking)}</span>,
    },
    {
      key: "recall",
      header: "Recall recovery",
      cell: (row) => (
        <div className="flex min-w-[140px] items-center gap-2">
          <ProgressMeter value={row.recallRecoveryRate} className="flex-1" />
          <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-navy">
            {pct(row.recallRecoveryRate)}
          </span>
        </div>
      ),
    },
    {
      key: "treatment",
      header: "Treatment recovery",
      align: "right",
      cell: (row) => <span className="tabular-nums">{pct(row.treatmentRecoveryRate)}</span>,
    },
    {
      key: "noShow",
      header: "No-show rate",
      align: "right",
      cell: (row) => <StatusPill tone={noShowTone(row.noShowRate)}>{pct(row.noShowRate)}</StatusPill>,
    },
    {
      key: "recovered",
      header: "Revenue recovered",
      align: "right",
      cell: (row) => <span className="font-semibold tabular-nums text-navy">{gbp(row.recoveredRevenue)}</span>,
    },
  ];

  return (
    <div className="space-y-7">
      <PageHeader
        title={client.name}
        description="Cross-site performance and connection health for this deployment."
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/agency">
                <ArrowLeft size={15} />
                Back to cockpit
              </Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <Link href={`/c/${client.slug}`}>Enter dashboard</Link>
            </Button>
          </>
        }
      />

      {/* Client totals */}
      {metrics ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Leads in"
            value={metrics.leadsIn.toLocaleString("en-GB")}
            icon={Users}
            hint="All sites"
          />
          <StatCard
            label="Consultations booked"
            value={metrics.consultationsBooked.toLocaleString("en-GB")}
            icon={CalendarCheck}
            hint="Attributed via Dentally"
          />
          <StatCard
            label="Revenue recovered"
            value={gbp(metrics.recoveredRevenue)}
            icon={PoundSterling}
            hint="Recall and treatment"
          />
          <StatCard
            label="Hours saved"
            value={`${metrics.hoursSaved}`}
            icon={Clock}
            hint="Coordinator time automated"
          />
        </div>
      ) : null}

      {/* Sites */}
      <SectionCard
        title="Sites"
        description="Per-site breakdown across the network."
      >
        <DataTable
          columns={columns}
          rows={siteMetrics}
          getRowKey={(row) => row.siteId}
          empty={
            <EmptyState
              icon={SearchX}
              title="No sites yet"
              description="This client has no sites with reported metrics."
            />
          }
        />
      </SectionCard>

      {/* Dentally connection */}
      <SectionCard
        title="Dentally connection"
        description="Integration status for this client."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-line bg-card-muted/40 p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold text-navy">
                <Plug size={16} className={client.dentally.connected ? "text-success" : "text-danger"} />
                Connection
              </span>
              <StatusPill tone={client.dentally.connected ? "success" : "danger"}>
                {client.dentally.connected ? "Connected" : "Disconnected"}
              </StatusPill>
            </div>
            <p className="mt-2 text-sm text-muted">
              {client.dentally.connected && client.dentally.lastSyncedAt
                ? `Last successful sync ${relativeTime(client.dentally.lastSyncedAt, NOW)}.`
                : "No successful sync recorded. Re-authorise the Dentally connection to resume data flow."}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-card-muted/40 p-4">
            <span className="flex items-center gap-2 text-sm font-semibold text-navy">
              <RefreshCw size={16} className="text-blue-dark" />
              Polling cadence
            </span>
            <p className="mt-2 text-sm text-muted">
              Dentally has no webhooks, so we poll every 15 minutes for fresh appointment, recall and treatment data. Figures shown here are mock data for now.
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
