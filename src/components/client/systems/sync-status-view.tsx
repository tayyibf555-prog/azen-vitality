"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { DataTable, SectionCard, StatCard, StatusPill, type Column, type Tone } from "@/components/primitives";
import {
  SYNC_GROUP_ORDER,
  SYNC_GROUP_TITLES,
  type SyncFact,
  type SyncGroup,
} from "@/lib/dentally/sync-surface";
import { BLOCKED_REASON_COPY, targetLabel, type BlockedReason } from "@/lib/dentally/write-vocabulary";

// WHAT THIS PLATFORM WRITES BACK TO DENTALLY — the owner's and the agency's
// answer to "does what I do here show up in Dentally?".
//
// Three things, in this order, because that is the order the question is asked:
// what flows (or is waiting to), what will never flow and why, and then the
// evidence — every write the platform has made, attempted or refused.
//
// IT NEVER PRINTS A NUMBER IT CANNOT SOURCE. When the ledger cannot be read the
// count strip is not rendered at all and a sentence says why; a zero would be a
// claim that nothing has been written, which is a different thing from not
// knowing. When the count hit its scan ceiling it is prefixed "At least".

export interface WriteIntent {
  id: string;
  kind: string;
  source: string;
  moduleSlug: string | null;
  dentallyPatientId: string | null;
  dentallyAppointmentId: string | null;
  target: string;
  status: string;
  blockedReason: string | null;
  actor: string | null;
  responseId: string | null;
  error: string | null;
  createdAt: string;
}

export interface SyncStatusPayloadShape {
  mode: "live" | "dry_run";
  target: { host: string; live: boolean };
  master: { slug: string; off: boolean };
  headline: string;
  facts: SyncFact[];
  counts: Record<string, number> | null;
  total: number | null;
  countCapped: boolean;
  intents: WriteIntent[];
  more: boolean;
  pageSize: number;
  ledgerError: string | null;
}

/** Owner-facing wording for a ledger status. Never the raw enum value. */
const STATUS_COPY: Record<string, { label: string; tone: Tone }> = {
  sent: { label: "Written to Dentally", tone: "success" },
  // A dry_run RAN — against the local mock, never against the practice's book.
  // The row's own target is appended below so a developer's write can never be
  // read as a rehearsal against the real thing.
  dry_run: { label: "Test write", tone: "neutral" },
  queued: { label: "Waiting to be sent", tone: "info" },
  blocked: { label: "Held back", tone: "warning" },
  failed: { label: "Dentally refused it", tone: "danger" },
};

/** Owner-facing wording for a write kind. */
const KIND_COPY: Record<string, string> = {
  "patient.create": "New patient",
  "patient.update": "Patient details",
  "appointment.create": "New appointment",
  "appointment.update": "Appointment change",
  "appointment.cancel": "Cancellation",
};

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One request, as a value. Pure of React, so the effect below stays readable. */
async function fetchSyncStatus(
  clientSlug: string,
): Promise<{ payload: SyncStatusPayloadShape } | { error: string }> {
  try {
    const res = await fetch(`/api/dentally/sync-status?client=${encodeURIComponent(clientSlug)}`);
    const json = (await res.json()) as ({ ok?: boolean; error?: string } & Partial<SyncStatusPayloadShape>) | null;
    if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Could not load the Dentally sync status");
    return { payload: json as SyncStatusPayloadShape };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load the Dentally sync status" };
  }
}

export function SyncStatusView({ clientSlug }: { clientSlug: string }) {
  const [data, setData] = useState<SyncStatusPayloadShape | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping this re-runs the effect: "Try again" asks for the same request the
  // mount made, rather than a second copy of it living beside the effect.
  const [reloadKey, setReloadKey] = useState(0);



  // THE FETCH IS OWNED BY THE EFFECT, not called from it.
  //
  // `void load()` in an effect body is the house pattern and it trips
  // react-hooks/set-state-in-effect (a stale-closure and cascading-render
  // hazard the rule is right about). Running the request inside the effect,
  // with its own `cancelled` flag, keeps every setState behind an await AND
  // fixes the bug the pattern actually has: switching practice mid-flight can
  // otherwise let the previous practice's answer land on the new screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchSyncStatus(clientSlug);
      if (cancelled) return;
      if ("error" in next) setLoadError(next.error);
      else {
        setLoadError(null);
        setData(next.payload);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientSlug, reloadKey]);

  if (loadError) {
    return (
      <SectionCard title="Couldn't load the Dentally sync status">
        <p className="text-sm text-muted">{loadError}</p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold text-navy hover:bg-card-muted"
        >
          Try again
        </button>
      </SectionCard>
    );
  }

  if (!data) {
    return (
      <SectionCard title="Dentally sync">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" /> Checking what is flowing back to Dentally…
        </p>
      </SectionCard>
    );
  }

  return <SyncStatusPanel data={data} />;
}

/**
 * The rendering, split from the fetching on purpose.
 *
 * It is a PURE function of the payload, so what a practice is told about their
 * Dentally connection can be rendered in a test and asserted word by word —
 * which is the only way "notes do not flow back to Dentally" stops being a
 * sentence somebody once wrote and becomes a sentence something checks.
 */
export function SyncStatusPanel({ data }: { data: SyncStatusPayloadShape }) {
  const byGroup = (g: SyncGroup): SyncFact[] => data.facts.filter((f) => f.group === g);

  const columns: Column<WriteIntent>[] = [
    { key: "when", header: "When", cell: (r) => <span className="whitespace-nowrap text-muted">{when(r.createdAt)}</span> },
    { key: "kind", header: "What", cell: (r) => <span className="font-medium text-navy">{KIND_COPY[r.kind] ?? r.kind}</span> },
    { key: "source", header: "From", cell: (r) => <span className="text-muted">{r.source}</span> },
    {
      key: "record",
      header: "Dentally record",
      cell: (r) => (
        <span className="whitespace-nowrap font-mono text-[11.5px] text-muted">
          {r.dentallyAppointmentId ? `appt ${r.dentallyAppointmentId}` : r.dentallyPatientId ? `patient ${r.dentallyPatientId}` : "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Outcome",
      cell: (r) => {
        const copy = STATUS_COPY[r.status] ?? { label: r.status, tone: "neutral" as Tone };
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={copy.tone}>{copy.label}</StatusPill>
            {/* WHERE IT WENT, on the one status where that is ambiguous. A
                dry_run is a write that really happened somewhere that is not the
                practice's book, and a row that did not say so would read as a
                rehearsal against the real thing. */}
            {r.status === "dry_run" ? (
              <span className="text-[11px] text-faint">{targetLabel(r.target)}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "why",
      header: "Why",
      cell: (r) => (
        <span className="text-[12px] text-muted">
          {r.blockedReason
            ? (BLOCKED_REASON_COPY[r.blockedReason as BlockedReason] ?? r.blockedReason)
            : r.error
              ? r.error
              : r.responseId
                ? `Dentally reference ${r.responseId}`
                : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <SectionCard title="Writing back to Dentally">
        <p className="max-w-3xl text-[13px] text-muted">{data.headline}</p>
        <p className="mt-2 text-[12px] text-faint">
          Writes are aimed at <span className="font-mono">{data.target.host}</span>
          {data.target.live ? " (your live Dentally account)." : " (a local copy used for testing, not your live account)."}
        </p>
        {/* THE TWO SWITCHES, NAMED. Writing back needs the connection armed by
            your agency AND your own master switch on; either one off stops
            everything. Saying which is which is the difference between waiting
            for somebody and flipping a control yourself. */}
        <ul className="mt-3 space-y-1 text-[12.5px]">
          <li>
            <span className="font-semibold text-navy">Your Dentally write-back switch:</span>{" "}
            <span className={data.master.off ? "text-status-amber" : "text-status-green"}>
              {data.master.off ? "Off" : "On"}
            </span>
            <span className="text-faint"> — in System controls, on the Systems tab.</span>
          </li>
          <li>
            <span className="font-semibold text-navy">The connection itself:</span>{" "}
            <span className={data.mode === "live" ? "text-status-green" : "text-status-amber"}>
              {data.mode === "live" ? "Armed for writing" : "Not armed for writing"}
            </span>
            <span className="text-faint">
              {data.mode === "live" ? "." : " — this needs your Dentally write key, which your agency sets up."}
            </span>
          </li>
        </ul>
      </SectionCard>

      {data.counts ? (
        <div className="flex flex-wrap items-start gap-x-7 gap-y-4">
          <StatCard
            label="Writes recorded"
            value={data.countCapped ? `At least ${data.total?.toLocaleString("en-GB")}` : (data.total ?? 0)}
            emphasis
          />
          <StatCard label="Written to Dentally" value={data.counts.sent ?? 0} dot="bg-status-green" />
          <StatCard label="Held back (writing off)" value={data.counts.dry_run ?? 0} dot="bg-status-amber" />
          <StatCard label="Refused here" value={data.counts.blocked ?? 0} dot="bg-status-amber" />
          <StatCard label="Dentally refused" value={data.counts.failed ?? 0} dot="bg-status-red" />
        </div>
      ) : null}

      {SYNC_GROUP_ORDER.map((group) => {
        const facts = byGroup(group);
        if (facts.length === 0) return null;
        return (
          <SectionCard key={group} title={SYNC_GROUP_TITLES[group]}>
            <ul className="space-y-3.5">
              {facts.map((f) => (
                <li key={f.id}>
                  <p className="text-[13px] font-semibold text-navy">{f.label}</p>
                  <p className="mt-0.5 max-w-3xl text-[12.5px] text-muted">{f.detail}</p>
                  {f.sources && f.sources.length > 0 ? (
                    <p className="mt-1 text-[11.5px] text-faint">Comes from: {f.sources.join("; ")}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </SectionCard>
        );
      })}

      <SectionCard
        title="Every write this platform has made or held back"
        description={
          data.ledgerError
            ? undefined
            : `The most recent ${data.pageSize}${data.more ? " of more" : ""}, newest first.`
        }
      >
        {data.ledgerError ? (
          <p className="max-w-3xl text-[13px] text-muted">{data.ledgerError}</p>
        ) : (
          <DataTable
            columns={columns}
            rows={data.intents}
            getRowKey={(r) => r.id}
            empty={
              <p className="max-w-3xl text-[13px] text-muted">
                Nothing has been written or held back yet. As soon as this platform books, changes or cancels an
                appointment — or creates or edits a patient — it appears here, whether or not it reached Dentally.
              </p>
            }
          />
        )}
      </SectionCard>
    </div>
  );
}
