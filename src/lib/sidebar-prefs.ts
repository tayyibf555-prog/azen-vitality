// ---------------------------------------------------------------------------
// Remembered layout for the client sidebar.
//
// The sidebar is a SINGLE column of collapsible areas. Two things persist:
//
//   1. whether the whole column is collapsed to its icon rail, and
//   2. which areas the user has opened.
//
// Both live in cookies rather than localStorage so the SERVER can read them and
// render the correct sidebar on the first paint. localStorage is only readable
// after hydration, which would flash the wrong width on every page load.
//
// Everything here is pure and client-safe: the layout imports it to parse the
// incoming cookies, and the sidebar imports it to serialise them back out.
// ---------------------------------------------------------------------------

/** Cookie holding "1" when the sidebar is collapsed to its icon rail. */
export const SIDEBAR_COLLAPSED_COOKIE = "az_nav_collapsed";

/** Cookie holding the comma-separated keys of the areas the user has opened. */
export const SIDEBAR_GROUPS_COOKIE = "az_nav_groups";

/** One year, matching the site-switcher cookie. */
export const SIDEBAR_COOKIE_MAX_AGE = 31536000;

/** Whether the stored value means "collapsed". Anything but "1" means expanded. */
export function parseCollapsed(raw: string | null | undefined): boolean {
  return raw === "1";
}

/** The cookie value for a collapse state. */
export function serialiseCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

/**
 * The remembered open areas, or `null` when the user has never expressed a
 * preference (no cookie at all). An EMPTY cookie is a real preference meaning
 * "nothing pinned open", which is why it resolves to `[]` and not `null`.
 */
export function parseOpenGroups(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

/** The cookie value for a set of open areas. */
export function serialiseOpenGroups(keys: readonly string[]): string {
  return [...new Set(keys)].join(",");
}

/**
 * The areas that should start open: everything the user pinned open, PLUS the
 * area holding the current page, so landing anywhere always shows you where you
 * are. Unknown keys (an area the role cannot see, or a renamed one) are dropped,
 * and the result is ordered by `allKeys` so it is stable to compare and store.
 *
 * A user who has never chosen (`remembered` null) and is on a page that belongs
 * to no area (the dashboard) gets the FIRST area open, so a first visit is never
 * five shut headers and nothing else.
 */
export function resolveOpenGroups(
  remembered: readonly string[] | null,
  routeKey: string | null,
  allKeys: readonly string[],
): string[] {
  const want = new Set(remembered ?? []);
  if (routeKey) want.add(routeKey);
  if (remembered === null && !routeKey && allKeys.length > 0) want.add(allKeys[0]);
  return allKeys.filter((k) => want.has(k));
}

/** Open a closed area / close an open one. */
export function toggleGroup(open: readonly string[], key: string): string[] {
  return open.includes(key) ? open.filter((k) => k !== key) : [...open, key];
}

/**
 * `open` with `key` added. Returns the SAME array when nothing changes, so a
 * caller can use it as a render-phase state guard without looping.
 */
export function withGroupOpened(open: readonly string[], key: string | null): readonly string[] {
  if (!key || open.includes(key)) return open;
  return [...open, key];
}

/** The href of a module under a client base path. The empty slug is the index. */
export function moduleHref(base: string, slug: string): string {
  return slug === "" ? base : `${base}/${slug}`;
}

/** Whether `pathname` is a module's page or a page nested under it. */
export function isModuleActive(
  pathname: string | null | undefined,
  base: string,
  slug: string,
): boolean {
  if (!pathname) return false;
  if (slug === "") return pathname === base || pathname === `${base}/`;
  const href = moduleHref(base, slug);
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The key of the first area containing an active module, else `null`. */
export function groupKeyForActive<T extends { key: string; items: readonly { slug: string }[] }>(
  groups: readonly T[],
  isActive: (slug: string) => boolean,
): string | null {
  return groups.find((g) => g.items.some((i) => isActive(i.slug)))?.key ?? null;
}
