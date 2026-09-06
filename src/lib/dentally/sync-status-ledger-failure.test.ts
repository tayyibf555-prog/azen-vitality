import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// WHAT THE SYNC STATUS SURFACE EMITS WHEN THE WRITE LEDGER CANNOT BE READ.
//
// The module's own contract says it twice — in the header ("the counts are null
// rather than zero (the honest-numbers rule: no number is better than a wrong
// one)") and on the field itself ("Null when the ledger could not be read —
// never a zero standing in for one") — and its catch block used to return five
// hard zeros anyway.
//
// The two honesty tests that already existed (sync-surface.test.ts "prints NO
// count at all when the ledger could not be read" and os-scenarios/
// j8-honest-numbers.test.ts) both hand the PANEL a hand-built `counts: null`
// payload. Nothing tested the PRODUCER, and `assembleSyncStatus` is the only
// producer there is — the API route spreads it verbatim and the co-pilot's
// dentally_sync_status tool reads the same object — so the panel's honest
// branch was unreachable in production and the strip always drew "Held back 0".
// A held-back write is permanent (W1-A/1: no replay, ever), so that nought is a
// cumulative claim about the whole ledger, and it is the one sentence that
// stops an owner looking any further.
//
// So these tests drive the real assembly with a failing ledger read and then
// render the panel from THAT payload — the producer and the screen pinned in
// one path, which is what the panel-only tests could not do.
// ===========================================================================

const h = vi.hoisted(() => ({
  countThrows: false,
  listThrows: false,
}));

vi.mock("./sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-ledger")>();
  return {
    ...actual,
    listWriteIntents: async () => {
      if (h.listThrows) throw new Error("relation \"dentally_write_intent\" does not exist");
      return { rows: [], more: false };
    },
    countWriteIntents: async () => {
      if (h.countThrows) throw new Error("relation \"dentally_write_intent\" does not exist");
      return {
        counts: { dry_run: 3, queued: 0, sent: 0, failed: 1, blocked: 7 },
        total: 11,
        capped: false,
      };
    },
  };
});

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

import { SyncStatusPanel, type SyncStatusPayloadShape } from "@/components/client/systems/sync-status-view";
import { assembleSyncStatus } from "./sync-status";

const render = (data: SyncStatusPayloadShape): string =>
  renderToStaticMarkup(createElement(SyncStatusPanel, { data }));

beforeEach(() => {
  h.countThrows = false;
  h.listThrows = false;
});

describe("a failed write-ledger read never becomes a zero", () => {
  it("returns NULL counts and a null total when the count read throws", async () => {
    h.countThrows = true;
    const payload = await assembleSyncStatus("vitality");
    expect(payload.counts, "five zeros were manufactured out of a read that never happened").toBeNull();
    expect(payload.total).toBeNull();
    // Nothing was scanned, so nothing can have hit a ceiling.
    expect(payload.countCapped).toBe(false);
    expect(payload.ledgerError).toMatch(/could not be read/i);
  });

  it("returns NULL counts when the ROW read throws as well", async () => {
    // Either half of the Promise.all failing lands in the same catch; both must
    // reach the same answer, or the honesty depends on which query broke first.
    h.listThrows = true;
    const payload = await assembleSyncStatus("vitality");
    expect(payload.counts).toBeNull();
    expect(payload.total).toBeNull();
    expect(payload.intents).toEqual([]);
    expect(payload.ledgerError).toMatch(/could not be read/i);
  });

  it("the screen built from that payload prints no stat strip and no 'Held back' nought", async () => {
    h.countThrows = true;
    const html = render(await assembleSyncStatus("vitality"));
    expect(html).not.toContain("Writes recorded");
    expect(html).not.toContain("Held back");
    expect(html).not.toContain("Written to Dentally");
    expect(html).toContain("could not be read just now");
  });

  it("CONTROL: a ledger that READS still prints its figures", async () => {
    const payload = await assembleSyncStatus("vitality");
    expect(payload.counts).toEqual({ dry_run: 3, queued: 0, sent: 0, failed: 1, blocked: 7 });
    expect(payload.total).toBe(11);
    expect(payload.ledgerError).toBeNull();
    const html = render(payload);
    expect(html).toContain("Writes recorded");
    expect(html).toContain("Held back");
  });

  it("agrees with the home tile: both go quiet on the SAME failing read", async () => {
    // Home's Operating system band wraps this very `countWriteIntents` in
    // `attempt()` and returns `{ kind: "unreadable" }` (os-band.ts). W3/11 asked
    // for the two surfaces to stop stating opposite facts about one read, so the
    // pin is that Sync Status has no figure to disagree with.
    h.countThrows = true;
    const payload = await assembleSyncStatus("vitality");
    expect(payload.counts).toBeNull();
    expect(payload.total).toBeNull();
  });
});
