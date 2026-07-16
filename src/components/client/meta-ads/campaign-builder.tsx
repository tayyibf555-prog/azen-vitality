"use client";

import { useState } from "react";
import {
  Loader2,
  Sparkles,
  Save,
  Image as ImageIcon,
  Film,
  Video,
  GalleryHorizontalEnd,
  ThumbsUp,
  MessageCircle,
  Share2,
  ShieldCheck,
  Info,
  LayoutTemplate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { AdFormat, Campaign, CampaignTemplate } from "@/lib/meta-ads/types";
import { CAMPAIGN_TEMPLATES } from "@/lib/meta-ads/knowledge";
import { budget, formatLabel, formatShort, objectiveLabel } from "./format";

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

// The ad copy currently shown in the preview. Starts as the template's starter
// copy and is replaced wholesale when the AI generates fresh copy.
interface AdCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  complianceNote: string;
}

function starterCopy(template: CampaignTemplate): AdCopy {
  return {
    headline: template.copy.headline,
    primaryText: template.copy.primaryText,
    description: template.copy.description,
    cta: template.cta,
    complianceNote: template.complianceNote,
  };
}

const FORMAT_ICON: Record<AdFormat, typeof ImageIcon> = {
  reel: Film,
  image: ImageIcon,
  carousel: GalleryHorizontalEnd,
  video: Video,
};

// A small pill listing one ad format.
function FormatPill({ format }: { format: AdFormat }) {
  const Icon = FORMAT_ICON[format];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-xs font-medium text-ink">
      <Icon size={12} /> {formatShort(format)}
    </span>
  );
}

// A selectable template card in the left column.
function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: CampaignTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-xl border bg-card px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40",
        selected
          ? "border-blue-dark bg-blue-dark/[0.04] shadow-[0_0_0_1px_var(--blue-dark)]"
          : "border-line hover:border-line-strong hover:bg-card-muted/60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-navy">{template.name}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
          {objectiveLabel(template.objective)}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink">{template.treatment}</p>
      <p className="mt-1.5 text-xs text-muted">{template.offer}</p>
    </button>
  );
}

// The faux Meta ad card: a realistic preview of how the copy reads in-feed.
function AdPreview({
  practiceName,
  copy,
  format,
}: {
  practiceName: string;
  copy: AdCopy;
  format: AdFormat;
}) {
  const FormatIcon = FORMAT_ICON[format];
  const initial = practiceName.trim().charAt(0).toUpperCase() || "V";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
      {/* Header: page identity */}
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy text-sm font-semibold text-on-navy">
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-navy">{practiceName}</p>
          <p className="text-[11px] text-muted">Sponsored</p>
        </div>
      </div>

      {/* Primary text */}
      <p className="px-3.5 pb-3 text-sm leading-relaxed text-ink">{copy.primaryText}</p>

      {/* Creative placeholder, labelled with the format */}
      <div className="flex h-44 flex-col items-center justify-center gap-1.5 border-y border-line bg-card-muted text-muted">
        <FormatIcon size={26} />
        <span className="text-xs font-medium">{formatLabel(format)}</span>
        <span className="text-[11px]">Creative goes here</span>
      </div>

      {/* CTA row, Meta-style */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          {copy.description ? (
            <p className="text-[11px] uppercase tracking-wide text-muted">{copy.description}</p>
          ) : null}
          <p className="truncate text-sm font-semibold text-navy">{copy.headline}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-card-muted px-3 py-1.5 text-xs font-semibold text-navy ring-1 ring-line-strong">
          {copy.cta || "Learn more"}
        </span>
      </div>

      {/* Engagement footer, purely illustrative */}
      <div className="flex items-center gap-5 border-t border-line px-3.5 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <ThumbsUp size={13} /> Like
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageCircle size={13} /> Comment
        </span>
        <span className="inline-flex items-center gap-1">
          <Share2 size={13} /> Share
        </span>
      </div>
    </div>
  );
}

interface GenerateResponse {
  ok?: boolean;
  copy?: AdCopy;
  error?: string;
}

export function CampaignBuilder({
  clientSlug,
  practiceName,
  onSaveDraft,
  onOpenGuide,
  onOpenLanding,
}: {
  clientSlug: string;
  practiceName: string;
  /** Persist a draft campaign in the workspace and jump to the Campaigns tab. */
  onSaveDraft: (draft: Campaign) => void;
  /** Jump to the Guide tab (launching the live ad happens in Meta). */
  onOpenGuide: () => void;
  /** Jump to the Landing pages tab to add a custom destination for this campaign. */
  onOpenLanding: () => void;
}) {
  const [templateId, setTemplateId] = useState<string>(CAMPAIGN_TEMPLATES[0]?.id ?? "");
  const template = CAMPAIGN_TEMPLATES.find((t) => t.id === templateId) ?? CAMPAIGN_TEMPLATES[0];

  const [offer, setOffer] = useState("");
  const [angle, setAngle] = useState("");
  const [copy, setCopy] = useState<AdCopy>(() => starterCopy(template));
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  function selectTemplate(id: string) {
    const next = CAMPAIGN_TEMPLATES.find((t) => t.id === id);
    if (!next) return;
    setTemplateId(id);
    setCopy(starterCopy(next));
    setOffer("");
    setAngle("");
    setGenError(null);
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/meta-ads/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          treatment: template.treatment,
          offer: offer.trim() || undefined,
          angle: angle.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as GenerateResponse;
      if (!res.ok || !data.ok || !data.copy) {
        throw new Error(data.error || "Could not generate copy just now.");
      }
      setCopy(data.copy);
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : "Could not generate copy just now. Please try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  function saveDraft() {
    const draft: Campaign = {
      id: `draft-${Date.now()}`,
      name: copy.headline.trim() || template.name,
      treatment: template.treatment,
      objective: template.objective,
      status: "draft",
      dailyBudgetGbp: template.dailyBudgetGbp.min,
      startedAt: null,
      metrics: {
        spendGbp: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        ctr: 0,
        cpmGbp: 0,
        leads: 0,
        cplGbp: 0,
        bookings: 0,
        costPerBookingGbp: 0,
        roughReturnX: 0,
      },
    };
    onSaveDraft(draft);
  }

  const previewFormat = template.formats[0] ?? "image";

  return (
    <SectionCard
      title="Create a campaign"
      description="Pick a ready-made template, tailor the offer and tone, then generate compliant ad copy with AI. Save it as a draft here, then launch the live ad in Meta."
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Left: template picker */}
        <div className="space-y-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            1. Choose a template
          </p>
          <div className="space-y-2.5">
            {CAMPAIGN_TEMPLATES.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                selected={t.id === templateId}
                onSelect={() => selectTemplate(t.id)}
              />
            ))}
          </div>
        </div>

        {/* Right: details, inputs, generation, preview */}
        <div className="space-y-5">
          {/* Template summary */}
          <div className="rounded-xl border border-line bg-card-muted/50 p-4">
            <h4 className="text-sm font-semibold text-navy">{template.name}</h4>
            <p className="mt-1 text-sm text-ink">{template.goal}</p>

            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Audience
                </dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-ink">{template.audience}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Daily budget
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-navy">
                  {budget(template.dailyBudgetGbp.min)} to {budget(template.dailyBudgetGbp.max)} a day
                </dd>
                <dt className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Call to action
                </dt>
                <dd className="mt-0.5 text-sm text-ink">{template.cta}</dd>
                <dt className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Formats
                </dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {template.formats.map((f) => (
                    <FormatPill key={f} format={f} />
                  ))}
                </dd>
              </div>
            </dl>
          </div>

          {/* Optional inputs */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="mb-offer" className={labelClass}>
                Offer (optional)
              </label>
              <input
                id="mb-offer"
                type="text"
                value={offer}
                onChange={(e) => setOffer(e.target.value)}
                placeholder={template.offer}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="mb-angle" className={labelClass}>
                Angle or tone (optional)
              </label>
              <input
                id="mb-angle"
                type="text"
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                placeholder="Warm and reassuring, aimed at nervous patients"
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="primary" size="sm" onClick={generate} disabled={generating}>
              {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {generating ? "Writing your copy..." : "Generate ad copy with AI"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={saveDraft} disabled={generating}>
              <Save size={15} /> Save as draft
            </Button>
          </div>

          {genError ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
              {genError}
            </p>
          ) : null}

          {/* Preview */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              2. Preview your ad
            </p>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
              <AdPreview practiceName={practiceName} copy={copy} format={previewFormat} />

              <div className="space-y-3">
                {/* Compliance note */}
                <div className="flex gap-2.5 rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-blue-deep" />
                  <div>
                    <p className="text-xs font-semibold text-navy">Compliance note</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink">{copy.complianceNote}</p>
                  </div>
                </div>

                {/* Launch hand-off */}
                <div className="flex gap-2.5 rounded-lg border border-line bg-card-muted/60 px-3 py-2.5">
                  <Info size={16} className="mt-0.5 shrink-0 text-muted" />
                  <div className="text-xs leading-relaxed text-ink">
                    <p className="font-semibold text-navy">Launching the live ad happens in Meta.</p>
                    <p className="mt-0.5">
                      Save this as a draft, then follow the step-by-step launch guide to set it
                      live in Meta Ads Manager.
                    </p>
                    <button
                      type="button"
                      onClick={onOpenGuide}
                      className="mt-1.5 rounded font-semibold text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                    >
                      Open the launch guide
                    </button>
                  </div>
                </div>

                {/* Custom landing page step: point the ad at an on-brand, compliant
                    landing page with a built-in A/B test, instead of a raw profile. */}
                <div className="flex gap-2.5 rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
                  <LayoutTemplate size={16} className="mt-0.5 shrink-0 text-blue-deep" />
                  <div className="text-xs leading-relaxed text-ink">
                    <p className="font-semibold text-navy">Add a custom landing page</p>
                    <p className="mt-0.5">
                      Send this campaign to an on-brand landing page with two AI-written variants to
                      split test, prices pulled from your real price list.
                    </p>
                    <button
                      type="button"
                      onClick={onOpenLanding}
                      className="mt-1.5 rounded font-semibold text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                    >
                      Build a landing page
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
