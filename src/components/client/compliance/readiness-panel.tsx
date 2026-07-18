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
import { KLOES } from "@/lib/compliance/knowledge";

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

// The AI assessment, a flat hairline section rendered above the KLOE reference.
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

// One KLOE row in the hairline reference: the CQC domain, the headline question and
// a short description of what it covers for a dental practice. No score is shown:
// readiness scoring builds from the practice's own records once they are added.
function KloeRow({
  label,
  question,
  description,
}: {
  label: string;
  question: string;
  description: string;
}) {
  return (
    <li className="border-b border-line py-3.5 last:border-0">
      <h4 className="text-sm font-semibold text-navy">{label}</h4>
      <p className="mt-0.5 text-xs font-medium leading-relaxed text-ink">{question}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
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
        description="The five CQC key lines of enquiry your practice is assessed against. Add your records, then run the AI readiness check for a prioritised action plan and an inspection view."
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
                <KloeRow key={k.key} label={k.label} question={k.question} description={k.description} />
              ))}
            </ul>
          </div>
        </div>
      </SectionCard>

      {/* Honest note: readiness scoring builds from the practice's own records. */}
      <div className="flex gap-2.5 border-t border-line pt-4">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          A readiness score for each key line of enquiry builds from your practice&rsquo;s records
          once your audits, policies and training are added. Until then this shows the framework you
          are assessed against.
        </p>
      </div>
    </div>
  );
}
