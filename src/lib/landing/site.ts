import { getSites } from "@/lib/mock/clients";

// Pure site-resolution policy shared by the public /go landing route and the
// /api/landing-lead endpoint. Lets ONE published landing page be linked from
// several practice sites' campaigns (?site=<internalSiteId> on the URL, or
// siteId in the lead POST body) and route accordingly, WITHOUT duplicating the
// page. An explicit request is honoured ONLY when it names a real site that
// belongs to THIS client; a foreign (another client's real site id) or unknown
// value is rejected silently and the page's own configured site stands. Never
// trust a caller-supplied site id blindly, since it can be forged.

/**
 * Resolve the effective site for a public landing/lead flow.
 *
 * Generic over `pageSite`'s nullability so a caller whose fallback is always a
 * defined string (e.g. `found.page.siteId ?? "site-cc"`) gets back a plain
 * `string`, with no cast needed, while a caller whose fallback may genuinely be
 * null (a page that is not site-scoped) keeps that in the return type.
 *
 * @param clientId  The resolved client's internal id (e.g. "vitality").
 * @param requested The caller-requested site id, if any (a `?site=` query param
 *                  value, or a lead POST's `siteId` field). May be absent.
 * @param pageSite  The page's own configured site (the fallback).
 * @returns `requested` when it names one of `clientId`'s real sites, else `pageSite`.
 */
export function resolveEffectiveSite<T extends string | null>(
  clientId: string,
  requested: string | null | undefined,
  pageSite: T,
): string | T {
  if (requested && getSites(clientId).some((s) => s.id === requested)) {
    return requested;
  }
  return pageSite;
}
