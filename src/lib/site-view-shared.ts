// Client-safe constants for the dashboard site selection. Kept separate from
// `site-view.ts` (which is `server-only` because it reads cookies) so the top-bar
// switcher — a client component — can import the cookie name and sentinels too.

/** Internal id of the default displayed site: N15 Vitality Dental. */
export const DEFAULT_VIEW_SITE = "site-cc";

/** Cookie holding the current selection: a site id, or ALL_SITES, or unset. */
export const SITE_VIEW_COOKIE = "az_view_site";

/** Sentinel selection meaning "show every site combined". */
export const ALL_SITES = "__all__";
