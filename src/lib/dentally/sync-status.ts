import "server-only";
import {
  countWriteIntents,
  listWriteIntents,
  ROW_CAP,
  type WriteIntentRow,
  type WriteIntentStatus,
} from "./sync-ledger";
import { syncFacts, syncHeadline, type SyncFact } from "./sync-surface";
import {
  DENTALLY_WRITE_MASTER_SLUG,
  dentallyWriteMode,
  dentallyWriteTarget,
  isDentallyWriteMasterOff,
  type DentallyWriteMode,
} from "./write-gate";

// The server-side assembly behind the Sync Status surface. It is the ONE place
// the three answers are put together — what the deployment's write mode is, what
// that means for each kind of record, and what the ledger actually holds — so
// the page and the API cannot disagree about any of them.
//
// THE LEDGER READ IS ALLOWED TO FAIL, AND SAYS SO. Migration 0096 is APPLIED —
// `dentally_write_intent` exists in production and held 0 rows when it was last
// read (4 September 2026) — so a failed read here is an ANOMALY, not the normal
// state of the deployment: a service-role key missing from a local shell, a
// revoked grant, a PostgREST blip. That is precisely why the branch below exists
// and why its sentence calls itself "a fault with this page". A surface that
// answered such a read with "nothing has been written" would be stating, as a
// fact, the opposite of what it knows. So the failure is carried through as
// `ledgerError` and rendered as a sentence, and the counts are null rather than
// zero (the honest-numbers rule: no number is better than a wrong one).
//
// Do not read this branch as scaffolding for a table that does not exist yet and
// simplify it away: it is what W3/11 and charter §0.5 require of a read that did
// not happen, whatever the reason. `migration-state-comments.test.ts` pins the
// paragraph above against drifting back to "not yet applied".
//
// THE MASTER SWITCH READS OFF ON EVERY DEPLOYMENT, AND NOBODY TURNED IT OFF.
// That same migration also seeds the master lever OFF for the pilot client — a
// `dentally-write-back` row whose `updated_by` names the migration itself — and
// in simulated mode the gate's master question is "is there a row that says
// false". So `master.off` is TRUE here from the moment
// the platform is installed, and the ledger's refusals read `master_off` rather
// than the `writes_disabled` ruling W1-A/1 describes. That is the deployment's
// permanent resting state, not an owner decision, and it is why the prose below
// is composed on BOTH switches: `syncHeadline`/`syncFacts` are handed
// `proseMode`, which is "live" only when a write really would reach the
// practice's book, so the master-switch-off sentence they return here is the
// one that names the connection as well and promises no owner that one flip
// starts the writes. Telling apart "an owner switched it off" from "a migration
// seeded it off" needs the row's `updated_by`, which lives behind
// `@/lib/systems/repository` — handed off, and until it lands the reason on a
// blocked row is the switch rather than the arming.

export interface SyncStatusPayload {
  mode: DentallyWriteMode;
  /** The host a write would be aimed at, and whether that is the live book. */
  target: { host: string; live: boolean };
  /**
   * The OWNER's master switch, read exactly as the gate reads it, so the screen
   * and the gate can never tell an owner two different things about it.
   */
  master: { slug: string; off: boolean };
  headline: string;
  facts: SyncFact[];
  /** Null when the ledger could not be read — never a zero standing in for one. */
  counts: Record<WriteIntentStatus, number> | null;
  total: number | null;
  /** True when the count is a FLOOR because the scan hit its ceiling. */
  countCapped: boolean;
  intents: WriteIntentRow[];
  /** True when there are more intents than this page holds. */
  more: boolean;
  /** The page size, so the surface can say what it showed. */
  pageSize: number;
  /** Plain English, when the ledger could not be read at all. */
  ledgerError: string | null;
}

export async function assembleSyncStatus(clientId: string, limit = 50): Promise<SyncStatusPayload> {
  const mode = dentallyWriteMode();
  const target = dentallyWriteTarget();
  const masterOff = await isDentallyWriteMasterOff(clientId, mode);
  // WHAT THE SENTENCES ARE ABOUT IS NOT THE SAME QUESTION AS `mode`.
  //
  // `mode` answers "is this deployment armed for writing" — the three
  // DENTALLY_WRITE_* variables — and that is what the screen prints beside "The
  // connection itself", correctly. The GROUPS and the HEADLINE answer a different
  // question: does what this platform does reach the practice's real Dentally
  // book? An armed deployment pointed at the local mock (the repo's own
  // `azen-web-mockwrite-3002` rehearsal) is armed and reaches nothing, and telling
  // an owner "appointments made here are written to your Dentally book" in that
  // state is the same untruth the ledger's `sent` status carried until the gate
  // learned to ask both halves. So the prose is composed on the CONJUNCTION, and
  // the payload keeps `mode` meaning exactly what it always meant.
  const reachesTheBook = mode === "live" && target.live;
  const proseMode: DentallyWriteMode = reachesTheBook ? "live" : "dry_run";
  const base = {
    mode,
    target,
    master: { slug: DENTALLY_WRITE_MASTER_SLUG, off: masterOff },
    headline: syncHeadline(proseMode, masterOff),
    facts: syncFacts(proseMode, masterOff),
    pageSize: Math.max(1, Math.min(limit, ROW_CAP)),
  };
  try {
    const [page, counted] = await Promise.all([
      listWriteIntents(clientId, { limit: base.pageSize }),
      countWriteIntents(clientId),
    ]);
    return {
      ...base,
      counts: counted.counts,
      total: counted.total,
      countCapped: counted.capped,
      intents: page.rows,
      more: page.more,
      ledgerError: null,
    };
  } catch (err) {
    console.error(`[dentally-sync-status] could not read the write ledger for ${clientId}`, err);
    // NULL, NOT FIVE ZEROS. This branch used to manufacture a complete-looking
    // count out of a read that never happened, and it is the ONLY producer of
    // this payload — so the renderer's honest `{data.counts ? … : null}` guard
    // could never fire and the stat strip always drew "Writes recorded 0 /
    // Written to Dentally 0 / Held back 0 / Dentally refused 0 / Test writes 0"
    // above a ledgerError sentence that sits three cards further down the page.
    // "Held back: 0" is a CUMULATIVE claim — a held-back write is permanent
    // (W1-A/1: no replay, ever) — so an owner who read it concluded nothing had
    // ever been held back and stopped looking. Home's own write-back tile
    // already refuses to print that zero (os-band.ts returns `unreadable` when
    // the same `countWriteIntents` throws), so the two OS surfaces stated
    // opposite facts about one read; W3/11 asked for that disagreement to be
    // closed, and the honest-numbers rule (charter §0.5) settles which way.
    // `countCapped` stays false because there is no scan to have capped.
    return {
      ...base,
      counts: null,
      total: null,
      countCapped: false,
      intents: [],
      more: false,
      ledgerError:
        "The record of what this platform has written to Dentally could not be read just now, so this page " +
        "cannot show it. That is a fault with this page, not a statement that nothing has been written.",
    };
  }
}
