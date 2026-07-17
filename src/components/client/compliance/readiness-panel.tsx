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

// The AI assessment, a flat hairline section rendered above the KLOE table.
function AssessmentPanel({ assessment }: { assessment: Assessment }) {
  return (
    <section className="space-y-4">
      <h4 className="flex items-center gap-2 border-b border-line pb-2.5 text-title text-navy">
        <Sparkles size={14} className="text-blue-royal" />
        AI readiness check
      </h4>

      {assessment.inspectionView ? (
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
            <Eye size={13} /> Inspection view
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink">{assessment.inspectionView}</p>
        </div>
      ) : null}

      {assessment.priorities.length > 0 ? (
        <div className="border-t border-line pt-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <ListChecks size={13} /> Priorities
          </p>
          <ol className="mt-1 divide-y divide-line">
            {assessment.priorities.map((p, i) => {
              const u = URGENCY[p.urgency] ?? URGENCY.medium;
              return (
                <li key={i} className="flex items-start justify-between gap-3 py-2.5">
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
        <div className="border-t border-line pt-3">
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
    </section>
  );
}

// One KLOE row in the hairline table: the CQC question under the domain, with
// the score numeral, open items and status on the right.
function KloeRow({
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
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3.5 last:border-0">
      <div className="min-w-0 max-w-xl flex-1 basis-64">
        <h4 className="text-sm font-semibold text-navy">{label}</h4>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{question}</p>
      </div>
      <div className="flex shrink-0 items-center gap-5">
        <span className="text-xs font-medium text-muted">
          {openItems} open {openItems === 1 ? "item" : "items"}
        </span>
        <span className="w-20 text-right text-[20px] font-bold tracking-[-0.3px] tabular-nums text-navy">
          {score}
          <span className="text-sm font-semibold text-muted">/100</span>
        </span>
        <StatusPill tone={statusTone(status)} className="shrink-0">
          {statusLabel(status)}
        </StatusPill>
      </div>
    </li>
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
            <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-sm text-status-amber">
              {error}
            </p>
          ) : null}

          {loading && !assessment ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-card-muted/60 px-6 py-10 text-sm text-muted">
              <Loader2 size={16} className="animate-spin text-muted" />
              Reviewing your current position...
            </div>
          ) : null}

          {assessment ? <AssessmentPanel assessment={assessment} /> : null}

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Five key lines of enquiry
            </p>
            <ul className="mt-1">
              {KLOES.map((k) => (
                <KloeRow
                  key={k.key}
                  label={k.label}
                  question={k.question}
                  summary={KLOE_SUMMARY_BY_KEY.get(k.key)}
                />
              ))}
            </ul>
          </div>
        </div>
      </SectionCard>

      {/* Generated note + disclaimer, kept subtle at the foot of the readiness view. */}
      <div className="flex gap-2.5 border-t border-line pt-4">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <div className="space-y-2 text-xs leading-relaxed text-muted">
          <p className="text-ink">{READINESS.generatedNote}</p>
          <p>{COMPLIANCE_DISCLAIMER}</p>
        </div>
      </div>
    </div>
  );
}
