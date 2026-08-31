/**
 * How the Correspondence tab is laid out, and how that choice is remembered.
 *
 * THE ASK, in the practice owner's own words on the 27 August call: "I'll put a tab
 * that they can switch between list and pages". He had just compared this tab with
 * Dentally's side by side and leaned toward Dentally's shape — "maybe do it the way
 * dentally has it" — so PAGES is the default and List is the alternative, not the other
 * way round.
 *
 * WHAT THE TWO ACTUALLY ARE:
 *   pages  Dentally's own shape. A fixed number of entries at a time with a pager,
 *          NEWEST PAGE FIRST, so opening the tab lands on what happened most recently.
 *   list   One continuous chronological run, oldest first — the chat order this tab
 *          has always rendered in, and the right shape for reading a whole history
 *          through or searching it with the browser's own find.
 *
 * NEITHER FETCHES DIFFERENTLY. Both render the SAME timeline, already read in full.
 * Paging is a presentation choice over data that is entirely in hand, so switching view
 * costs no Dentally read and can never show a different set of facts from the other
 * view — which it would if the pager fetched per page and the underlying history moved
 * underneath it.
 *
 * PURE. No I/O. Tested. Lives here rather than inside the component for the same reason
 * ./tabs.ts holds the copy: a page size and a default are exactly the kind of value
 * that drifts silently when it is inlined in JSX.
 */

export type CorrespondenceView = "pages" | "list";

/**
 * Cookie holding the remembered layout, read SERVER side.
 *
 * THE SAME MECHANISM AS THE DIARY'S density and column-scope toggles, deliberately and
 * line for line (see DIARY_ZOOM_COOKIE / DIARY_COLUMNS_COOKIE in
 * @/components/client/calendar/diary-view): a cookie, written by the client on change,
 * read by the server component before the first paint. Reading it from localStorage
 * after hydration would render the wrong layout and then correct itself under the
 * reader, which on a clinical record is worse than on a diary — a list that reshuffles
 * as you start reading it makes you doubt you read it.
 *
 * It persists for the same reason zoom does and for no other: it is a reading
 * preference about layout, not a claim about the patient. Nothing about WHICH patient
 * or WHICH tab is remembered here; those stay in the URL.
 */
export const CORRESPONDENCE_VIEW_COOKIE = "az_corr_view";

/**
 * The stored view, defaulting to PAGES for anything unrecognised or unset.
 *
 * Defaulting to the owner's stated preference rather than to the layout that happened
 * to exist first. A practice that has never touched the toggle gets the shape they
 * asked for.
 */
export function parseCorrespondenceView(raw: string | null | undefined): CorrespondenceView {
  return raw === "list" ? "list" : "pages";
}

/**
 * How many entries a page holds.
 *
 * Twenty-five, matching the page size Dentally's own correspondence screen works in
 * and the per_page its API defaults to when you ask for more than it will give (see
 * client.ts's measured caps). Copying the number the practice is already trained on
 * costs nothing and means a coordinator counting down a page here and a page there
 * lands in the same place.
 */
export const CORRESPONDENCE_PAGE_SIZE = 25;

/** How many pages this many entries makes. At least one, so an empty history still has a page to draw. */
export function pageCount(total: number, size: number = CORRESPONDENCE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, size)));
}

/**
 * One page of the timeline, indexed from 1, NEWEST PAGE FIRST.
 *
 * THE INVERSION IS THE WHOLE SUBTLETY HERE, so it is done in one tested place rather
 * than in a component. The timeline is built OLDEST FIRST, because that is chat order
 * and it is what the list view wants. A pager over it that simply sliced from the front
 * would open the tab on the patient's oldest twenty-five messages — a record from 2019
 * as the first thing a clinician sees. Dentally opens on the most recent.
 *
 * So page 1 is the LAST slice of the array, page 2 the one before it, and within every
 * page the entries stay in oldest-first order so a page reads top to bottom the way the
 * list does. Reversing within the page as well would give a screen that reads backwards
 * inside a page and forwards between them.
 *
 * An out-of-range page is CLAMPED rather than returning nothing. A pasted or stale page
 * number must not render an empty panel on a patient with a full history, because an
 * empty panel on this tab is the state that says "nobody contacted her".
 */
export function pageOf<T>(
  entries: readonly T[],
  page: number,
  size: number = CORRESPONDENCE_PAGE_SIZE,
): T[] {
  const perPage = Math.max(1, size);
  const pages = pageCount(entries.length, perPage);
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  // Page 1 is the newest slice, which is the END of an oldest-first array.
  const end = entries.length - (clamped - 1) * perPage;
  const start = Math.max(0, end - perPage);
  return entries.slice(start, Math.max(start, end));
}

/**
 * "Showing 26 to 50 of 118" — the sentence under a pager.
 *
 * A pager with no counts makes a reader page to the end to find out whether they have
 * seen everything, which on a correspondence history is the exact question they came
 * to answer. The numbers are stated in READING order (the low number first) even though
 * page 1 holds the newest entries, because "showing 94 to 118" on the first page reads
 * as though something has been skipped.
 */
export function pageRangeLabel(
  total: number,
  page: number,
  size: number = CORRESPONDENCE_PAGE_SIZE,
): string {
  if (total <= 0) return "";
  const perPage = Math.max(1, size);
  const pages = pageCount(total, perPage);
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const end = total - (clamped - 1) * perPage;
  const start = Math.max(1, end - perPage + 1);
  return `Showing ${start} to ${end} of ${total}`;
}
