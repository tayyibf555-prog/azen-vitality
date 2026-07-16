// URL slug helpers for landing pages (the bit after /go/<client>/). Pure, no I/O.
//
// Mirrors the Smile Assessment slug convention (campaign.ts) but is kept local so
// the landing module does not couple to the quiz. A landing slug is derived from
// the treatment plus a short random suffix, so two pages for the same treatment
// get distinct, non-guessable URLs and the owner never has to invent one.

import { randomBytes } from "crypto";

const SLUG_MAX = 60;
// Slugs we never allow, because they would shadow a sibling route or read oddly.
const RESERVED_SLUGS = new Set(["", "api", "go", "new", "edit", "admin", "preview"]);

/** Lowercase, dashes for gaps, strip to [a-z0-9-], collapse and trim dashes, cap. */
export function slugify(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && !RESERVED_SLUGS.has(slug) && slugify(slug) === slug;
}

/** A short, url-safe, non-guessable suffix (4 chars of [a-z0-9]). */
export function shortSuffix(): string {
  // 3 bytes -> 6 base-ish chars; hex is safe for slugs. Take 4.
  return randomBytes(3).toString("hex").slice(0, 4);
}

/**
 * Derive a landing-page slug from a treatment label plus a short random suffix,
 * e.g. "invisalign-9f2a". The base is capped so the suffix always survives the
 * length limit. Falls back to "offer" when the treatment slugifies to nothing.
 */
export function deriveSlug(treatment: string, suffix: string = shortSuffix()): string {
  const base = slugify(treatment).slice(0, SLUG_MAX - 5) || "offer";
  return `${base}-${suffix}`;
}
