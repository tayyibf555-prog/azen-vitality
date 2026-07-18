// Pure path -> surface reduction, shared by the client beacon (which computes the
// surface from the current pathname) and covered by unit tests. Deliberately
// client-safe: NO `server-only`, NO nav import, no I/O, so importing it into the
// beacon adds nothing to the client bundle beyond a few lines of string work.
//
// A "surface" is the MODULE FAMILY a page belongs to: the first path segment under
// /c/<client>. Reducing to that family is the privacy guarantee on the client side
// — a record page like /c/vitality/patients/12345 collapses to "patients", so the
// patient id never leaves the browser. The server independently sanitises the
// value against the nav-slug allowlist (sanitiseSurface), so an unknown or spoofed
// family is dropped there too.

/** The name used for the dashboard index (the empty module slug). */
export const OVERVIEW_SURFACE = "overview";

/**
 * Reduce a pathname to its module-family surface, or null when it is not a client
 * dashboard path. `/c/<client>` -> "overview"; `/c/<client>/<family>/...` ->
 * "<family>" (deeper segments, e.g. record ids, are dropped by construction).
 */
export function surfaceFromPath(pathname: string | null | undefined): string | null {
  if (!pathname || typeof pathname !== "string") return null;
  const segments = pathname.split("/").filter(Boolean);
  // Only the client dashboard shell is instrumented: paths start with /c/<client>.
  if (segments[0] !== "c" || segments.length < 2) return null;
  const family = segments[2];
  if (!family) return OVERVIEW_SURFACE; // the /c/<client> overview index
  return family.trim().toLowerCase();
}
