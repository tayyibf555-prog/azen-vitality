// Sticky 50/50 variant assignment for a landing page. Pure logic, no I/O, so the
// cookie decision is fully unit-testable; the public page performs the actual
// cookie read (server) and the client tracker performs the write.
//
// A returning visitor must see the SAME variant, so assignment is persisted in a
// per-page cookie scoped to that page's path (/go/<client>/<slug>). The cookie is
// intentionally NOT httpOnly: it is a harmless bucket label the client tracker can
// also read/write, never a secret.

import type { VariantKey } from "./winner";

/** Cookie name for a page's sticky variant. Namespaced + page-id scoped. */
export function variantCookieName(pageId: string): string {
  // Cookie names must avoid separators; pageId is a uuid (safe chars only).
  return `lpv_${pageId}`;
}

/** The path a page's variant cookie is scoped to, so buckets never leak across pages. */
export function variantCookiePath(clientSlug: string, slug: string): string {
  return `/go/${clientSlug}/${slug}`;
}

export interface AssignmentResult {
  variant: VariantKey;
  /** True when the caller should persist the cookie (i.e. this was a fresh assignment). */
  setCookie: boolean;
}

function isVariant(v: unknown): v is VariantKey {
  return v === "a" || v === "b";
}

/**
 * A fresh 0..1 coin toss for a NEW variant assignment. The randomness lives here,
 * in the assignment module, rather than at the render site: the server page runs
 * once per request, so a per-request toss is correct, and keeping it out of the
 * component body keeps that render pure. `assignVariant` itself stays deterministic
 * (roll injected) so the 50/50 split is unit-testable.
 */
export function coinToss(): number {
  return Math.random();
}

/**
 * Resolve the variant for a request.
 * - `forced` (a promoted winner) always wins and is never re-bucketed.
 * - an existing, valid cookie is honoured (sticky) and not re-set.
 * - otherwise a fresh 50/50 bucket is chosen from `roll` (0..1) and flagged to set.
 *
 * `roll` is injected (Math.random() at the call site) so the split is testable.
 */
export function assignVariant(
  existingCookie: string | null | undefined,
  roll: number,
  forced?: VariantKey | null,
): AssignmentResult {
  if (isVariant(forced)) {
    return { variant: forced, setCookie: false };
  }
  if (isVariant(existingCookie)) {
    return { variant: existingCookie, setCookie: false };
  }
  const variant: VariantKey = roll < 0.5 ? "a" : "b";
  return { variant, setCookie: true };
}
