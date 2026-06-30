"use client";

import { useState } from "react";
import {
  Sparkles,
  Loader2,
  Eye,
  ListChecks,
  Zap,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, type Tone } from "@/components/primitives";
import { KLOES, COMPLIANCE_DISCLAIMER } from "@/lib/compliance/knowledge";
import { READINESS } from "@/lib/compliance/mock";
import type { KloeSummary } from "@/lib/compliance/types";
import { statusTone, statusLabel } from "./status";

interface Priority {
  action: string;
  area: string;
  urgency: "high" | "medium" | "low";
}
interface Assessment {
  priorities: Priority[];
  inspectionView: string;
  quickWins: string[];
}
interface ReadinessResponse {
  ok?: boolean;
  assessment?: Assessment;
  error?: string;
}

const URGENCY: Record<Priority["urgency"], { label: string; tone: Tone }> = {
  high: { label: "High", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
};

// Resolve each fixed KLOE definition to the practice's current roll-up.
const KLOE_SUMMARY_BY_KEY = new Map<KloeSummary["kloe"], KloeSummary>(
  READINESS.kloes.map((k) => [k.kloe, k]),
);

// The AI assessment, rendered above the KLOE cards once generated.
function AssessmentPanel({ assessment }: { assessment: Assessment }) {
  return (
    <div className="space-y-5 rounded-xl border border-line bg-card-muted/50 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-card text-blue-dark shadow-sm">
          <Sparkles size={15} />
        </span>
        <h4 className="text-sm font-semibold text-navy">AI readiness check</h4>
      </div>

      {assessment.inspectionView ? (
        <div className="rounded-lg border border-line bg-card px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
            <Eye size={13} /> Inspection view
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink">{assessment.inspectionView}</p>
        </div>
      ) : null}

      {assessment.priorities.length > 0 ? (
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <ListChecks size={13} /> Priorities
          </p>
          <ol className="mt-2 space-y-2">
            {assessment.priorities.map((p, i) => {
              const u = URGENCY[p.urgency] ?? URGENCY.medium;
              return (
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-lg border border-line bg-card px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-snug text-navy">{p.action}</p>
                    {p.area ? <p className="mt-0.5 text-xs text-muted">{p.area}</p> : null}
                  </div>
                  <StatusPill tone={u.tone} className="shrink-0">
                    {u.label}
                  </StatusPill>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {assessment.quickWins.length > 0 ? (
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
            <Zap size={13} /> Quick wins
          </p>
          <ul className="mt-2 space-y-1.5">
            {assessment.quickWins.map((w, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-dark" />
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// One KLOE card: the CQC question, the practice's score, status pill and open
// items.
function KloeCard({
  label,
  question,
  summary,
}: {
  label: string;
  question: string;
  summary: KloeSummary | undefined;
}) {
  const score = summary?.score ?? 0;
  const status = summary?.status ?? "not_started";
  const openItems = summary?.openItems ?? 0;

  return (
    <div className="flex flex-col rounded-xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-navy">{label}</h4>
        <StatusPill tone={statusTone(status)} className="shrink-0">
          {statusLabel(status)}
        </StatusPill>
      </div>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted">{question}</p>
      <div className="mt-3 flex items-end justify-between gap-2 border-t border-line pt-3">
        <span className="text-2xl font-extrabold tracking-tight tabular-nums text-navy">
          {score}
          <span className="text-sm font-semibold text-muted">/100</span>
        </span>
        <span className="text-xs font-medium text-muted">
          {openItems} open {openItems === 1 ? "item" : "items"}
        </span>
      </div>
    </div>
  );
}

export function ReadinessPanel({ clientSlug }: { clientSlug: string }) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as ReadinessResponse;
      if (!res.ok || !data.ok || !data.assessment) {
        throw new Error(data.error || "Could not run the readiness check just now.");
      }
      setAssessment(data.assessment);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not run the readiness check just now. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="Inspection readiness"
        description="Where the practice stands across the five CQC key lines of enquiry. Run the AI readiness check for a prioritised action plan and an inspection view."
        actions={
          <Button variant="primary" size="sm" onClick={runCheck} disabled={loading}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {loading ? "Reviewing..." : "Run AI readiness check"}
          </Button>
        }
      >
        <div className="space-y-5">
          {error ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
              {error}
            </p>
          ) : null}

          {loading && !assessment ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-card-muted/60 px-6 py-10 text-sm text-muted">
              <Loader2 size={16} className="animate-spin text-blue-dark" />
              Reviewing your current position...
            </div>
          ) : null}

          {assessment ? <AssessmentPanel assessment={assessment} /> : null}

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Five key lines of enquiry
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {KLOES.map((k) => (
                <KloeCard
                  key={k.key}
                  label={k.label}
                  question={k.question}
                  summary={KLOE_SUMMARY_BY_KEY.get(k.key)}
                />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Generated note + disclaimer, kept subtle at the foot of the readiness view. */}
      <div className="rounded-xl border border-line bg-card-muted/50 p-4">
        <div className="flex gap-2.5">
          <Info size={16} className="mt-0.5 shrink-0 text-muted" />
          <div className="space-y-2 text-xs leading-relaxed text-muted">
            <p className="text-ink">{READINESS.generatedNote}</p>
            <p>{COMPLIANCE_DISCLAIMER}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
