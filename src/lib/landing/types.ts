// Landing-page domain types (the app-side shapes for the 0044 tables). Pure types,
// no I/O, safe to import anywhere.

import type { LandingPageContent } from "./content";
import type { VariantKey } from "./winner";

export type LandingPageStatus = "draft" | "live" | "archived";
export type VariantStatus = "active" | "retired";

export interface LandingPage {
  id: string;
  clientId: string;
  /** Practice site the page's leads belong to; null when not site-scoped. */
  siteId: string | null;
  slug: string;
  /** Catalogue treatment key the page is for (drives pricing + defaults). */
  treatment: string;
  /** Loose reference to a Meta Ads campaign, or null. Not a foreign key. */
  campaignRef: string | null;
  status: LandingPageStatus;
  /** The promoted winner, or null while both variants run. */
  winnerVariant: VariantKey | null;
  autoPromote: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LandingPageVariant {
  id: string;
  pageId: string;
  variantKey: VariantKey;
  content: LandingPageContent;
  status: VariantStatus;
  createdAt: string;
}

/** A page together with its variants (detail / serving shape). */
export interface LandingPageWithVariants {
  page: LandingPage;
  variants: LandingPageVariant[];
}
