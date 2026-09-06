import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { srcPath, walkSrc } from "@/lib/test-support/walk-src";

// ===========================================================================
// NO COMMENT IN THIS MODULE TELLS THE NEXT READER THAT AN APPLIED MIGRATION IS
// STILL PENDING.
//
// docs/runbooks/booking-live-calibration.md said "migration 0096 is written and
// NOT applied — until a human applies it the ledger records nothing", and
// src/lib/agent-wiring/runbook.test.ts §4 was written to stop it. But §4 crawls
// docs/runbooks and nothing else, and the SAME SENTENCE was sitting in the
// source the whole time: sync-status.ts's header opened "Migration 0096 is
// written and not yet applied, so on today's deployment the read errors", with
// sync-ledger.ts's dedupe note and sync-ledger.test.ts repeating the premise.
//
// 0096 was applied on 3 September 2026 and confirmed on the 4th by a read-only
// `select to_regclass('public.dentally_write_intent')` against production (the
// table exists; 0 rows), so all three were false — and false in a direction that
// costs something. Charter §0.1 makes a module comment the calibration contract,
// and the contract those three stated was: a failed ledger read is the RESTING
// STATE of this deployment. A reader who believes that treats a real
// `ledgerError` on Sync Status as expected instead of as the fault it now is,
// and may simplify away the null-counts branch as scaffolding for a table that
// does not exist yet — the branch ruling W3/11 and the honest-numbers rule
// (charter §0.5) required, and the one thing standing between an owner and a
// manufactured "Held back: 0".
//
// A test cannot see that a comment's REASON has gone stale, so this is the pin:
// the same window sweep §4 runs over the runbooks, run over this module's own
// source (tests included — sync-ledger.test.ts carried the claim too).
// ===========================================================================

/**
 * Applied in production, from the programme's decisions log. 0094/0095 and
 * 0096-0100 are the wave-1 set (0096 additionally confirmed by the read-only
 * `to_regclass` check above); 0101-0104 were applied by Fable across wave 3.
 *
 * Deliberately NOT here: 0084, named in display-cache.ts. Its state is not
 * recorded in the programme's log, and this sweep may only assert what the log
 * settles — a number added on a guess would make the guard a liar in the other
 * direction. Add it (with its citation) when someone has actually checked.
 */
const APPLIED = ["0094", "0095", "0096", "0097", "0098", "0099", "0100", "0101", "0102", "0103", "0104"];

/**
 * The phrasings that place a migration in the future.
 *
 * The first is §4's regex, widened by the two forms it does not have words for
 * ("yet to be applied", "still to be applied"). The second is the one the fix
 * lane found by mutation and §4 would have let through: sync-ledger.ts opened
 * "Until migration 0096 is applied, EVERY intent fails the same way", which
 * never says "not applied" and presupposes it just as flatly. `[^.;]` keeps the
 * clause inside one sentence, so "…FAILS THE SAME WAY. Migration 0096 is applied
 * in production" — a true statement two words later — is not swept up by a
 * "before" belonging to a different thought.
 */
const PENDING = [
  /not applied|unapplied|never applied|awaiting application|not been applied|not yet applied|yet to be applied|still to be applied/i,
  /\b(until|once|before)\b[^.;]{0,80}\bis applied\b/i,
];

const saysPending = (window: string): boolean => PENDING.some((re) => re.test(window));

/** This file quotes the offending phrases in order to forbid them. */
const SELF = "lib/dentally/migration-state-comments.test.ts";

const FILES = walkSrc({ subdir: "lib/dentally", includeTests: true }).filter((f) => f !== SELF);

describe("src/lib/dentally never says an applied migration is pending", () => {
  it("has files to sweep at all", () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES).toContain("lib/dentally/sync-status.ts");
    expect(FILES).toContain("lib/dentally/sync-ledger.ts");
    expect(FILES).toContain("lib/dentally/sync-ledger.test.ts");
  });

  it("never describes one of them as unapplied", () => {
    for (const file of FILES) {
      const text = readFileSync(srcPath(file), "utf8").replace(/\s+/g, " ");
      for (const number of APPLIED) {
        for (let at = text.indexOf(number); at !== -1; at = text.indexOf(number, at + 1)) {
          const around = text.slice(Math.max(0, at - 160), at + 160);
          expect(
            saysPending(around),
            `src/${file} places migration ${number} in the future: "${around.trim()}"`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("the Sync Status header states the ledger's real deployment state", () => {
  const header = readFileSync(srcPath("lib/dentally/sync-status.ts"), "utf8").replace(/\s+/g, " ");

  it("says 0096 is applied, so a failed ledger read reads as the anomaly it is", () => {
    expect(header).toContain("Migration 0096 is APPLIED");
    expect(header).toMatch(/failed read here is an ANOMALY/);
  });

  it("still tells the next reader not to delete the honest null-counts branch", () => {
    // The branch is unreachable on a healthy deployment, which is exactly what
    // makes it look like dead scaffolding. W3/11 and charter §0.5 put it there.
    expect(header).toMatch(/W3\/11/);
    expect(header).toMatch(/simplify it away/);
  });
});
