"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Sparkles,
  Loader2,
  RefreshCw,
  Wand2,
  ImagePlus,
  Download,
  Clock,
  Lightbulb,
  ShieldAlert,
  Info,
  AlertTriangle,
  Film,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, SampleBadge, ProgressMeter, type Tone } from "@/components/primitives";
import type { AdLibraryItem } from "@/lib/meta-ads/types";
import type { CreativeAnalysis, Verdict } from "@/lib/creative/analysis";
import { formatCostPerLead } from "@/lib/creative/benchmarks";

// The creative INTELLIGENCE detail view: a right-hand slide-over opened from an ad
// card. It fetches a grounded AI analysis (score, verdict, six factor bars, why-it-
// works, compliance watch-outs) and a rough cost-per-lead range, keeps the module's
// honesty about sample data, and offers the two recreate actions (copy/landing-page
// flow, and the dormant Higgsfield branded-image seam).

const VERDICT_TONE: Record<Verdict, Tone> = {
  Strong: "success",
  Good: "info",
  Average: "warning",
  Weak: "danger",
};

const FACTORS: { key: keyof CreativeAnalysis["factors"]; label: string }[] = [
  { key: "hook", label: "Hook" },
  { key: "offerClarity", label: "Offer clarity" },
  { key: "credibility", label: "Credibility" },
  { key: "callToAction", label: "Call to action" },
  { key: "audienceFit", label: "Audience fit" },
  { key: "longevitySignal", label: "Longevity signal" },
];

interface AnalysisResponse {
  ok?: boolean;
  analysis?: CreativeAnalysis;
  imageGen?: { available: boolean };
  error?: string;
}

function scoreTone(score: number): string {
  if (score >= 80) return "var(--status-green)";
  if (score >= 65) return "var(--status-blue)";
  if (score >= 45) return "var(--status-amber)";
  return "var(--status-red)";
}

/** Compact circular score ring, coloured by band. No chart library. */
function ScoreRing({ score, verdict }: { score: number; verdict: Verdict }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, score)) / 100) * c;
  return (
    <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
      <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--line)" strokeWidth="7" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={scoreTone(score)}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-2xl font-bold tabular-nums text-navy">{score}</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">/ 100</span>
      </div>
      <span className="sr-only">Score {score} out of 100, verdict {verdict}</span>
    </div>
  );
}

interface RenderView {
  id: string;
  status: "pending" | "complete" | "failed" | "not_configured";
  imageUrl: string | null;
  error: string | null;
  createdAt: string;
}

function renderDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// "Recreate this ad with your branding": the Higgsfield-powered branded-still seam.
// Key absent -> a quiet, honest chip (no dead button). Key present -> an angle-notes
// input, an opt-in to show the real starting price, the generated still with a
// download, and a history of past renders for this practice. AI video is flagged as a
// second phase, honestly, with no control built for it yet.
function RecreateWithBranding({
  clientSlug,
  creativeRef,
  available,
}: {
  clientSlug: string;
  creativeRef: string;
  available: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [angleNotes, setAngleNotes] = useState("");
  const [includePrice, setIncludePrice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renders, setRenders] = useState<RenderView[]>([]);

  // Load the practice's past renders when the seam is active.
  useEffect(() => {
    if (!available) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/creative-recreate?clientSlug=${encodeURIComponent(clientSlug)}`);
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; renders?: RenderView[] };
        if (live && data.ok && Array.isArray(data.renders)) setRenders(data.renders);
      } catch {
        // A missing history is not an error worth showing; the create flow still works.
      }
    })();
    return () => {
      live = false;
    };
  }, [available, clientSlug]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/creative-recreate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, creativeRef, angleNotes, includeFromPrice: includePrice }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        render?: RenderView;
        message?: string;
        error?: string;
      };
      if (data.render) setRenders((prev) => [data.render as RenderView, ...prev]);
      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.message || "Recreating this ad is unavailable right now.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recreating this ad is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  const latest = renders.find((r) => r.status === "complete" && r.imageUrl) ?? null;
  const history = renders.filter((r) => r.id !== latest?.id);

  return (
    <section className="rounded-xl border border-line bg-card-muted/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-navy">Recreate with your branding</p>
        {available ? <StatusPill tone="info">Ready</StatusPill> : null}
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">
        Generate an on-brand still of this idea using your practice name and colours. Nothing is
        invented: no claims, no ratings, no stand-in patients.
      </p>

      {available ? (
        <div className="mt-3 space-y-2.5">
          <label className="block">
            <span className="text-[11px] font-medium text-ink">Angle notes (optional)</span>
            <input
              type="text"
              value={angleNotes}
              onChange={(e) => setAngleNotes(e.target.value)}
              maxLength={200}
              placeholder="e.g. warm, family-friendly, daytime"
              className="mt-1 w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={includePrice}
              onChange={(e) => setIncludePrice(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-line-strong text-blue-dark focus-visible:ring-blue-dark/40"
            />
            Show my real starting price on the image
          </label>
          <Button type="button" variant="primary" size="sm" onClick={generate} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {busy ? "Creating..." : "Recreate with your branding"}
          </Button>

          {error ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-xs text-[#9a6700]">
              {error}
            </p>
          ) : null}

          {latest ? (
            <div className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={latest.imageUrl ?? ""}
                alt="Generated branded creative"
                className="w-full rounded-lg border border-line"
              />
              <Button asChild variant="ghost" size="sm">
                <a href={latest.imageUrl ?? "#"} download target="_blank" rel="noreferrer">
                  <Download size={14} /> Download
                </a>
              </Button>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div className="border-t border-line pt-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
                <ImagePlus size={12} /> Renders
              </p>
              <ul className="mt-1.5 space-y-1">
                {history.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs"
                  >
                    <span className="tabular-nums text-muted">{renderDate(r.createdAt)}</span>
                    <span className="flex items-center gap-2">
                      <StatusPill
                        tone={
                          r.status === "complete"
                            ? "success"
                            : r.status === "failed"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {r.status === "not_configured" ? "not enabled" : r.status}
                      </StatusPill>
                      {r.status === "complete" && r.imageUrl ? (
                        <a
                          href={r.imageUrl}
                          download
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-deep underline-offset-2 hover:underline"
                        >
                          View
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-line bg-card p-2.5">
          <Info size={15} className="mt-0.5 shrink-0 text-blue-deep" />
          <p className="text-xs leading-relaxed text-muted">
            This activates when the Higgsfield key is added. You will then generate an on-brand still
            here from your real practice details, ready to download and post.
          </p>
        </div>
      )}

      <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-2 text-[11px] text-muted">
        <Film size={12} className="shrink-0" /> AI video arrives as a second phase.
      </p>
    </section>
  );
}

export function CreativeDetail({
  ad,
  clientSlug,
  sample,
  onClose,
  onRecreate,
}: {
  ad: AdLibraryItem;
  clientSlug: string;
  sample: boolean;
  onClose: () => void;
  onRecreate: (ad: AdLibraryItem) => void;
}) {
  const [analysis, setAnalysis] = useState<CreativeAnalysis | null>(null);
  const [imageAvailable, setImageAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (regenerate: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/creative-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, creativeRef: ad.id, regenerate }),
        });
        const data = (await res.json().catch(() => ({}))) as AnalysisResponse;
        if (!res.ok || !data.ok || !data.analysis) {
          throw new Error(data.error || "Could not analyse this creative just now.");
        }
        setAnalysis(data.analysis);
        setImageAvailable(Boolean(data.imageGen?.available));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not analyse this creative just now.");
      } finally {
        setLoading(false);
      }
    },
    [ad.id, clientSlug],
  );

  // Fetch on open / when the selected creative changes. setState is guarded by the
  // load() flow; Escape closes the drawer.
  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]"
      />

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Creative analysis: ${ad.headline}`}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-card/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
              <Sparkles size={12} /> Creative intelligence
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-navy">{ad.advertiser}</p>
            <p className="text-xs text-muted">
              {ad.treatment}, {ad.location}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-card-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 px-5 py-5">
          {/* The ad itself */}
          <section className="space-y-2">
            <p className="text-sm font-semibold leading-snug text-navy">{ad.headline}</p>
            <p className="text-xs leading-relaxed text-muted">{ad.primaryText}</p>
            <dl className="space-y-1 text-xs">
              <div className="flex gap-1.5">
                <dt className="shrink-0 font-semibold text-ink">Offer:</dt>
                <dd className="text-muted">{ad.offer}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="shrink-0 font-semibold text-ink">Hook:</dt>
                <dd className="text-muted">{ad.hookType}</dd>
              </div>
            </dl>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock size={12} /> Running {ad.daysRunning} days
              </span>
              {sample ? <SampleBadge /> : null}
            </p>
          </section>

          {/* Loading / error */}
          {loading && !analysis ? (
            <div className="flex items-center gap-2 rounded-xl border border-line bg-card-muted/40 px-4 py-6 text-sm text-muted">
              <Loader2 size={15} className="animate-spin" /> Analysing this creative...
            </div>
          ) : null}

          {error && !analysis ? (
            <div className="rounded-xl border border-warning/25 bg-warning/10 px-4 py-3">
              <p className="text-sm text-[#9a6700]">{error}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => load(false)}>
                <RefreshCw size={14} /> Try again
              </Button>
            </div>
          ) : null}

          {analysis ? (
            <>
              {/* Verdict + score */}
              <section className="rounded-xl border border-line bg-card-muted/40 p-4">
                <div className="flex items-center gap-4">
                  <ScoreRing score={analysis.overallScore} verdict={analysis.verdict} />
                  <div className="min-w-0">
                    <StatusPill tone={VERDICT_TONE[analysis.verdict]}>{analysis.verdict}</StatusPill>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      An AI read of the creative on its hook, offer, credibility, call to action,
                      audience fit and longevity.
                    </p>
                    {analysis.source === "fallback" ? (
                      <span className="mt-2 inline-flex items-center gap-1 rounded-md border border-line-strong bg-card px-2 py-0.5 text-[11px] font-medium text-ink">
                        <Info size={11} /> Quick read
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Factor bars */}
                <ul className="mt-4 space-y-2.5">
                  {FACTORS.map(({ key, label }) => {
                    const val = analysis.factors[key];
                    return (
                      <li key={key}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-ink">{label}</span>
                          <span className="font-semibold tabular-nums text-navy">{val}</span>
                        </div>
                        <ProgressMeter value={val / 100} tone={scoreTone(val)} className="mt-1" />
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Cost per lead */}
              <section className="rounded-xl border border-blue-dark/15 bg-blue-dark/[0.05] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
                  Estimated cost per lead
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-navy">
                  {formatCostPerLead(analysis.costPerLead)}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{analysis.costPerLead.caveat}</p>
              </section>

              {/* Why it works */}
              {analysis.why.length > 0 ? (
                <section>
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
                    <Lightbulb size={13} /> Why this works
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {analysis.why.map((w, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-dark" />
                        {w}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* Watch-outs (compliance first) */}
              {analysis.watchOuts.length > 0 ? (
                <section className="rounded-xl border border-warning/25 bg-warning/10 p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#9a6700]">
                    <ShieldAlert size={13} /> Watch-outs
                  </p>
                  <ul className="mt-2 space-y-2">
                    {analysis.watchOuts.map((w, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-[#9a6700]">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        {w}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* Recreate with your branding (Higgsfield seam) */}
              <RecreateWithBranding clientSlug={clientSlug} creativeRef={ad.id} available={imageAvailable} />
            </>
          ) : null}
        </div>

        {/* Sticky action bar */}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-card/95 px-5 py-3 backdrop-blur">
          <Button type="button" variant="primary" size="sm" onClick={() => onRecreate(ad)}>
            <Wand2 size={15} /> Recreate this
          </Button>
          {analysis ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Regenerate
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
