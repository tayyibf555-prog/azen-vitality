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
// THE LEDGER READ IS ALLOWED TO FAIL, AND SAYS SO. Migration 0096 is written and
// not yet applied, so on today's deployment the read errors. A surface that
// answered an empty table with "nothing has been written" would be stating, as a
// fact, the opposite of what it knows. So the failure is carried through as
// `ledgerError` and rendered as a sentence, and the counts are null rather than
// zero (the honest-numbers rule: no number is better than a wrong one).

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
  const base = {
    mode,
    target,
    master: { slug: DENTALLY_WRITE_MASTER_SLUG, off: masterOff },
    headline: syncHeadline(mode, masterOff),
    facts: syncFacts(mode, masterOff),
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
