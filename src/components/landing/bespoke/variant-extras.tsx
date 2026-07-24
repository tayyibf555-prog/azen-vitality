import type { BespokeVariantCopy } from "@/lib/landing/bespoke/registry";

// Shared, presentational-only extras for the bespoke .vd-landing pages that are
// driven by a variant's optional DESIGN flags (BespokeVariantCopy.layout). These are
// pure SERVER components: no hooks, no client JS, no function props. Each returns null
// unless the corresponding flag is present, so variant a (which carries no `layout`
// object) renders exactly as it did before these existed, byte for byte.
//
// All styling lives in the shared scoped stylesheet (vitality-invisalign-landing.styles),
// under `.vd-landing .vd-hero-chip` and `.vd-landing .vd-sticky-cta`, so nothing here
// forks the design system. The sticky bar is a plain fixed element shown only under
// 820px via a CSS media query, so it appears without any JavaScript.

type LayoutFlags = NonNullable<BespokeVariantCopy["layout"]>;

/**
 * A premium price chip rendered directly under the hero subhead (variant b only).
 * The value is bold, the note muted. Renders nothing when no chip is configured.
 */
export function HeroPriceChip({ chip }: { chip?: LayoutFlags["heroPriceChip"] }) {
  if (!chip) return null;
  return (
    <div className="vd-hero-chip">
      <span className="vd-hero-chip-value">{chip.value}</span>
      <span className="vd-hero-chip-note">{chip.note}</span>
    </div>
  );
}

/**
 * A fixed, full-width mobile CTA bar pinned to the bottom of the viewport (variant b
 * only). It duplicates the primary CTA so the booking action stays one tap away as the
 * visitor scrolls. Shown only under 820px (via the stylesheet); renders nothing unless
 * enabled. It carries `data-lp-cta` so the LandingTracker counts its clicks like every
 * other CTA, and scrolls to the embedded #consultation form.
 */
export function StickyCtaBar({
  enabled,
  ctaLabel,
}: {
  enabled?: boolean;
  ctaLabel: string;
}) {
  if (!enabled) return null;
  return (
    <div className="vd-sticky-cta">
      <a className="btn-blue" href="#consultation" data-lp-cta>
        {ctaLabel}
      </a>
    </div>
  );
}
