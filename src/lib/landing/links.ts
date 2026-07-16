// Pure CTA link builder for a landing page. Keeps the routing convention (and the
// attribution params) in one testable place. The CTA always carries lpv (the
// variant) and lp (the landing slug) so downstream lead attribution can pick up
// which page and variant sent the visitor.

import type { Cta } from "./content";
import type { VariantKey } from "./winner";

export interface CtaHrefInput {
  clientSlug: string;
  cta: Cta;
  variant: VariantKey;
  landingSlug: string;
  /** Practice site to pre-select on the booking page, when known. */
  siteId?: string | null;
}

/**
 * Build the CTA destination:
 * - assessment + targetSlug -> the specific Smile Assessment campaign
 * - assessment              -> the generic assessment funnel
 * - booking                 -> the client booking page (site pre-selected if known)
 * All carry ?lpv=<variant>&lp=<landingSlug> for attribution.
 */
export function buildCtaHref({ clientSlug, cta, variant, landingSlug, siteId }: CtaHrefInput): string {
  const params = new URLSearchParams();
  if (cta.target === "booking" && siteId) params.set("site", siteId);
  params.set("lpv", variant);
  params.set("lp", landingSlug);
  const qs = `?${params.toString()}`;

  if (cta.target === "booking") {
    return `/book/${clientSlug}${qs}`;
  }
  // assessment
  if (cta.targetSlug) {
    return `/assess/${clientSlug}/${cta.targetSlug}${qs}`;
  }
  return `/assess/${clientSlug}${qs}`;
}
