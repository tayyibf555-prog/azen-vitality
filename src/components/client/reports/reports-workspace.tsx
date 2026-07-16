"use client";

import { useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  FileText,
  ListChecks,
  Lightbulb,
  Coins,
  UserPlus,
  TrendingUp,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/primitives";
import { money } from "@/components/client/roi/format";
import { buildSnapshot, type ReportPeriod, type ReportSnapshot } from "@/lib/reports/snapshot";

interface ReportSection {
  title: string;
  body: string;
}
interface Report {
  headline: string;
  highlights: string[];
  sections: ReportSection[];
  recommendations: string[];
}
interface ReportResponse {
  ok?: boolean;
  report?: Report;
  error?: string;
}

const PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

// The snapshot numbers, always on screen so there is something to read before
// (and alongside) the AI review. Mirrors the StatCard look but in a compact row.
function SnapshotStrip({ snapshot }: { snapshot: ReportSnapshot }) {
  const items: { label: string; value: string; icon: typeof Coins }[] = [
    { label: "Spend", value: money(snapshot.spendGbp), icon: Coins },
    { label: "New patients", value: String(snapshot.newPatients), icon: UserPlus },
    { label: "Revenue", value: money(snapshot.revenueGbp), icon: TrendingUp },
    { label: "Return on spend", value: `${snapshot.returnX.toFixed(1)}x`, icon: Gauge },
  ];
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Snapshot, {snapshot.windowLabel}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <div
              key={it.label}
              className="rounded-xl border border-line bg-card-muted/40 px-3.5 py-3"
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <Icon size={13} className="text-blue-dark" /> {it.label}
              </p>
              <p className="mt-1 text-xl font-bold tracking-tight tabular-nums text-navy">
                {it.value}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">
        Compliance readiness {snapshot.complianceScore}/100
        {snapshot.auditsOverdue > 0
          ? `, ${snapshot.auditsOverdue} audit${snapshot.auditsOverdue === 1 ? "" : "s"} overdue`
          : ", no audits overdue"}
        {snapshot.topChannel ? ` . Best channel: ${snapshot.topChannel.name} (${snapshot.topChannel.roiX}x)` : ""}
      </p>
    </div>
  );
}

// The generated review, rendered once the model responds: headline, highlights,
// the section cards, and a distinct recommendations list.
function ReportPanel({ report, period }: { report: Report; period: ReportPeriod }) {
  return (
    <div className="space-y-4 rounded-xl border border-line bg-card-muted/50 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-card text-blue-dark shadow-sm">
          <Sparkles size={15} />
        </span>
        <h4 className="text-sm font-semibold text-navy">
          AI {period === "week" ? "weekly" : "monthly"} business review
        </h4>
      </div>

      {report.headline ? (
        <p className="text-base font-semibold leading-snug text-navy">{report.headline}</p>
      ) : null}

      {report.highlights.length > 0 ? (
        <ul className="space-y-1.5">
          {report.highlights.map((h, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-dark" />
              {h}
            </li>
          ))}
        </ul>
      ) : null}

      {report.sections.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {report.sections.map((s, i) => (
            <div key={i} className="rounded-lg border border-line bg-card px-3.5 py-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
                <FileText size={13} /> {s.title}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{s.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      {report.recommendations.length > 0 ? (
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
            <Lightbulb size={13} /> Recommendations
          </p>
          <ol className="mt-2 space-y-2">
            {report.recommendations.map((r, i) => (
              <li
                key={i}
                className="flex items-start gap-2.5 rounded-lg border border-line bg-card px-3.5 py-2.5"
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#f0f4f9] text-[11px] font-semibold text-side-ink">
                  {i + 1}
                </span>
                <p className="text-sm font-medium leading-snug text-navy">{r}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

export function ReportsWorkspace({ clientSlug }: { clientSlug: string }) {
  const [period, setPeriod] = useState<ReportPeriod>("month");
  const [report, setReport] = useState<Report | null>(null);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>("month");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = useMemo(() => buildSnapshot(period), [period]);

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, period }),
      });
      const data = (await res.json().catch(() => ({}))) as ReportResponse;
      if (!res.ok || !data.ok || !data.report) {
        throw new Error(data.error || "Could not generate the report just now.");
      }
      setReport(data.report);
      setReportPeriod(period);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not generate the report just now. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard
      title="Business review"
      description="Choose a window and generate an AI review across acquisition, conversion, lifecycle and compliance, with recommendations."
      actions={
        <Button variant="primary" size="sm" onClick={generate} disabled={loading}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {loading ? "Writing..." : "Generate report"}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Week / Month segmented toggle. */}
        <div
          role="tablist"
          aria-label="Report period"
          className="inline-flex rounded-lg border border-line bg-card-muted p-0.5"
        >
          {PERIODS.map((p) => {
            const active = period === p.key;
            return (
              <button
                key={p.key}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setPeriod(p.key)}
                className={[
                  "rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark focus-visible:ring-offset-1",
                  active ? "bg-card text-navy shadow-sm" : "text-muted hover:text-ink",
                ].join(" ")}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <SnapshotStrip snapshot={snapshot} />

        {error ? (
          <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
            {error}
          </p>
        ) : null}

        {loading && !report ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-card-muted/60 px-6 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin text-blue-dark" />
            Writing your {period === "week" ? "weekly" : "monthly"} review...
          </div>
        ) : null}

        {report ? (
          <ReportPanel report={report} period={reportPeriod} />
        ) : !loading ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line-strong bg-card-muted/40 px-4 py-6 text-sm text-muted">
            <ListChecks size={16} className="shrink-0 text-blue-dark" />
            Generate a report to get a written {period === "week" ? "weekly" : "monthly"} review with
            highlights and recommendations.
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
