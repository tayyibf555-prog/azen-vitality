import Link from "next/link";
import {
  Users,
  CalendarCheck,
  PoundSterling,
  Clock,
  Plug,
  RefreshCw,
  Building2,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, Sparkline } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { CLIENTS, CLIENT_METRICS, getClientMetrics, NOW } from "@/lib/mock";
import { gbp, relativeTime } from "@/lib/utils";
import type { Client } from "@/lib/types";

/** Aggregate headline figures across every client deployment. */
const totals = CLIENT_METRICS.reduce(
  (acc, m) => ({
    leadsIn: acc.leadsIn + m.leadsIn,
    consultationsBooked: acc.consultationsBooked + m.consultationsBooked,
    recoveredRevenue: acc.recoveredRevenue + m.recoveredRevenue,
    hoursSaved: acc.hoursSaved + m.hoursSaved,
  }),
  { leadsIn: 0, consultationsBooked: 0, recoveredRevenue: 0, hoursSaved: 0 },
);

function dentallyTone(client: Client) {
  return client.dentally.connected ? "success" : "danger";
}

export default function AgencyCockpitPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agency cockpit"
        description="Every Vitality deployment at a glance. Leads in, consultations booked and revenue recovered across all sites."
      />

      {/* Aggregate stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Leads in"
          value={totals.leadsIn.toLocaleString("en-GB")}
          icon={Users}
          delta={{ value: 12, goodWhenUp: true }}
          hint="Across all live sites"
        />
        <StatCard
          label="Consultations booked"
          value={totals.consultationsBooked.toLocaleString("en-GB")}
          icon={CalendarCheck}
          delta={{ value: 9, goodWhenUp: true }}
          hint="Attributed via Dentally"
        />
        <StatCard
          label="Revenue recovered"
          value={gbp(totals.recoveredRevenue)}
          icon={PoundSterling}
          delta={{ value: 18, goodWhenUp: true }}
          hint="Recall and treatment recovery"
        />
        <StatCard
          label="Hours saved"
          value={`${totals.hoursSaved}`}
          icon={Clock}
          delta={{ value: 6, goodWhenUp: true }}
          hint="Coordinator time automated"
        />
      </div>

      {/* Clients */}
      <SectionCard title="Clients" description="Active deployments under management.">
        <div className="space-y-4">
          {CLIENTS.map((client) => {
            const metrics = getClientMetrics(client.id);
            const trendPoints = metrics?.trend.map((t) => t.value) ?? [];
            const statusTone =
              client.status === "live" ? "success" : client.status === "onboarding" ? "info" : "warning";

            return (
              <div
                key={client.id}
                className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-card-muted/40 p-4 lg:grid-cols-12 lg:items-center"
              >
                {/* Identity + health */}
                <div className="min-w-0 space-y-2 lg:col-span-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h4 className="text-lg font-semibold tracking-tight text-navy">{client.name}</h4>
                    <StatusPill tone={statusTone}>
                      {client.status === "live" ? "Live" : client.status === "onboarding" ? "Onboarding" : "Paused"}
                    </StatusPill>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                    <span className="flex items-center gap-1.5">
                      <StatusPill tone={dentallyTone(client)}>
                        {client.dentally.connected ? "Dentally connected" : "Dentally disconnected"}
                      </StatusPill>
                      {client.dentally.connected && client.dentally.lastSyncedAt ? (
                        <span className="text-muted">synced {relativeTime(client.dentally.lastSyncedAt, NOW)}</span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Building2 size={13} />
                      {client.siteIds.length} {client.siteIds.length === 1 ? "site" : "sites"}
                    </span>
                  </div>
                </div>

                {/* Headline metrics */}
                {metrics ? (
                  <div className="flex items-center gap-6 lg:col-span-4">
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Leads in</p>
                      <p className="text-lg font-bold tracking-tight tabular-nums text-navy">
                        {metrics.leadsIn.toLocaleString("en-GB")}
                      </p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Booked</p>
                      <p className="text-lg font-bold tracking-tight tabular-nums text-navy">
                        {metrics.consultationsBooked.toLocaleString("en-GB")}
                      </p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Recovered</p>
                      <p className="text-lg font-bold tracking-tight tabular-nums text-navy">
                        {gbp(metrics.recoveredRevenue)}
                      </p>
                    </div>
                    <div className="hidden flex-col items-center gap-1 xl:flex">
                      <Sparkline points={trendPoints} />
                      <span className="text-[11px] text-muted">Revenue trend</span>
                    </div>
                  </div>
                ) : (
                  <div className="lg:col-span-4" />
                )}

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-2 lg:col-span-3 lg:justify-end">
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/agency/clients/${client.id}`}>View details</Link>
                  </Button>
                  <Button asChild variant="primary" size="sm">
                    <Link href={`/c/${client.slug}`}>Enter dashboard</Link>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* Deployment health */}
      <SectionCard
        title="Deployment health"
        description="Connection status across the estate."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Plug size={16} className="shrink-0 text-success" />
            <span className="font-semibold text-navy">Dentally connected</span>
            <span className="text-muted">all live clients authorised, no faults</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <RefreshCw size={16} className="shrink-0 text-muted" />
            <span className="font-semibold text-navy">Polling every 15 min</span>
            <span className="text-muted">
              last sync {relativeTime(CLIENTS[0]?.dentally.lastSyncedAt ?? NOW.toISOString(), NOW)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock size={16} className="shrink-0 text-warning" />
            <span className="font-semibold text-navy">Mock data</span>
            <span className="text-muted">representative fixtures until the production integration</span>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
