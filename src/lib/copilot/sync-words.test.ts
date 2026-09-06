import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

// ===========================================================================
// THE SYNC LEDGER REACHES THE ASSISTANT IN THE OWNER'S OWN WORDS (ruling W3/11).
//
// The Sync Status tab and `sync_status` render THE SAME LEDGER ROWS. The tab
// translates every field of one — its header says it "never prints an internal
// name" — and the tool handed the assistant "appointment.create",
// "patient-admin", "blocked", "writes_disabled" instead. So an owner asking the
// screen and an owner asking the assistant were told about one ledger in two
// vocabularies, and the machine one is the one he cannot act on: `writes_disabled`
// is his agency's key and `master_off` is his own switch, and neither word
// appears anywhere on his screens.
//
// FOUR CLAIMS HERE, and the third is the one that keeps this honest over time:
//   1. Each of the five statuses, the five sources' shapes and the six blocked
//      reasons resolve to a human sentence.
//   2. An UNKNOWN value falls through to the stored token rather than to a blank
//      or to "Unknown" — a row this build does not recognise is still a real row
//      in the practice's ledger and the only identifier we have is the honest
//      answer. Same fallback the screen makes.
//   3. THE WORDS MATCH THE SCREEN'S, asserted by crawling the view's own source
//      text. `STATUS_COPY` lives inside a "use client" module, so a server file
//      cannot import the value (the RSC proxy trap, pinned by
//      rsc-value-import.test.ts) and the five words are mirrored in
//      sync-words.ts. A mirror with no pin is a mirror that drifts; this is the
//      pin. Lifting STATUS_COPY into the pure leaf write-vocabulary.ts is the
//      right end state and is a handoff to that file's owner.
//   4. The REAL dispatch emits both halves on a real ledger row — the machine
//      code the journey suite matches on and the words the assistant reads out —
//      which is asserted next door, in sync-status-answer.test.ts, because that
//      is where the tool's own payload is already driven.
// ===========================================================================

vi.mock("server-only", () => ({}));

import {
  SYNC_STATUS_WORDS,
  syncBlockedReasonInWords,
  syncSourceInWords,
  syncStatusInWords,
} from "./sync-words";
import {
  BLOCKED_REASONS,
  DENTALLY_WRITE_SOURCES,
  WRITE_INTENT_STATUSES,
} from "@/lib/dentally/write-vocabulary";

const VIEW_SOURCE = readFileSync(
  new URL("../../components/client/systems/sync-status-view.tsx", import.meta.url),
  "utf8",
);

describe("the sync ledger's machine vocabulary, translated once", () => {
  it("has a human sentence for EVERY status the ledger can hold", () => {
    // Driven off the enum rather than off a list typed here, so a sixth status
    // added to migration 0096's CHECK turns this red instead of silently
    // reaching an owner as a raw token.
    for (const status of WRITE_INTENT_STATUSES) {
      const words = syncStatusInWords(status);
      expect(words, `no words for status ${status}`).not.toBe(status);
      expect(words, `${status} still reads like a code`).not.toMatch(/[_.]/);
    }
  });

  it("has a human sentence for EVERY blocked reason, and null stays null", () => {
    for (const reason of BLOCKED_REASONS) {
      const words = syncBlockedReasonInWords(reason);
      expect(words, `no words for ${reason}`).not.toBe(reason);
      expect(String(words).length, `${reason} reads too short to be a sentence`).toBeGreaterThan(40);
    }
    // "This row was not held back" and "it was held back for a reason we cannot
    // name" are different facts. Turning the first into a sentence invents the
    // second.
    expect(syncBlockedReasonInWords(null)).toBeNull();
    expect(syncBlockedReasonInWords("")).toBeNull();
  });

  it("names every write SOURCE the way the registry does, never by its key", () => {
    for (const key of Object.keys(DENTALLY_WRITE_SOURCES)) {
      expect(syncSourceInWords(key)).toBe(
        (DENTALLY_WRITE_SOURCES as Record<string, { label: string }>)[key].label,
      );
    }
    // The two that read worst as keys, named explicitly: neither matches the
    // switch an owner flips, and one is a hyphenated slug.
    expect(syncSourceInWords("noshow")).toMatch(/No-show defence/);
    expect(syncSourceInWords("patient-admin")).toMatch(/Patient record editing/);
  });

  it("falls through to the stored value for something this build does not know", () => {
    expect(syncStatusInWords("half_sent")).toBe("half_sent");
    expect(syncSourceInWords("some-future-desk")).toBe("some-future-desk");
    expect(syncBlockedReasonInWords("rate_limited")).toBe("rate_limited");
  });

  it("SAYS THE SAME WORDS THE OWNER'S SCREEN SAYS, asserted against the view's source", () => {
    // The mirror's pin. STATUS_COPY is declared inside a "use client" module and
    // cannot be imported as a value from here, so the agreement is proved by
    // reading the file rather than by importing it.
    for (const [status, words] of Object.entries(SYNC_STATUS_WORDS)) {
      expect(
        VIEW_SOURCE,
        `sync-status-view.tsx no longer says "${words}" for ${status}; the screen and the assistant have drifted apart`,
      ).toContain(`"${words}"`);
    }
    // ...and the view really is the file this claim is about.
    expect(VIEW_SOURCE).toContain("STATUS_COPY");
    expect(VIEW_SOURCE).toContain("AND IT NEVER PRINTS AN INTERNAL NAME");
  });
});
