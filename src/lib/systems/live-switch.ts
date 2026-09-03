// ===========================================================================
// THE OWNER'S SWITCH, RE-READ DURING A LONG RUN.
//
// Every sweep in this platform used to read its kill switch ONCE, at the top of
// the run, and then loop for up to 300 seconds. An owner who switched a system
// off mid-run did not stop the batch already in flight from DRAFTING: nothing
// was delivered (the drain re-reads the switch and refuses the source), but the
// model calls were spent, the worklist filled with messages nobody wanted, and
// the rows sat in the outbox for 48 hours ready to go the moment the system came
// back on.
//
// Ruling W1-B/5 (3 Sep 2026): sweeps re-read their switch inside the batch loop
// every ten rows, and stop drafting within that bound. Ten is a deliberate
// trade: one extra toggle read per ten rows is negligible next to the Anthropic
// call each row already makes, and it bounds the exposure at ten rows rather
// than at the whole run.
//
// IT IS WRITTEN ONCE, HERE, FOR THE SAME REASON THE WAITLIST-FILL GUARD MOVED
// INTO fill.ts: a rule copied into five loops is a rule that will be in four of
// them by the end of the year.
//
// FAIL DIRECTION. isSystemEnabledForSend, so an unreadable toggle table stops
// the run once messaging is LIVE and is ignored while MESSAGING_DRY_RUN is on.
// Once it has read OFF it stays off for the rest of the run and issues no
// further reads: a switch that flickered back on mid-batch is not a reason to
// resume drafting inside the same tick, and the next tick starts clean anyway.
// ===========================================================================

import { isSystemEnabledForSend } from "./repository";

/** How many rows may pass between two reads of the switch. */
export const SWITCH_RECHECK_EVERY_ROWS = 10;

export interface LiveSwitch {
  /**
   * Call once per row, BEFORE doing any work for it. Returns false the moment the
   * owner's switch has been read as off; the caller must then stop drafting.
   */
  stillOn(): Promise<boolean>;
  /** True once the switch has been observed OFF, for the run's response body. */
  readonly switchedOffMidRun: boolean;
  /** How many rows were admitted before it stopped. */
  readonly rowsAdmitted: number;
}

/**
 * A per-run gate over one system's switch.
 *
 * The caller is expected to have checked the switch already, before the loop, so
 * row 0 costs no read: the first re-read lands on row `everyRows`. With the
 * default of ten that means a switch flipped off after row 12 stops the run at
 * row 20 — the bound the ruling asks for.
 */
export function liveSwitch(
  clientId: string,
  slug: string,
  everyRows: number = SWITCH_RECHECK_EVERY_ROWS,
): LiveSwitch {
  let seen = 0;
  let off = false;
  return {
    get switchedOffMidRun() {
      return off;
    },
    get rowsAdmitted() {
      return seen;
    },
    async stillOn(): Promise<boolean> {
      if (off) return false;
      if (seen > 0 && seen % everyRows === 0) {
        if (!(await isSystemEnabledForSend(clientId, slug))) {
          off = true;
          console.warn(
            `[systems] ${slug} was switched off mid-run; stopping after ${seen} rows. ` +
              `Nothing further is drafted this tick.`,
          );
          return false;
        }
      }
      seen += 1;
      return true;
    },
  };
}
