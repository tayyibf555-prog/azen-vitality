"use client";

import { useState } from "react";
import {
  Sparkles,
  Loader2,
  Image as ImageIcon,
  Film,
  Video,
  GalleryHorizontalEnd,
  AlertTriangle,
  Lightbulb,
  ShieldAlert,
  Clock,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, type Tone } from "@/components/primitives";
import type { AdFormat, AdLibraryItem } from "@/lib/meta-ads/types";
import { MOCK_AD_LIBRARY } from "@/lib/meta-ads/mock";
import { formatShort } from "./format";
import { CreativeDetail } from "./creative-detail";

// The winning-ads library is a curated SAMPLE until the client's Meta account is
// connected. Kept explicit so the detail view can stay honest about that.
const LIBRARY_IS_SAMPLE = true;

const FORMAT_ICON: Record<AdFormat, typeof ImageIcon> = {
  reel: Film,
  image: ImageIcon,
  carousel: GalleryHorizontalEnd,
  video: Video,
};

const PERFORMANCE: Record<AdLibraryItem["estPerformance"], { label: string; tone: Tone }> = {
  strong: { label: "Strong performer", tone: "success" },
  steady: { label: "Steady", tone: "info" },
  new: { label: "Newer", tone: "neutral" },
};

interface Overview {
  patterns: { title: string; insight: string }[];
  whatToTry: string[];
  cautions: string[];
}

interface OverviewResponse {
  ok?: boolean;
  overview?: Overview;
  error?: string;
}

function AdCard({ item, onOpen }: { item: AdLibraryItem; onOpen: () => void }) {
  const FormatIcon = FORMAT_ICON[item.format];
  const perf = PERFORMANCE[item.estPerformance];

  return (
    <li className="flex">
      {/* The whole card is the click target for the analysis detail view. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open AI analysis for ${item.advertiser}: ${item.headline}`}
        className="group flex flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-card text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
      >
      {/* Creative thumbnail placeholder, by format */}
      <div className="relative flex h-28 items-center justify-center bg-card-muted text-muted">
        <FormatIcon size={24} />
        <StatusPill tone={perf.tone} className="absolute right-2.5 top-2.5">
          {perf.label}
        </StatusPill>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-navy">{item.advertiser}</p>
            <p className="text-xs text-muted">{item.location}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-[11px] font-medium text-ink">
            <FormatIcon size={11} /> {formatShort(item.format)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="text-ink">{item.treatment}</span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock size={11} /> Running {item.daysRunning} days
          </span>
        </div>

        <p className="text-sm font-semibold leading-snug text-navy">{item.headline}</p>
        <p className="line-clamp-3 text-xs leading-relaxed text-muted">{item.primaryText}</p>

        <dl className="mt-0.5 space-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt className="shrink-0 font-semibold text-ink">Offer:</dt>
            <dd className="text-muted">{item.offer}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="shrink-0 font-semibold text-ink">Hook:</dt>
            <dd className="text-muted">{item.hookType}</dd>
          </div>
        </dl>

        {/* AI analysis panel */}
        <div className="mt-auto rounded-lg border border-tint-blue-line bg-tint-blue p-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
            <Sparkles size={12} /> Why it works
          </p>
          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink">{item.aiAnalysis}</p>
        </div>

        {/* Compliance flag, if any */}
        {item.complianceFlag ? (
          <div className="flex gap-2 rounded-lg border border-tint-amber-line bg-tint-amber px-2.5 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-amber" />
            <p className="line-clamp-2 text-xs leading-relaxed text-status-amber">{item.complianceFlag}</p>
          </div>
        ) : null}

        {/* Affordance: the whole card opens the scored analysis detail view. */}
        <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-deep transition-colors group-hover:text-blue-dark">
          <Sparkles size={12} /> View AI analysis and cost per lead
          <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
      </button>
    </li>
  );
}

function OverviewPanel({ overview }: { overview: Overview }) {
  return (
    <section className="space-y-4">
      <h4 className="flex items-center gap-2 border-b border-line pb-2.5 text-title text-navy">
        <Sparkles size={14} className="text-blue-royal" />
        AI overview of the library
      </h4>

      {overview.patterns.length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Patterns that are working
          </p>
          <ul className="mt-1 grid gap-x-8 sm:grid-cols-2">
            {overview.patterns.map((p, i) => (
              <li key={i} className="border-b border-line py-2.5 sm:[&:nth-last-child(-n+2)]:border-0 [&:last-child]:border-0">
                <p className="text-sm font-semibold text-navy">{p.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink">{p.insight}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {overview.whatToTry.length > 0 ? (
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
              <Lightbulb size={13} /> What to try
            </p>
            <ul className="mt-2 space-y-1.5">
              {overview.whatToTry.map((t, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-dark" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {overview.cautions.length > 0 ? (
          <div className="rounded-lg border border-tint-amber-line bg-tint-amber p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-status-amber">
              <ShieldAlert size={13} /> Cautions
            </p>
            <ul className="mt-2 space-y-1.5">
              {overview.cautions.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-status-amber">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-status-amber" />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AdLibrary({
  clientSlug,
  onRecreate,
}: {
  clientSlug: string;
  /** Recreate a creative via the landing-page generate flow (owner picks it up). */
  onRecreate?: (item: AdLibraryItem) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdLibraryItem | null>(null);

  async function generateOverview() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/meta-ads/creative-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as OverviewResponse;
      if (!res.ok || !data.ok || !data.overview) {
        throw new Error(data.error || "Could not generate the overview just now.");
      }
      setOverview(data.overview);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not generate the overview just now. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard
      title="Winning ads library"
      description="Winning dental ads from the Meta Ad Library. Pattern-match, do not copy: take the structure and the angle, then write your own compliant version."
      actions={
        <Button variant="primary" size="sm" onClick={generateOverview} disabled={loading}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {loading ? "Analysing..." : "Generate AI overview"}
        </Button>
      }
    >
      <div className="space-y-5">
        {error ? (
          <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
            {error}
          </p>
        ) : null}

        {overview ? <OverviewPanel overview={overview} /> : null}

        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {MOCK_AD_LIBRARY.map((item) => (
            <AdCard key={item.id} item={item} onOpen={() => setSelected(item)} />
          ))}
        </ul>
      </div>

      {selected ? (
        <CreativeDetail
          ad={selected}
          clientSlug={clientSlug}
          sample={LIBRARY_IS_SAMPLE}
          onClose={() => setSelected(null)}
          onRecreate={(item) => {
            setSelected(null);
            onRecreate?.(item);
          }}
        />
      ) : null}
    </SectionCard>
  );
}
