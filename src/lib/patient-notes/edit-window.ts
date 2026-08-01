/**
 * Who may edit a practice note.
 *
 * PURE. No I/O, no Date.now(): the caller passes `now`, so the rule is testable and
 * the server and the UI cannot disagree about it.
 *
 * NO TIME LIMIT. The author may correct their own note whenever they notice.
 *
 * This build originally imposed a fifteen minute author-only window, on the reasoning
 * that an `updated_at` column alone lets a clinical note be silently rewritten years
 * later. The owner reviewed that and chose to MATCH DENTALLY, whose pencil has no
 * window, because the platform's whole purpose here is that a Dentally user finds what
 * they expect: a control that works in Dentally and refuses here, for reasons invisible
 * to the person holding the mouse, is exactly the friction this project exists to avoid.
 *
 * What carries the safety instead is attribution, which is stronger than the window was.
 * Every edit stamps `updated_at` and `updated_by` (migration 0064), so a rewritten note
 * says that it was rewritten, when, and by whom. An auditor can see an edit happened;
 * they simply cannot see the previous text. If the practice ever needs the previous text
 * as well, that is a revision table, and a revision table is the honest way to get it,
 * not a countdown that makes corrections impossible after a quarter of an hour.
 *
 * The file keeps its name so every import site stays put.
 */

/**
 * May this viewer edit this note?
 *
 * The both-null case is the unenforced pilot, where there is no session to stamp an
 * author with and therefore nobody the viewer could be mistaken for. Once auth is
 * enforced (it is, in production) a note carries an author id and a viewer must match
 * it. A note written under enforcement can never be edited by an unauthenticated
 * caller, and a note written before enforcement can never be edited by a signed-in
 * one, because in neither case can we show that the same person wrote it.
 *
 * `now` and `createdAt` are still accepted so that every call site, its tests and the
 * server route keep their shape, and so that reinstating a window later is a change to
 * this one function rather than to a dozen callers.
 */
export function canEditNote(
  note: { authorId: string | null; createdAt: string },
  _now: Date,
  viewerId: string | null,
): boolean {
  if (viewerId === null && note.authorId === null) return true;
  return viewerId !== null && note.authorId === viewerId;
}
