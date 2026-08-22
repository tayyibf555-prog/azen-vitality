"use client";

import { useState } from "react";
import {
  Sparkles,
  Loader2,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/primitives";
import type { ReportPeriod, ReportSnapshot } from "@/lib/reports/snapshot";
import { periodWord } from "@/lib/reports/period-word";

/** A first-response time in plain English ("42s" / "3m"). */
function responseLabel(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

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

// The real snapshot numbers, always on screen so there is something to read before
// (and alongside) the AI review: the inline dot-prefixed numeral row, not tiles.
// Every figure here is live activity, never an estimate.
function SnapshotStrip({ snapshot }: { snapshot: ReportSnapshot }) {
  // A COUNT WE CANNOT STAND BEHIND IS NOT SHOWN. A failed read would otherwise
  // render as four zeroes, which on this strip is indistinguishable from a quiet
  // week and is acted on as one; counts that are a floor would render as totals.
  //
  // A BUSY PERIOD IS NO LONGER ONE OF THOSE CASES. `countsExact` means the enquiry
  // and booking figures were counted in the store rather than measured off a bounded
  // sample, so they are totals however busy the period was; only the two sampled
  // figures below carry a caveat. The blank stays for the period whose count itself
  // could not be made.
  if (snapshot.readFailed || (snapshot.truncated && !snapshot.countsExact)) {
    return (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Live snapshot, {snapshot.windowLabel}
        </p>
        <p className="mt-3 text-xs text-muted">
          {snapshot.readFailed
            ? "Your live enquiry activity could not be read just now, so these figures are not shown. This is a read failing, not a quiet period."
            : "This period holds more enquiries than a single read carries, so these figures would be a floor rather than a total. They are not shown from a partial count."}
        </p>
      </div>
    );
  }

  const items: { label: string; value: string; dot: string }[] = [
    { label: "Enquiries", value: String(snapshot.enquiries), dot: "bg-status-blue" },
    { label: "Booked", value: String(snapshot.booked), dot: "bg-status-green" },
    {
      label: "Enquiry to booked",
      value: `${Math.round(snapshot.enquiryToBookedRate * 100)}%`,
      dot: "bg-status-blue",
    },
    {
      label: "Avg first response",
      value: responseLabel(snapshot.avgFirstResponseSeconds),
      dot: "bg-status-amber",
    },
  ];
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Live snapshot, {snapshot.windowLabel}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-7 gap-y-4">
        {items.map((it) => (
          <div key={it.label}>
            <p className="text-[20px] font-bold tabular-nums tracking-[-0.3px] text-navy">
              <i aria-hidden className={`mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[2px] ${it.dot}`} />
              {it.value}
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-muted">{it.label}</p>
          </div>
        ))}
      </div>
      {snapshot.topSource ? (
        <p className="mt-3 text-xs text-muted">
          Most common source: {snapshot.topSource.source} ({snapshot.topSource.count})
        </p>
      ) : null}
      {/* WHICH OF THESE FIGURES IS A TOTAL, SAID ON THE STRIP ITSELF. Enquiries and
          bookings are counted; the response time and the source mix need the enquiry
          records themselves and that read is bounded, so on a period past the bound
          they describe its most recent enquiries. Shown here rather than left to the
          AI review, because the numbers above are read long before anyone presses
          generate. */}
      {snapshot.truncated ? (
        <p className="mt-3 text-xs text-muted">
          Your enquiries and bookings are counted in full for this period. The average first
          response and most common source are measured over the most recent enquiries in it,
          not all of them.
        </p>
      ) : null}
    </div>
  );
}

// The generated review, rendered once the model responds, in the flat hairline
// language: a titled hairline section, highlight bullets, each report section as
// a 600-weight title over its body, and a numbered hairline recommendations list.
function ReportPanel({ report, period }: { report: Report; period: ReportPeriod }) {
  return (
    <section className="space-y-4">
      <h4 className="flex items-center gap-2 border-b border-line pb-2.5 text-title text-navy">
        <Sparkles size={14} className="text-blue-royal" />
        AI {periodWord(period)} business review
      </h4>

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
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {report.sections.map((s, i) => (
            <div key={i} className="border-t border-line pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-deep">{s.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{s.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      {report.recommendations.length > 0 ? (
        <div className="border-t border-line pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-deep">Recommendations</p>
          <ol className="mt-1 divide-y divide-line">
            {report.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2.5 py-2.5">
                <span className="mt-0.5 text-[13px] font-semibold tabular-nums text-faint">{i + 1}.</span>
                <p className="text-sm font-medium leading-snug text-navy">{r}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

export function ReportsWorkspace({
  clientSlug,
  snapshots,
  defaultPeriod = "month",
}: {
  clientSlug: string;
  /** Real per-period snapshots, computed server-side from live activity. */
  snapshots: Record<ReportPeriod, ReportSnapshot>;
  /**
   * The tab to open on. The month is the headline window and stays the default, but
   * the page hands over the WEEK when the month is the unusable one: landing an
   * owner on a tab that can only explain itself is a worse first screen than landing
   * her on the period we can actually show. Both tabs remain reachable either way.
   */
  defaultPeriod?: ReportPeriod;
}) {
  const [period, setPeriod] = useState<ReportPeriod>(defaultPeriod);
  const [report, setReport] = useState<Report | null>(null);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>(defaultPeriod);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = snapshots[period];

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
            <Loader2 size={16} className="animate-spin text-muted" />
            Writing your {periodWord(period)} review...
          </div>
        ) : null}

        {report ? (
          <ReportPanel report={report} period={reportPeriod} />
        ) : !loading ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line-strong bg-card-muted/40 px-4 py-6 text-sm text-muted">
            <ListChecks size={16} className="shrink-0 text-muted" />
            Generate a report to get a written {periodWord(period)} review with
            highlights and recommendations.
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
