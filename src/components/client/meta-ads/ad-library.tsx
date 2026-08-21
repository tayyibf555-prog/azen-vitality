"use client";

import { useState } from "react";
import {
  Image as ImageIcon,
  Film,
  GalleryHorizontalEnd,
  Clock,
  ExternalLink,
  Images,
  Info,
  Wand2,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  KeyRound,
  ArrowRight,
} from "lucide-react";
import { SectionCard, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import type { Campaign } from "@/lib/meta-ads/types";
import type { StoredWinningAd } from "@/lib/meta-ads/winning-repository";
import { winningSignal, keywordLabel, ctaLabel } from "./format";

// THE WINNING-ADS LIBRARY, now reading the REAL store (migration 0088), not the
// curated mock. Every card is a real ad another UK dental advertiser is running on
// Facebook / Instagram right now, pulled from the PUBLIC Meta Ad Library and ranked
// by two honest signals: how long it has run and how many variants are live.
//
// HONESTY, kept visible in two places:
//   * This is competitor REFERENCE data, not the practice's own performance. The
//     practice's spend / leads / cost-per-lead need the client's Meta login and
//     appear elsewhere once connected; the sourcing note says so.
//   * When the store is empty (ingest has not run yet) we say exactly that and show
//     NO ads. We never fall back to fabricated samples in the real library's place.
//
// COMPLIANCE: the copy shown is stored verbatim as public competitor reference.
// It is for pattern-matching only. "Recreate for Vitality" (below) is the separate,
// compliance-gated flow: it produces ORIGINAL copy from the ad's STRUCTURE and can
// never reproduce these advertisers' claims, figures, reviews or images. It lands a
// DRAFT and never publishes anything.

/** The creative outcome the recreate route reports back. Mirrors its CreativeReply. */
interface CreativeReply {
  status: "complete" | "not_configured" | "failed" | "skipped";
  imageUrl?: string;
  message?: string;
  error?: string;
}

interface RecreateResponse {
  ok?: boolean;
  status?: string;
  campaign?: { id?: string; name?: string; treatment?: string };
  copy?: { headline?: string };
  creative?: CreativeReply;
  creativeNote?: string | null;
  failures?: { matched?: string; detail?: string }[];
  message?: string;
  error?: string;
}

/** Per-card recreate state. Every branch is a state the owner can actually reach. */
type RecreateState =
  | { kind: "idle" }
  | { kind: "working" }
  | {
      kind: "done";
      draftName: string;
      headline: string;
      creative: CreativeReply;
      creativeNote: string | null;
    }
  | { kind: "refused"; message: string; reasons: string[] }
  | { kind: "error"; message: string };

/** A fresh draft carries no performance: every figure is a real zero, never invented. */
const ZERO_METRICS: Campaign["metrics"] = {
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
};

/** A placeholder icon for an ad whose creative thumbnail is missing or expired. */
function ThumbFallbackIcon({ displayFormat }: { displayFormat: string | null }) {
  const f = (displayFormat ?? "").toUpperCase();
  if (f.includes("VIDEO")) return <Film size={26} aria-hidden />;
  if (f.includes("CAROUSEL") || f.includes("DCO")) return <GalleryHorizontalEnd size={26} aria-hidden />;
  return <ImageIcon size={26} aria-hidden />;
}

/**
 * The creative thumbnail. Meta CDN URLs are signed and EXPIRE, so a seeded URL can
 * 404; a missing or broken image falls back to a format-icon tile rather than a
 * broken-image glyph. The onError swap is the only reason this is a client leaf.
 */
function AdThumb({ ad }: { ad: StoredWinningAd }) {
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(ad.imageUrl) && !broken;

  return (
    <div className="relative flex h-32 items-center justify-center overflow-hidden bg-card-muted text-muted">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ad.imageUrl ?? ""}
          alt={ad.pageName ? `Ad by ${ad.pageName}` : "Meta ad creative"}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <ThumbFallbackIcon displayFormat={ad.displayFormat} />
      )}
      <StatusPill
        tone={ad.isActive ? "success" : "neutral"}
        className="absolute right-2.5 top-2.5 bg-card/90 backdrop-blur"
      >
        {ad.isActive ? "Live" : "Ended"}
      </StatusPill>
    </div>
  );
}

/**
 * The result panel under the button. Deliberately one component per outcome rather
 * than a generic banner: "we refused this on compliance grounds" and "the image key
 * is not set" are different facts, and an owner should never have to guess which
 * one happened.
 */
function RecreateResult({
  state,
  onOpenDrafts,
}: {
  state: RecreateState;
  onOpenDrafts: () => void;
}) {
  if (state.kind === "refused") {
    return (
      <div className="rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2.5">
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-navy">
          <ShieldAlert size={14} className="shrink-0 text-danger" />
          Blocked by the compliance check
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink">{state.message}</p>
        {state.reasons.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {state.reasons.map((r) => (
              <li key={r} className="text-[11px] leading-relaxed text-muted">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-[#9a6700]">
        {state.message}
      </p>
    );
  }

  if (state.kind !== "done") return null;

  const c = state.creative;
  return (
    <div className="rounded-lg border border-success/25 bg-success/[0.07] px-3 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-navy">
        <CheckCircle2 size={14} className="shrink-0 text-success" />
        Saved as a draft
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink">
        Your own version was written and saved as {state.draftName}. Nothing has been published.
      </p>
      {state.headline ? (
        <p className="mt-1.5 text-xs font-semibold leading-snug text-navy">{state.headline}</p>
      ) : null}

      {c.status === "complete" && c.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.imageUrl}
          alt="The generated creative for this draft"
          className="mt-2 h-28 w-full rounded-md object-cover"
        />
      ) : null}
      {c.status === "not_configured" ? (
        <p className="mt-1.5 inline-flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
          <KeyRound size={12} className="mt-0.5 shrink-0" />
          {c.message}
        </p>
      ) : null}
      {c.status === "failed" ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#9a6700]">{c.error}</p>
      ) : null}
      {state.creativeNote ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{state.creativeNote}</p>
      ) : null}

      <button
        type="button"
        onClick={onOpenDrafts}
        className="mt-2 inline-flex items-center gap-1 rounded text-[11px] font-semibold text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
      >
        Open the draft
        <ArrowRight size={12} />
      </button>
    </div>
  );
}

function AdCard({
  ad,
  clientSlug,
  imageGenConfigured,
  onRecreated,
  onOpenDrafts,
}: {
  ad: StoredWinningAd;
  clientSlug: string;
  imageGenConfigured: boolean;
  onRecreated: (draft: Campaign) => void;
  onOpenDrafts: () => void;
}) {
  const [state, setState] = useState<RecreateState>({ kind: "idle" });
  const cta = ctaLabel(ad.ctaText, ad.ctaType);
  const signal = winningSignal({
    runtimeDays: ad.runtimeDays,
    variantCount: ad.variantCount,
    isActive: ad.isActive,
  });
  const hasLink = Boolean(ad.adLibraryUrl);
  const working = state.kind === "working";

  async function recreate() {
    if (working) return;
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/meta-ads/recreate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, adId: ad.id, withImage: true }),
      });
      const data = (await res.json().catch(() => ({}))) as RecreateResponse;

      if (res.status === 422 || data.status === "compliance_refused") {
        setState({
          kind: "refused",
          message:
            data.message ??
            "This ad could not be recreated compliantly, so nothing was saved.",
          reasons: (data.failures ?? [])
            .slice(0, 3)
            .map((f) => f.detail ?? f.matched ?? "")
            .filter(Boolean),
        });
        return;
      }
      if (!res.ok || !data.ok || !data.campaign?.id) {
        throw new Error(
          data.error ?? data.message ?? "This ad could not be recreated just now.",
        );
      }

      const creative: CreativeReply = data.creative ?? { status: "skipped" };
      const draftName = data.campaign.name ?? "a new draft";
      setState({
        kind: "done",
        draftName,
        headline: data.copy?.headline ?? "",
        creative,
        creativeNote: data.creativeNote ?? null,
      });
      onRecreated({
        id: data.campaign.id,
        name: draftName,
        treatment: data.campaign.treatment ?? keywordLabel(ad.keyword),
        objective: "leads",
        status: "draft",
        dailyBudgetGbp: 0,
        startedAt: null,
        metrics: ZERO_METRICS,
      });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "This ad could not be recreated just now.",
      });
    }
  }

  return (
    <li className="flex">
      <div className="group flex flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-card text-left">
        <AdThumb ad={ad} />

        <div className="flex flex-1 flex-col gap-2.5 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-navy">
                {ad.pageName ?? "Unknown advertiser"}
              </p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-xs tabular-nums text-ink">
                <Clock size={12} className="shrink-0 text-muted" /> {signal}
              </p>
            </div>
            <span
              className="inline-flex shrink-0 items-center rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-[11px] font-medium text-ink"
              title="Derived treatment tag"
            >
              {keywordLabel(ad.keyword)}
            </span>
          </div>

          {ad.title ? (
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-navy">{ad.title}</p>
          ) : null}
          {ad.bodyText ? (
            <p className="line-clamp-4 text-xs leading-relaxed text-muted">{ad.bodyText}</p>
          ) : null}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
            {cta ? (
              <StatusPill tone="info">{cta}</StatusPill>
            ) : (
              <span className="text-[11px] text-muted">No button</span>
            )}
            {hasLink ? (
              <a
                href={ad.adLibraryUrl ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${ad.pageName ?? "this ad"} on the Meta Ad Library`}
                className="inline-flex items-center gap-1 rounded text-[11px] font-semibold text-blue-deep transition-colors hover:text-blue-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
              >
                View on Meta Ad Library
                <ExternalLink size={12} />
              </a>
            ) : null}
          </div>

          {/* THE RECREATE TRIGGER. Always present and always clickable: the copy is
              written whether or not an image key exists, so a missing key narrows
              what you get, it never removes the button. */}
          <div className="space-y-2 border-t border-line pt-2.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full justify-center"
              onClick={recreate}
              disabled={working}
              aria-label={`Recreate this ad for Vitality, inspired by ${ad.pageName ?? "this advertiser"}`}
            >
              {working ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
              {working ? "Writing your version..." : "Recreate for Vitality"}
            </Button>

            {!imageGenConfigured && state.kind === "idle" ? (
              <p className="inline-flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
                <KeyRound size={12} className="mt-0.5 shrink-0" />
                No image key is connected, so this writes your own compliant ad copy only. Set
                OPENAI_API_KEY on the server to generate the creative as well.
              </p>
            ) : null}

            {working ? (
              <p className="text-[11px] leading-relaxed text-muted">
                Writing an original version from this ad&apos;s structure, then checking it against
                the UK advertising rules. Nothing is published.
              </p>
            ) : null}

            <RecreateResult state={state} onOpenDrafts={onOpenDrafts} />
          </div>
        </div>
      </div>
    </li>
  );
}

export function AdLibrary({
  winningAds,
  clientSlug,
  imageGenConfigured = false,
  onRecreated,
  onOpenDrafts,
}: {
  winningAds: StoredWinningAd[];
  /** The practice whose draft a recreate lands in. */
  clientSlug: string;
  /** True only when the SERVER holds an image key. Drives the honest pre-click note. */
  imageGenConfigured?: boolean;
  /** A saved recreate draft, handed back so the Campaigns tab shows it. */
  onRecreated?: (draft: Campaign) => void;
  /** Jump to the Campaigns tab, where the saved draft is listed. */
  onOpenDrafts?: () => void;
}) {
  return (
    <SectionCard
      title="Winning ads library"
      description="Real dental ads from the public Meta Ad Library, ranked by how long each has been running and how many variants are live. Pattern-match, do not copy: take the structure and the angle, then write your own compliant version."
    >
      <div className="space-y-4">
        {/* The honesty seam: reference data, not the practice's own performance. */}
        <div className="flex items-start gap-2.5 rounded-[10px] border border-tint-blue-line bg-tint-blue px-3.5 py-2.5">
          <Info size={15} className="mt-0.5 shrink-0 text-blue-deep" />
          <p className="text-xs leading-relaxed text-ink">
            These are public Meta Ad Library results from other advertisers, ranked by how long each
            ad has been running and how many variants are live. This is competitor reference, not your
            own account performance: your campaign spend, leads and cost per lead appear once your Meta
            account is connected.
          </p>
        </div>

        {/* What "Recreate for Vitality" actually does, stated before it is pressed. */}
        {winningAds.length > 0 ? (
          <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-3.5 py-2.5">
            <Wand2 size={15} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-xs leading-relaxed text-ink">
              Recreate for Vitality writes a completely original ad for one of your own services,
              inspired by an ad&apos;s structure only. It never reuses an advertiser&apos;s wording,
              figures, offers, reviews or images, it is checked against the UK advertising rules for
              dentists before it is saved, and it lands as a draft. Nothing is ever published.
            </p>
          </div>
        ) : null}

        {winningAds.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-line-strong px-6 py-12 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-[10px] bg-tile text-side-ink">
              <Images size={20} />
            </span>
            <h3 className="text-sm font-semibold text-navy">The winning-ads library is empty</h3>
            <p className="mt-1 max-w-md text-[13px] font-normal text-muted">
              This library fills from the public Meta Ad Library and has not been ingested yet. Once
              the weekly refresh runs, the best-performing dental ads appear here, ranked by runtime
              and variants. No sample ads are shown in their place.
            </p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {winningAds.map((ad) => (
              <AdCard
                key={ad.id}
                ad={ad}
                clientSlug={clientSlug}
                imageGenConfigured={imageGenConfigured}
                onRecreated={onRecreated ?? (() => {})}
                onOpenDrafts={onOpenDrafts ?? (() => {})}
              />
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
