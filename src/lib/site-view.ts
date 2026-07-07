import "server-only";
import { cookies } from "next/headers";
import { getSites } from "@/lib/mock/clients";
import { ALL_SITES, DEFAULT_VIEW_SITE, SITE_VIEW_COOKIE } from "@/lib/site-view-shared";

// Which site(s) a logged-in user's DASHBOARD should show. The practice runs three
// sites, but the default view is the flagship, N15 Vitality Dental (`site-cc`);
// the top-bar switcher lets a user pick another single site or "All sites", and
// that choice persists in a cookie.
//
// IMPORTANT: this is for DISPLAY code only (server components rendered for a page
// view, and route handlers called from the browser with the user's cookie).
// Background jobs (cron sync / sweeps / drain / webhooks) run headless with NO
// cookie and MUST keep covering every site, so they must NOT call this — they
// continue to use `getSites(clientId)` directly.

export { ALL_SITES, DEFAULT_VIEW_SITE, SITE_VIEW_COOKIE };

/**
 * The raw current selection for a client (a site id, or ALL_SITES). Unset or a
 * stale/foreign value resolves to the default site when the client has it, else
 * ALL_SITES. Used by the top-bar switcher to show the active option.
 */
export async function getViewSiteSelection(clientId: string): Promise<string> {
  const all = getSites(clientId).map((s) => s.id);
  const sel = (await cookies()).get(SITE_VIEW_COOKIE)?.value;
  if (sel === ALL_SITES) return ALL_SITES;
  if (sel && all.includes(sel)) return sel;
  return all.includes(DEFAULT_VIEW_SITE) ? DEFAULT_VIEW_SITE : ALL_SITES;
}

/**
 * The site ids a dashboard view should scope to for this client, honouring the
 * cookie and defaulting to the flagship (N15) when nothing is chosen. Returns a
 * single-element array for a specific site, or every site for "All sites".
 */
export async function getViewSiteIds(clientId: string): Promise<string[]> {
  const all = getSites(clientId).map((s) => s.id);
  const sel = await getViewSiteSelection(clientId);
  if (sel === ALL_SITES) return all;
  return [sel];
}

export interface ViewScope {
  /** Site ids to query for this view. */
  siteIds: string[];
  /** Raw selection: a site id or ALL_SITES. */
  selection: string;
  /** True when the whole group is selected. */
  isAllSites: boolean;
  /** The single selected site's name, or null when All sites. */
  siteName: string | null;
  /** Copy-ready label: the site name (e.g. "N15 Vitality Dental") or "all sites". */
  label: string;
}

/**
 * One resolved scope for a dashboard view: the site ids to query AND a copy-ready
 * label, so a view can both fetch scoped data and phrase its subtitles/hints for
 * the selected site instead of hardcoding "across all sites".
 */
export async function getViewScope(clientId: string): Promise<ViewScope> {
  const sites = getSites(clientId);
  const selection = await getViewSiteSelection(clientId);
  const isAllSites = selection === ALL_SITES;
  const site = isAllSites ? null : sites.find((s) => s.id === selection) ?? null;
  return {
    siteIds: isAllSites ? sites.map((s) => s.id) : [selection],
    selection,
    isAllSites,
    siteName: site?.name ?? null,
    label: isAllSites ? "all sites" : site?.name ?? "the selected site",
  };
}
