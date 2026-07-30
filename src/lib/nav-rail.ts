// ---------------------------------------------------------------------------
// Which pages ask the client shell for the COMPACT icon rail.
//
// The full sidebar (category rail + module panel + search + shortcuts) costs
// roughly 300px of width. That is the right trade on a page you arrive at to
// choose something, and the wrong one on a page that is itself the work: the
// practice dashboard is a dense band of figures read between phone calls, and
// every pixel of it is content.
//
// So a page opts in here, by segment, rather than the shell guessing. Everything
// not listed keeps the full sidebar untouched. The rail is only ever compact on
// a wide screen; below lg the sidebar is an off-canvas drawer where width costs
// nothing, so it stays whole.
// ---------------------------------------------------------------------------

/** Segments under /c/[client] that render better against a thin icon rail. */
export const COMPACT_RAIL_SEGMENTS: readonly string[] = ["dashboard"];

/**
 * True when `pathname` is one of the opted-in pages under `base`.
 *
 * `base` is the client root, "/c/vitality". A nested route under an opted-in
 * segment counts, a segment that merely starts with the same letters does not.
 */
export function wantsCompactRail(pathname: string | null | undefined, base: string): boolean {
  if (!pathname) return false;
  if (!pathname.startsWith(base)) return false;
  const rest = pathname.slice(base.length).replace(/^\/+/, "");
  const segment = rest.split("/")[0] ?? "";
  return COMPACT_RAIL_SEGMENTS.includes(segment);
}
