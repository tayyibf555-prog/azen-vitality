"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Plug,
  RefreshCw,
  SearchX,
  Info,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  EmptyState,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { getClient, getSite, NOW } from "@/lib/mock";
import { relativeTime } from "@/lib/utils";

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

  return (
    <div className="space-y-6">
      <PageHeader
        title={client.name}
        description="Cross-site structure and connection health for this deployment."
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

      {/* Dentally connection (quiet hairline meta strip) */}
      <div className="flex flex-col gap-2 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
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
          Polled every 15 minutes.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          Per-site performance (leads in, bookings, recovery and no-show rates) builds from this
          client&rsquo;s live activity and appears on their dashboard as the sources connect.
        </p>
      </div>

      {/* Sites */}
      <SectionCard title="Sites" description="The sites in this deployment.">
        {client.siteIds.length > 0 ? (
          <ul className="divide-y divide-line">
            {client.siteIds.map((id) => (
              <li key={id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="font-semibold text-navy">{getSite(id)?.name ?? id}</span>
                <span className="text-xs text-muted">Figures build from live activity</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={SearchX} title="No sites yet" description="This client has no sites configured." />
        )}
      </SectionCard>
    </div>
  );
}
