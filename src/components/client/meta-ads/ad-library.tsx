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
} from "lucide-react";
import { SectionCard, StatusPill } from "@/components/primitives";
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
// It is for pattern-matching only; recreating an ad for Vitality is a separate,
// compliance-gated flow that produces ORIGINAL copy and never reproduces any of
// these advertisers' claims, figures, reviews or images.

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

function AdCard({ ad }: { ad: StoredWinningAd }) {
  const cta = ctaLabel(ad.ctaText, ad.ctaType);
  const signal = winningSignal({
    runtimeDays: ad.runtimeDays,
    variantCount: ad.variantCount,
    isActive: ad.isActive,
  });
  const hasLink = Boolean(ad.adLibraryUrl);

  // The whole card links out to the real Ad Library entry when we have its URL;
  // otherwise it is a plain, non-interactive card (still fully readable).
  const inner = (
    <>
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
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-deep transition-colors group-hover:text-blue-dark">
              View on Meta Ad Library
              <ExternalLink size={12} className="transition-transform group-hover:translate-x-0.5" />
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  const shell =
    "group flex flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-card text-left transition-colors";

  return (
    <li className="flex">
      {hasLink ? (
        <a
          href={ad.adLibraryUrl ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${ad.pageName ?? "this ad"} on the Meta Ad Library`}
          className={`${shell} hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40`}
        >
          {inner}
        </a>
      ) : (
        <div className={shell}>{inner}</div>
      )}
    </li>
  );
}

export function AdLibrary({ winningAds }: { winningAds: StoredWinningAd[] }) {
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
              <AdCard key={ad.id} ad={ad} />
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
