"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Power } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/primitives";
import { cn } from "@/lib/utils";

// Owner-only master control panel: one on/off switch per automated system. OFF is
// a full kill switch (the server halts the system's sweeps, sends, agent replies
// and public intake, and the module is hidden). Reads/writes /api/systems, which
// is owner-gated. Optimistic toggles with revert-on-failure.

interface SystemRow {
  slug: string;
  label: string;
  group: string;
  halts: string;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Render groups in this order; anything unexpected falls to the end.
const GROUP_ORDER = ["Patient lifecycle", "Acquisition", "Conversational agents", "Operations"];

export function SystemsView({ clientSlug }: { clientSlug: string }) {
  const [rows, setRows] = useState<SystemRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/systems?client=${encodeURIComponent(clientSlug)}`);
      const json = (await res.json()) as { ok?: boolean; systems?: SystemRow[]; error?: string };
      if (!res.ok || !json.ok || !Array.isArray(json.systems)) {
        throw new Error(json.error ?? "Could not load system controls");
      }
      setRows(json.systems);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load system controls");
    }
  }, [clientSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(slug: string, next: boolean) {
    if (busy.has(slug)) return;
    setRowError(null);
    setBusy((b) => new Set(b).add(slug));
    // Optimistic: flip locally, revert if the write fails.
    setRows((rs) => rs?.map((r) => (r.slug === slug ? { ...r, enabled: next } : r)) ?? rs);
    try {
      const res = await fetch("/api/systems", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, slug, enabled: next }),
      });
      if (!res.ok) throw new Error("write failed");
    } catch {
      setRows((rs) => rs?.map((r) => (r.slug === slug ? { ...r, enabled: !next } : r)) ?? rs);
      setRowError("Could not update that system. Please try again.");
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(slug);
        return n;
      });
    }
  }

  const total = rows?.length ?? 0;
  const running = rows?.filter((r) => r.enabled).length ?? 0;
  const offCount = total - running;

  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: (rows ?? []).filter((r) => r.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <PageHeader
        hero
        title="System controls"
        description="Your master on/off for every automated system. Turning one off is a full kill switch: it hides the module and stops all of its work, so nothing sends until you switch it back on."
      />

      {rows ? (
        <div className="flex flex-wrap gap-x-7 gap-y-4">
          <div>
            <p className="text-[20px] font-bold tracking-[-0.3px] tabular-nums text-navy">
              <i aria-hidden className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-status-green align-[2px]" />
              {running} of {total}
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-muted">Systems running</p>
          </div>
          {offCount > 0 ? (
            <div>
              <p className="text-[20px] font-bold tracking-[-0.3px] tabular-nums text-navy">
                <i aria-hidden className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-status-amber align-[2px]" />
                {offCount}
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-muted">Switched off</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {rowError ? (
        <p className="rounded-xl border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{rowError}</p>
      ) : null}

      {loadError ? (
        <SectionCard title="Couldn't load controls">
          <p className="text-sm text-muted">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold text-navy hover:bg-card-muted"
          >
            Try again
          </button>
        </SectionCard>
      ) : !rows ? (
        <SectionCard title="Systems">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading your systems…
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-6">
          {groups.map(({ group, items }) => (
            <SectionCard key={group} title={group} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {items.map((r) => (
                  <li key={r.slug} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold text-navy">
                        {r.label}
                        {!r.enabled ? (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                            Off
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {r.enabled ? "Running." : "Off. "}
                        {!r.enabled ? r.halts : ""}
                      </p>
                    </div>
                    <SystemSwitch
                      enabled={r.enabled}
                      busy={busy.has(r.slug)}
                      label={r.label}
                      onToggle={() => void toggle(r.slug, !r.enabled)}
                    />
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}
        </div>
      )}
    </>
  );
}

function SystemSwitch({
  enabled,
  busy,
  label,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} is ${enabled ? "on" : "off"}`}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2",
        enabled ? "bg-success" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "inline-flex h-5 w-5 translate-x-0.5 items-center justify-center rounded-full bg-white shadow-sm transition-transform",
          enabled && "translate-x-[22px]",
        )}
      >
        {busy ? <Loader2 size={11} className="animate-spin text-muted" /> : <Power size={10} className={enabled ? "text-success" : "text-muted"} />}
      </span>
    </button>
  );
}
