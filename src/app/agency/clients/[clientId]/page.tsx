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
        <div className="flex min-w-[112px] items-center gap-2">
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
    <div className="space-y-6">
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

      {/* Dentally connection (compact meta strip) */}
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-card-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="flex items-center gap-2 font-semibold text-navy">
            <Plug size={16} className={client.dentally.connected ? "text-success" : "text-danger"} />
            Dentally
          </span>
          <StatusPill tone={client.dentally.connected ? "success" : "danger"}>
            {client.dentally.connected ? "Connected" : "Disconnected"}
          </StatusPill>
          <span className="text-muted">
            {client.dentally.connected && client.dentally.lastSyncedAt
              ? `Last successful sync ${relativeTime(client.dentally.lastSyncedAt, NOW)}.`
              : "No successful sync recorded. Re-authorise the Dentally connection to resume data flow."}
          </span>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted">
          <RefreshCw size={14} className="shrink-0 text-muted" />
          Polled every 15 minutes. Figures shown are mock data for now.
        </p>
      </div>

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
          maxRows={8}
          empty={
            <EmptyState
              icon={SearchX}
              title="No sites yet"
              description="This client has no sites with reported metrics."
            />
          }
        />
      </SectionCard>
    </div>
  );
}
