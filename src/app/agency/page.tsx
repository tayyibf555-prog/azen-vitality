import Link from "next/link";
import {
  Clock,
  Plug,
  RefreshCw,
  Building2,
  Info,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { CLIENTS, NOW } from "@/lib/mock";
import { relativeTime } from "@/lib/utils";
import type { Client } from "@/lib/types";

// Real, structural counts across the estate (deployments and connection state).
// Performance figures (leads, bookings, revenue) build from live activity per
// client and are not aggregated here until they are real.
const totalSites = CLIENTS.reduce((acc, c) => acc + c.siteIds.length, 0);
const connectedCount = CLIENTS.filter((c) => c.dentally.connected).length;

function dentallyTone(client: Client) {
  return client.dentally.connected ? "success" : "danger";
}

export default function AgencyCockpitPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agency cockpit"
        description="Every Vitality deployment at a glance: which sites are live and how their Dentally connection is holding."
      />

      {/* Structural counts (real). Performance aggregates build from live activity. */}
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="Clients" value={CLIENTS.length} dot="bg-status-blue" hint="Under management" />
        <StatCard label="Sites" value={totalSites} dot="bg-status-blue" hint="Across all clients" />
        <StatCard
          label="Dentally connected"
          value={connectedCount}
          dot="bg-status-green"
          hint={`of ${CLIENTS.length} clients`}
        />
      </div>

      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          Leads in, consultations booked and revenue recovered build from each client&rsquo;s live
          activity and appear on their dashboard as the sources connect. They are not aggregated here
          until they are real.
        </p>
      </div>

      {/* Clients */}
      <SectionCard title="Clients" description="Active deployments under management." bodyClassName="p-0">
        <div className="divide-y divide-line">
          {CLIENTS.map((client) => {
            const statusTone =
              client.status === "live" ? "success" : client.status === "onboarding" ? "info" : "warning";

            return (
              <div
                key={client.id}
                className="grid grid-cols-1 gap-4 py-4 lg:grid-cols-12 lg:items-center"
              >
                {/* Identity + health */}
                <div className="min-w-0 space-y-2 lg:col-span-8">
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

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-2 lg:col-span-4 lg:justify-end">
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
            <span className="font-semibold text-navy">Dentally</span>
            <span className="text-muted">
              {connectedCount} of {CLIENTS.length} {CLIENTS.length === 1 ? "client" : "clients"} connected
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <RefreshCw size={16} className="shrink-0 text-muted" />
            <span className="font-semibold text-navy">Polling every 15 min</span>
            <span className="text-muted">
              last sync {relativeTime(CLIENTS[0]?.dentally.lastSyncedAt ?? NOW.toISOString(), NOW)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock size={16} className="shrink-0 text-muted" />
            <span className="font-semibold text-navy">Performance figures</span>
            <span className="text-muted">build from each client&rsquo;s live activity</span>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
