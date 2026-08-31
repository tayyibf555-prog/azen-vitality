import type { DentallyDocumentRecord } from "@/lib/dentally/documents-shape";
import type { DentallyEmailRecord } from "@/lib/dentally/emails-shape";
import type { InboxMessage } from "./types";

/**
 * ONE patient's correspondence as a single ordered timeline, whatever kind each entry
 * is: a message this platform sent, an SMS Dentally sent, a document Dentally filed,
 * an email Dentally holds.
 *
 * WHY THIS IS A UNION AND NOT AN InboxMessage WITH EXTRA FIELDS. The tempting shortcut
 * is to squeeze a document into the message shape — body = the description, direction =
 * "outbound", channel = "email" — and render one list with no new code. It is the wrong
 * shape and it produces a false record: a document is not a thing that was SAID to
 * anybody, it has no direction, no delivery status and no approver, and rendering one
 * under "To patient" with a green Sent pill states that the practice sent the patient
 * their own signed consent form. Every field the message row carries would have to be
 * invented, and each invention is a claim on a clinical record.
 *
 * So the kinds stay distinct all the way to the JSX, and the ONLY thing they share is
 * the one property a timeline actually needs: when it happened.
 *
 * THE OWNER ASKED FOR THE LABELS. On the 27 August call, comparing this tab with
 * Dentally's side by side, he asked that uploads be labelled "Upload". That word is
 * used verbatim (see documentLabel in @/lib/dentally/documents-shape) rather than being
 * improved into "Attachment" or "File": renaming the thing the reader already has a
 * name for makes them translate.
 */

export type CorrespondenceKind = "message" | "document" | "email";

/**
 * One row on the timeline.
 *
 * `at` and `id` are HOISTED onto every variant rather than reached through the payload.
 * Sorting and keying are then one property access with no discrimination, so the sort
 * cannot be written differently for one kind than another — which is exactly how a
 * timeline ends up ordering documents by a different field from messages and
 * interleaving them wrongly.
 */
export type CorrespondenceEntry =
  | { kind: "message"; id: string; at: string; message: InboxMessage }
  | { kind: "document"; id: string; at: string; document: DentallyDocumentRecord }
  | { kind: "email"; id: string; at: string; email: DentallyEmailRecord };

/** True when this entry carries a timestamp we can actually place on a timeline. */
export function isDated(entry: CorrespondenceEntry): boolean {
  return entry.at.trim() !== "" && !Number.isNaN(Date.parse(entry.at));
}

export interface CorrespondenceTimeline {
  /** Every entry that could be placed in time, OLDEST FIRST (chat order). */
  entries: CorrespondenceEntry[];
  /**
   * Entries that arrived with no readable timestamp, kept SEPARATE and kept at all.
   *
   * NOT DROPPED, and not sorted in among the rest either. Both of those are wrong in
   * their own way. Dropping loses a real thing that happened — the rule
   * ./dentally-merge already holds for an SMS with an unparseable time ("it happened,
   * we just cannot place it precisely"). Sorting them in is worse than dropping: an
   * empty timestamp sorts before every real one, so an undated document would render
   * at the TOP of the record as the oldest thing on it, which is a statement about
   * when the patient signed something.
   *
   * They are shown in their own group with the reason said out loud.
   */
  undated: CorrespondenceEntry[];
}

/**
 * Build the merged timeline from the four sources.
 *
 * `messages` is expected to have already been through mergeDentallySms, which is what
 * collapses a platform message and Dentally's copy of the same text into one row. That
 * de-duplication is deliberately NOT repeated here: documents and emails have no
 * platform counterpart to collapse against, and re-running a body-match over a list
 * that has already been collapsed would be a second enforcement of one rule in two
 * places, which is how the two drift.
 *
 * PURE. No I/O, no clock, no environment. The health of each read is the caller's
 * business — an empty list here means "nothing was passed in", never "the patient has
 * none", and this module deliberately has no way to express the difference so that no
 * caller can be tempted to infer it from a length.
 */
export function buildCorrespondenceTimeline(
  messages: readonly InboxMessage[],
  documents: readonly DentallyDocumentRecord[],
  emails: readonly DentallyEmailRecord[],
): CorrespondenceTimeline {
  const all: CorrespondenceEntry[] = [
    ...messages.map(
      (m): CorrespondenceEntry => ({ kind: "message", id: m.id, at: m.at, message: m }),
    ),
    // The id is namespaced per kind. A Dentally document id and a Dentally SMS id are
    // both bare integers from the same vendor and WILL collide eventually; two entries
    // sharing a React key render as one row, which silently loses a document from a
    // clinical record.
    ...documents.map(
      (d): CorrespondenceEntry => ({ kind: "document", id: `document:${d.id}`, at: d.at, document: d }),
    ),
    ...emails.map(
      (e): CorrespondenceEntry => ({ kind: "email", id: `email:${e.id}`, at: e.at, email: e }),
    ),
  ];

  const entries = all.filter(isDated);
  const undated = all.filter((e) => !isDated(e));
  // By INSTANT, not by the lexical ISO string. Dentally returns offsets ("+01:00") and
  // the platform's own stores return "Z"; a lexical compare puts a 09:00+01:00 after a
  // 09:30Z that actually preceded it. sortByStart in the diary carries the same rule
  // for the same reason.
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { entries, undated };
}

/**
 * How many of each kind are on the timeline.
 *
 * Used for the tab's own count line. Derived from the entries rather than from the
 * source arrays so it can never disagree with what is actually rendered — a count that
 * says four documents above a list showing three is a bug report from the screen.
 */
export function countByKind(
  entries: readonly CorrespondenceEntry[],
): Record<CorrespondenceKind, number> {
  const counts: Record<CorrespondenceKind, number> = { message: 0, document: 0, email: 0 };
  for (const e of entries) counts[e.kind] += 1;
  return counts;
}
