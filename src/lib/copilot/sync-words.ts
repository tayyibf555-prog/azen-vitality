// ===========================================================================
// THE SYNC LEDGER, IN THE WORDS THE OWNER'S OWN SCREEN USES (ruling W3/11).
//
// `sync_status` hands the assistant rows straight off `dentally_write_intent`,
// and a ledger row is written in machine vocabulary: kind "appointment.create",
// source "patient-admin", status "blocked", blocked_reason "writes_disabled".
// The Sync Status tab renders the SAME rows and says in its own header that it
// "never prints an internal name" — statuses, kinds, sources and blocked reasons
// are all mapped to the words the rest of that page uses. So an owner who asked
// the screen and an owner who asked the co-pilot were being told about one
// ledger in two languages, and only one of them was English.
//
// WHAT IS DERIVED AND WHAT IS RESTATED, because the difference matters:
//
//   * THE SOURCE and THE BLOCKED REASON are DERIVED. `DENTALLY_WRITE_SOURCES`
//     and `BLOCKED_REASON_COPY` live in the pure leaf write-vocabulary.ts, which
//     is exactly where the screen reads them from too, so there is one copy of
//     those words in the tree and this file only looks them up.
//   * THE WRITE KIND is DERIVED at the call site, off `assembleSyncStatus`'s own
//     fact list (a fact's `id` IS the write kind and its `label` is the owner's
//     word for it), so the two halves of one tool result stop disagreeing with
//     each other.
//   * THE STATUS is RESTATED here, and that is a compromise with a reason. Its
//     map (`STATUS_COPY`) is declared inside `sync-status-view.tsx`, which is a
//     "use client" module: importing a VALUE out of one into a server file is
//     the RSC proxy trap this codebase has already been bitten by and which
//     rsc-value-import.test.ts forbids. Lifting `STATUS_COPY` into
//     write-vocabulary.ts is the right end state and is a HANDOFF (that file is
//     another lane's); until then the five words are mirrored here and
//     sync-words.test.ts CRAWLS THE VIEW'S SOURCE TEXT to prove the two agree,
//     so a change to one that is not made to the other turns a named test red.
//
// PURE. No DB, no env, no `server-only` — a lookup table and three total
// functions, so the tool that uses it stays testable without a database.
// ===========================================================================

import {
  BLOCKED_REASON_COPY,
  DENTALLY_WRITE_SOURCES,
  type BlockedReason,
  type DentallyWriteSource,
} from "@/lib/dentally/write-vocabulary";

/**
 * A ledger status, as an owner reads it.
 *
 * MIRRORED, WORD FOR WORD, from `STATUS_COPY` in
 * src/components/client/systems/sync-status-view.tsx. Not paraphrased: the point
 * is that the screen and the assistant say the same thing about the same row, so
 * a second phrasing would be a second answer. The crawl in sync-words.test.ts is
 * what keeps them identical.
 */
export const SYNC_STATUS_WORDS: Record<string, string> = {
  sent: "Written to Dentally",
  dry_run: "Test write",
  queued: "Waiting to be sent",
  blocked: "Held back",
  failed: "Dentally refused it",
};

/**
 * The owner's word for a ledger status, or the stored value when this build does
 * not know it.
 *
 * FALLS THROUGH TO THE RAW VALUE rather than to "Unknown" or a blank, exactly as
 * the screen does: a row written by a status this build has never heard of is
 * still a real row in the practice's ledger, and printing the only identifier we
 * have is the honest answer.
 */
export function syncStatusInWords(status: string): string {
  return SYNC_STATUS_WORDS[status] ?? status;
}

/**
 * Which surface asked for the write, in the words the Sync Status page prints
 * above its own table ("Patient record editing (a manager correcting a patient's
 * details)"). Read from the write registry, never restated.
 */
export function syncSourceInWords(source: string): string {
  const def = DENTALLY_WRITE_SOURCES[source as DentallyWriteSource] as { label: string } | undefined;
  return def?.label ?? source;
}

/**
 * Why a row was held back, as a sentence rather than an enum value.
 *
 * Null in, null out: "this row was not held back" and "it was held back for a
 * reason we cannot name" are different facts, and turning the first into a
 * sentence would invent the second.
 */
export function syncBlockedReasonInWords(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return BLOCKED_REASON_COPY[reason as BlockedReason] ?? reason;
}
