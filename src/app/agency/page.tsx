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
    <div className="space-y-7">
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
      <SectionCard
        title="Clients"
        description="Active deployments under management."
      >
        <div className="space-y-4">
          {CLIENTS.map((client) => {
            const metrics = getClientMetrics(client.id);
            const trendPoints = metrics?.trend.map((t) => t.value) ?? [];
            const statusTone =
              client.status === "live" ? "success" : client.status === "onboarding" ? "info" : "warning";

            return (
              <div
                key={client.id}
                className="rounded-xl border border-line bg-card-muted/40 p-5"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  {/* Identity + health */}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h4 className="text-lg font-extrabold tracking-tight text-navy">{client.name}</h4>
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
                    <div className="flex items-center gap-6">
                      <div className="space-y-0.5">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Leads in</p>
                        <p className="text-lg font-extrabold tracking-tight text-navy">
                          {metrics.leadsIn.toLocaleString("en-GB")}
                        </p>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Booked</p>
                        <p className="text-lg font-extrabold tracking-tight text-navy">
                          {metrics.consultationsBooked.toLocaleString("en-GB")}
                        </p>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Recovered</p>
                        <p className="text-lg font-extrabold tracking-tight text-navy">
                          {gbp(metrics.recoveredRevenue)}
                        </p>
                      </div>
                      <div className="hidden flex-col items-center gap-1 xl:flex">
                        <Sparkline points={trendPoints} />
                        <span className="text-[11px] text-muted">Revenue trend</span>
                      </div>
                    </div>
                  ) : null}

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-2">
                    <Button asChild variant="secondary" size="sm">
                      <Link href={`/agency/clients/${client.id}`}>View details</Link>
                    </Button>
                    <Button asChild variant="primary" size="sm">
                      <Link href={`/c/${client.slug}`}>Enter dashboard</Link>
                    </Button>
                  </div>
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-line bg-card-muted/40 p-4">
            <div className="flex items-center gap-2 text-navy">
              <Plug size={16} className="text-success" />
              <span className="text-sm font-semibold">Dentally connected</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              All live clients are authorised against the Dentally API. No connection faults detected.
            </p>
          </div>
          <div className="rounded-xl border border-line bg-card-muted/40 p-4">
            <div className="flex items-center gap-2 text-navy">
              <RefreshCw size={16} className="text-blue-dark" />
              <span className="text-sm font-semibold">Polling every 15 min</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              Dentally has no webhooks, so we poll on a fixed cadence. Last estate sync {relativeTime(CLIENTS[0]?.dentally.lastSyncedAt ?? NOW.toISOString(), NOW)}.
            </p>
          </div>
          <div className="rounded-xl border border-line bg-card-muted/40 p-4">
            <div className="flex items-center gap-2 text-navy">
              <Clock size={16} className="text-warning" />
              <span className="text-sm font-semibold">Mock data</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              Figures shown are representative fixtures for now. Live Dentally data lands with the production integration.
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
