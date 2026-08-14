"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Inbox, Loader2, ShieldCheck } from "lucide-react";
import { SectionCard, StatCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { declarationChoiceLabel, PAYING_KEY } from "@/lib/fp17/exemptions";
import { FP17_COPY } from "@/lib/fp17/copy";
import type { Fp17DeclarationSummary, Fp17Status } from "@/lib/fp17/types";

// Internal FP17 worklist. Fetches the auth-gated /api/fp17/list client-side (session
// cookie), so the headline figures and the list stay in sync.
//
// LOUD ON FAILURE: a failed read renders an honest error panel (FP17_COPY.readFailed),
// NEVER a confident "no declarations" empty state. An empty list only ever means the
// read succeeded and there is nothing to triage.
//
// The signature VALUE is never fetched here — the API returns summaries carrying only
// the signature method + when it was signed. Nothing shown here was submitted to the
// NHS (Compass); the banner says so.

interface ListResponse {
  ok?: boolean;
  declarations?: Fp17DeclarationSummary[];
  stats?: { total: number; byStatus: { status: Fp17Status; count: number }[] };
  error?: string;
}

const STATUS_TONE: Record<Fp17Status, Tone> = {
  new: "info",
  reviewed: "success",
  archived: "neutral",
};
const STATUS_LABEL: Record<Fp17Status, string> = {
  new: "New",
  reviewed: "Reviewed",
  archived: "Archived",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function Fp17Worklist({ clientSlug }: { clientSlug: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [rows, setRows] = useState<Fp17DeclarationSummary[]>([]);
  const [stats, setStats] = useState<{ total: number; byStatus: { status: Fp17Status; count: number }[] } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState("loading");
      try {
        const res = await fetch(`/api/fp17/list?client=${encodeURIComponent(clientSlug)}`, {
          headers: { accept: "application/json" },
        });
        const data = (await res.json().catch(() => null)) as ListResponse | null;
        if (cancelled) return;
        if (!res.ok || !data?.ok || !Array.isArray(data.declarations)) {
          setState("error");
          return;
        }
        setRows(data.declarations);
        setStats(data.stats ?? null);
        setState("ok");
      } catch {
        if (!cancelled) setState("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [clientSlug]);

  function countFor(status: Fp17Status): number {
    return stats?.byStatus.find((s) => s.status === status)?.count ?? 0;
  }

  return (
    <div className="space-y-4">
      {/* The staff-facing honesty banner — always shown, never omitted for tidiness. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-tint-blue-line bg-tint-blue/40 px-3.5 py-3">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-status-blue" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-navy">{FP17_COPY.notCompassStaff}</p>
      </div>

      {state === "ok" && stats ? (
        <div className="flex flex-wrap items-start gap-x-7 gap-y-4">
          <StatCard label="Total declarations" value={stats.total} emphasis />
          <StatCard label="New" value={countFor("new")} dot="bg-status-blue" />
          <StatCard label="Reviewed" value={countFor("reviewed")} dot="bg-status-green" />
          <StatCard label="Archived" value={countFor("archived")} dot="bg-[#c7cede]" />
        </div>
      ) : null}

      <SectionCard title="Declarations" description="Consent + NHS exemption declarations patients have completed, newest first.">
        {state === "loading" ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="motion-safe:animate-spin" />
            Loading declarations…
          </div>
        ) : state === "error" ? (
          <div className="flex items-start gap-3 rounded-xl border border-tint-red-line bg-tint-red/40 px-4 py-4">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-status-red" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-navy">Declarations could not be loaded</p>
              <p className="mt-1 text-[13px] text-muted">{FP17_COPY.readFailed}</p>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No declarations yet"
            description="When a patient completes their consent + exemption declaration from their link, it will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3 font-semibold">Patient</th>
                  <th className="py-2 pr-3 font-semibold">Declaration</th>
                  <th className="py-2 pr-3 font-semibold">Evidence</th>
                  <th className="py-2 pr-3 font-semibold">Signed</th>
                  <th className="py-2 pr-3 font-semibold">Captured</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const isPaying = d.exemptionCategory === PAYING_KEY;
                  const label = declarationChoiceLabel(d.exemptionCategory) ?? d.exemptionCategory;
                  return (
                    <tr key={d.id} className="border-b border-line/70 align-top">
                      <td className="py-2.5 pr-3">
                        <span className="block font-medium text-navy">{d.patientName || "—"}</span>
                        {d.dateOfBirth ? <span className="block text-xs text-muted">{d.dateOfBirth}</span> : null}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="block max-w-[320px] text-[13px] text-ink">{label}</span>
                        <span className="mt-1 inline-block">
                          {isPaying ? (
                            <StatusPill tone="neutral">Paying</StatusPill>
                          ) : (
                            <StatusPill tone="success">Exemption claimed</StatusPill>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-[13px] text-muted">
                        {isPaying ? "—" : d.exemptionEvidenceAck ? "Acknowledged" : "Not acknowledged"}
                      </td>
                      <td className="py-2.5 pr-3 text-[13px] text-muted">
                        {d.signature ? `Typed (${d.signature.method})` : "—"}
                      </td>
                      <td className="py-2.5 pr-3 text-[13px] text-muted">{formatDate(d.createdAt)}</td>
                      <td className="py-2.5 pr-3">
                        <StatusPill tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</StatusPill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
