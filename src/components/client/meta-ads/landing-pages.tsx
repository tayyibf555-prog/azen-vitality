"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Sparkles,
  Copy,
  Check,
  ExternalLink,
  Rocket,
  Archive,
  Trophy,
  LayoutTemplate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { TREATMENTS } from "@/lib/treatments/catalog";
import type { LandingPageContent, CtaTarget } from "@/lib/landing/content";
import type { LandingPage, LandingPageStatus } from "@/lib/landing/types";
import type { VariantKey } from "@/lib/landing/winner";
import { decideAutoPromotion, type VariantCounters } from "@/lib/landing/winner";
import { LandingContent } from "@/components/landing/landing-content";

// The "Landing pages" step inside the Meta Ads section: generate an AI-written,
// compliance-linted landing page with two split-test variants, preview both, then
// publish. The results card reads per-variant counters from the funnel summary
// seam (see fetchVariantResults) and degrades to "collecting data" until that
// endpoint lands. No nav changes: this lives entirely within the Meta Ads workspace.

type AdminPage = LandingPage & { url: string; path: string };
type DetailPage = AdminPage & { previewUrl: string | null; previewPath: string | null };
interface Variant {
  id: string;
  variantKey: VariantKey;
  content: LandingPageContent;
  status: "active" | "retired";
}

const STATUS_TONE: Record<LandingPageStatus, Tone> = {
  draft: "warning",
  live: "success",
  archived: "neutral",
};

// Treatments the generator supports (those with a hand-written safe default, so a
// double lint failure can still fall back). Ordered marketing-first. Exported so the
// workspace can decide whether a "Recreate this" treatment can be pre-selected here.
export const LANDING_TREATMENT_KEYS = ["invisalign", "implant", "veneers", "whitening", "checkup", "hygiene"];

const TREATMENT_OPTIONS = TREATMENTS.filter((t) => LANDING_TREATMENT_KEYS.includes(t.key)).sort(
  (a, b) => LANDING_TREATMENT_KEYS.indexOf(a.key) - LANDING_TREATMENT_KEYS.indexOf(b.key),
);

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

/** Fetch a client's landing pages (no setState) so both the mount effect and the
 *  post-action refresh can reuse it. Returns [] on any failure. */
async function fetchPagesList(clientSlug: string): Promise<AdminPage[]> {
  try {
    const res = await fetch(`/api/landing-pages?client=${encodeURIComponent(clientSlug)}`);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; pages?: AdminPage[] };
    return res.ok && data.ok && Array.isArray(data.pages) ? data.pages : [];
  } catch {
    return [];
  }
}

export function LandingPagesTab({
  clientSlug,
  practiceName,
  initialTreatment,
}: {
  clientSlug: string;
  practiceName: string;
  /** Pre-selected treatment key, seeded by "Recreate this" from the ad library. */
  initialTreatment?: string;
}) {
  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [treatment, setTreatment] = useState<string>(() => {
    const seeded = initialTreatment && LANDING_TREATMENT_KEYS.includes(initialTreatment) ? initialTreatment : null;
    return seeded ?? TREATMENT_OPTIONS[0]?.key ?? "invisalign";
  });
  const [angle, setAngle] = useState("");
  const [ctaTarget, setCtaTarget] = useState<CtaTarget>("assessment");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [active, setActive] = useState<{ page: DetailPage; variants: Variant[] } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Post-action refresh (called from event handlers, not an effect).
  const loadPages = useCallback(async () => {
    setPages(await fetchPagesList(clientSlug));
  }, [clientSlug]);

  // Initial load on mount / client change. setState only inside the async .then,
  // guarded by `active`, so no synchronous setState in the effect body.
  useEffect(() => {
    let active = true;
    fetchPagesList(clientSlug).then((p) => {
      if (active) setPages(p);
    });
    return () => {
      active = false;
    };
  }, [clientSlug]);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/landing-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, treatment, angle: angle.trim() || undefined, ctaTarget }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        page?: DetailPage;
        variants?: Variant[];
        error?: string;
      };
      if (!res.ok || !data.ok || !data.page || !data.variants) {
        throw new Error(data.error || "Could not generate the landing page just now.");
      }
      setActive({ page: { ...data.page, previewUrl: null, previewPath: null }, variants: data.variants });
      await loadPages();
      // Fetch the detail to get the preview link (with token) for the fresh draft.
      void openDetail(data.page.id);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Could not generate the landing page.");
    } finally {
      setGenerating(false);
    }
  }

  const openDetail = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/landing-pages/${id}?client=${encodeURIComponent(clientSlug)}`);
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          page?: DetailPage;
          variants?: Variant[];
        };
        if (res.ok && data.ok && data.page && data.variants) {
          setActive({ page: data.page, variants: data.variants });
        }
      } catch {
        // Non-fatal: keep whatever is shown.
      }
    },
    [clientSlug],
  );

  async function runAction(id: string, body: Record<string, unknown>) {
    setActionBusy(true);
    try {
      await fetch(`/api/landing-pages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, ...body }),
      });
      await loadPages();
      await openDetail(id);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="Custom landing page"
        description="Generate an on-brand landing page for this campaign, with two AI-written variants to split test. Every variant is compliance-checked and prices are pulled from your real price list."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="lp-treatment" className={labelClass}>
              Treatment
            </label>
            <select
              id="lp-treatment"
              value={treatment}
              onChange={(e) => setTreatment(e.target.value)}
              className={inputClass}
            >
              {TREATMENT_OPTIONS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="lp-cta" className={labelClass}>
              Where the button goes
            </label>
            <select
              id="lp-cta"
              value={ctaTarget}
              onChange={(e) => setCtaTarget(e.target.value as CtaTarget)}
              className={inputClass}
            >
              <option value="assessment">Smile assessment</option>
              <option value="booking">Booking page</option>
            </select>
          </div>
          <div>
            <label htmlFor="lp-angle" className={labelClass}>
              Angle or audience (optional)
            </label>
            <input
              id="lp-angle"
              type="text"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              placeholder="Nervous patients, busy professionals..."
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" variant="primary" size="sm" onClick={generate} disabled={generating}>
            {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {generating ? "Writing both variants..." : "Generate landing page"}
          </Button>
          <span className="text-xs text-muted">Creates a draft with variants A and B. Nothing goes live until you publish.</span>
        </div>

        {genError ? (
          <p className="mt-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
            {genError}
          </p>
        ) : null}
      </SectionCard>

      {active ? (
        <ActivePanel
          clientSlug={clientSlug}
          practiceName={practiceName}
          page={active.page}
          variants={active.variants}
          busy={actionBusy}
          onPublish={() => runAction(active.page.id, { action: "publish" })}
          onArchive={() => runAction(active.page.id, { action: "archive" })}
          onPromote={(v) => runAction(active.page.id, { action: "promote-winner", variant: v })}
        />
      ) : null}

      <SectionCard title="Your landing pages" description="Draft, live and archived pages for this practice.">
        {pages === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading...
          </div>
        ) : pages.length === 0 ? (
          <EmptyState
            icon={LayoutTemplate}
            title="No landing pages yet"
            description="Generate your first campaign landing page above."
          />
        ) : (
          <ul className="divide-y divide-line">
            {pages.map((p) => (
              <PageRow
                key={p.id}
                page={p}
                onManage={() => openDetail(p.id)}
                selected={active?.page.id === p.id}
              />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function PageRow({
  page,
  onManage,
  selected,
}: {
  page: AdminPage;
  onManage: () => void;
  selected: boolean;
}) {
  const treatmentName = TREATMENTS.find((t) => t.key === page.treatment)?.name ?? page.treatment;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-navy">{treatmentName}</span>
          <StatusPill tone={STATUS_TONE[page.status]}>{page.status}</StatusPill>
          {page.winnerVariant ? (
            <StatusPill tone="info">Winner {page.winnerVariant.toUpperCase()}</StatusPill>
          ) : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted">{page.path}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <CopyLinkButton url={page.url} />
        <Button asChild variant="ghost" size="sm">
          <a href={page.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Open
          </a>
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onManage}>
          {selected ? "Managing" : "Manage"}
        </Button>
      </div>
    </li>
  );
}

function ActivePanel({
  clientSlug,
  practiceName,
  page,
  variants,
  busy,
  onPublish,
  onArchive,
  onPromote,
}: {
  clientSlug: string;
  practiceName: string;
  page: DetailPage;
  variants: Variant[];
  busy: boolean;
  onPublish: () => void;
  onArchive: () => void;
  onPromote: (v: VariantKey) => void;
}) {
  const a = variants.find((v) => v.variantKey === "a");
  const b = variants.find((v) => v.variantKey === "b");

  return (
    <SectionCard
      title="Preview and publish"
      description="Two variants, shown at a glance. Publish to take the page live, then split traffic 50/50 and promote a winner."
      actions={<StatusPill tone={STATUS_TONE[page.status]}>{page.status}</StatusPill>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {a ? (
          <MiniPreview
            label="Variant A (confidence-led)"
            clientSlug={clientSlug}
            practiceName={practiceName}
            page={page}
            variant={a}
            winner={page.winnerVariant}
          />
        ) : null}
        {b ? (
          <MiniPreview
            label="Variant B (value-led)"
            clientSlug={clientSlug}
            practiceName={practiceName}
            page={page}
            variant={b}
            winner={page.winnerVariant}
          />
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {page.status === "draft" ? (
          <Button type="button" variant="primary" size="sm" onClick={onPublish} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} Publish
          </Button>
        ) : null}
        {page.status === "draft" && page.previewUrl ? <CopyLinkButton url={page.previewUrl} label="Copy preview link" /> : null}
        {page.status !== "archived" ? (
          <Button type="button" variant="secondary" size="sm" onClick={onArchive} disabled={busy}>
            <Archive size={15} /> Archive
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm">
          <a href={page.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Open live URL
          </a>
        </Button>
      </div>

      <ResultsCard
        clientSlug={clientSlug}
        landingSlug={page.slug}
        status={page.status}
        winner={page.winnerVariant}
        autoPromote={page.autoPromote}
        busy={busy}
        onPromote={onPromote}
      />
    </SectionCard>
  );
}

function MiniPreview({
  label,
  clientSlug,
  practiceName,
  page,
  variant,
  winner,
}: {
  label: string;
  clientSlug: string;
  practiceName: string;
  page: DetailPage;
  variant: Variant;
  winner: VariantKey | null;
}) {
  const isWinner = winner === variant.variantKey;
  const isRetired = variant.status === "retired";
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold text-navy">{label}</span>
        {isWinner ? (
          <StatusPill tone="info">
            <Trophy size={12} /> Winner
          </StatusPill>
        ) : isRetired ? (
          <StatusPill tone="neutral">Retired</StatusPill>
        ) : null}
      </div>
      {/* Scaled, non-interactive render of the SAME vetted content component. */}
      <div className="relative h-[360px] overflow-hidden bg-cream">
        <div className="pointer-events-none absolute left-0 top-0 w-[140%] origin-top-left scale-[0.7]">
          <LandingContent
            content={variant.content}
            practiceName={practiceName}
            clientSlug={clientSlug}
            landingSlug={page.slug}
            variant={variant.variantKey}
            siteId={page.siteId}
            preview
          />
        </div>
      </div>
    </div>
  );
}

/* ---- Results scaffold ----------------------------------------------------- */

// !!! INTEGRATION SEAM (results summary) !!!
// A parallel workstream owns the funnel events + their aggregation. This is the
// SINGLE place that reaches for a per-variant summary; it degrades to null (and the
// card shows "collecting data") until that endpoint exists. Fable 5 reconciles the
// exact shape at integration.
async function fetchVariantResults(
  clientSlug: string,
  landingSlug: string,
): Promise<{ a: VariantCounters; b: VariantCounters } | null> {
  try {
    const res = await fetch(
      `/api/funnel-event/summary?surface=landing&client=${encodeURIComponent(clientSlug)}&landing=${encodeURIComponent(landingSlug)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      variants?: { a?: Partial<VariantCounters>; b?: Partial<VariantCounters> };
    } | null;
    if (!data?.ok || !data.variants) return null;
    const norm = (c?: Partial<VariantCounters>): VariantCounters => ({
      views: Number(c?.views ?? 0),
      ctaClicks: Number(c?.ctaClicks ?? 0),
      leads: Number(c?.leads ?? 0),
    });
    return { a: norm(data.variants.a), b: norm(data.variants.b) };
  } catch {
    return null;
  }
}

function ResultsCard({
  clientSlug,
  landingSlug,
  status,
  winner,
  autoPromote,
  busy,
  onPromote,
}: {
  clientSlug: string;
  landingSlug: string;
  status: LandingPageStatus;
  winner: VariantKey | null;
  autoPromote: boolean;
  busy: boolean;
  onPromote: (v: VariantKey) => void;
}) {
  const [results, setResults] = useState<{ a: VariantCounters; b: VariantCounters } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // setState only inside the async .then/.catch, guarded by `alive`. On a dep
  // change the previous numbers stay visible until the refetch resolves.
  useEffect(() => {
    let alive = true;
    fetchVariantResults(clientSlug, landingSlug)
      .then((r) => {
        if (alive) {
          setResults(r);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) {
          setResults(null);
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [clientSlug, landingSlug, status, winner]);

  const suggestion = results ? decideAutoPromotion({ a: results.a, b: results.b }) : null;

  return (
    <div className="mt-5 rounded-2xl border border-line bg-card-muted/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-navy">Split test results</h4>
        <span className="text-xs text-muted">
          Auto-promote {autoPromote ? "on" : "off"}
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {(["a", "b"] as VariantKey[]).map((v) => {
          const c = results?.[v];
          return (
            <div key={v} className="rounded-xl border border-line bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-navy">Variant {v.toUpperCase()}</span>
                {winner === v ? (
                  <StatusPill tone="info">
                    <Trophy size={12} /> Winner
                  </StatusPill>
                ) : null}
              </div>
              {loaded && c ? (
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <Stat label="Views" value={c.views} />
                  <Stat label="Clicks" value={c.ctaClicks} />
                  <Stat label="Leads" value={c.leads} />
                </dl>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {loaded ? "Collecting data" : "Loading..."}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {suggestion && suggestion.promote ? (
        <p className="mt-3 rounded-lg border border-blue-royal/20 bg-blue-royal/[0.06] px-3 py-2 text-xs text-navy">
          {suggestion.reason}
        </p>
      ) : null}

      {status !== "archived" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted">Promote a winner:</span>
          {(["a", "b"] as VariantKey[]).map((v) => (
            <Button
              key={v}
              type="button"
              variant={winner === v ? "primary" : "secondary"}
              size="sm"
              onClick={() => onPromote(v)}
              disabled={busy}
            >
              <Trophy size={14} /> Variant {v.toUpperCase()}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="text-sm font-bold tabular-nums text-navy">{value.toLocaleString("en-GB")}</dd>
      <dt className="text-[0.6rem] uppercase tracking-wide text-muted">{label}</dt>
    </div>
  );
}

function CopyLinkButton({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; no-op rather than error.
    }
  }
  return (
    <Button type="button" variant="ghost" size="sm" onClick={copy}>
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </Button>
  );
}
