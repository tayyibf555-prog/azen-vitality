import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE COMPLETENESS SIGNALS, PINNED AT THE PRODUCER (charter §0.5, ruling W3/11).
//
// `assembleSyncStatus` is the ONLY producer of the Sync Status payload — the API
// route spreads it verbatim and the co-pilot's `dentally_sync_status` tool reads
// the same object — so `countCapped`, `more` and `pageSize` are true on that
// screen only if this function wires them. Nothing tested that. Every capped
// assertion in the tree hands a hand-written `countCapped: true` to the PANEL
// (sync-status-count-strip.test.ts, sync-surface.test.ts, j8-honest-numbers),
// and the only two files that drove the assembly stubbed the ledger seam with
// `capped: false, more: false`, so the sole producer-side assertion was
// `expect(payload.countCapped).toBe(false)` on the ledger-FAILURE path.
//
// The consequence of that gap, verified by mutation: `countCapped: counted.capped`
// → `false`, `more: page.more` → `false` and `pageSize: Math.max(1, Math.min(limit,
// ROW_CAP))` → `Math.max(1, limit)` ALL survived the full 14,502-test suite. With
// them broken a practice past the count ceiling reads "900" as a total, five stat
// cards print bare figures off a truncated scan, the "counted from the most recent
// writes only" note never renders and the footer claims to have shown "the most
// recent 100000". "Held back: N" is a CUMULATIVE claim — a held-back write is
// permanent (W1-A/1: no replay, ever) — so a floor read as a total is the number
// that stops an owner looking.
//
// So this is the mirror of sync-status-ledger-failure.test.ts: the same seam,
// driven the other way (a read that RAN and hit its ceiling), asserted on the
// payload AND then rendered, so the producer and the screen are pinned in one
// path.
// ===========================================================================

const h = vi.hoisted(() => ({
  capped: true,
  more: true,
  total: 900,
  /** Every limit `listWriteIntents` was actually asked for. */
  askedFor: [] as number[],
}));

vi.mock("./sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-ledger")>();
  return {
    ...actual,
    listWriteIntents: async (_clientId: string, opts: { limit?: number }) => {
      h.askedFor.push(opts?.limit ?? -1);
      return { rows: [], more: h.more };
    },
    countWriteIntents: async () => ({
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: h.total },
      total: h.total,
      capped: h.capped,
    }),
  };
});

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

import { SyncStatusPanel, type SyncStatusPayloadShape } from "@/components/client/systems/sync-status-view";
import { ROW_CAP } from "./sync-ledger";
import { assembleSyncStatus } from "./sync-status";

const render = (data: SyncStatusPayloadShape): string =>
  renderToStaticMarkup(createElement(SyncStatusPanel, { data }));

beforeEach(() => {
  h.capped = true;
  h.more = true;
  h.total = 900;
  h.askedFor = [];
});

describe("a capped ledger scan reaches the screen as a floor, not as a total", () => {
  it("carries countCapped off the ledger read rather than hard-wiring it", async () => {
    const payload = await assembleSyncStatus("vitality");
    expect(payload.countCapped, "a scan that hit its ceiling was reported as complete").toBe(true);
    expect(payload.total).toBe(900);
  });

  it("carries `more` off the page read, so the footer cannot claim it showed everything", async () => {
    const payload = await assembleSyncStatus("vitality");
    expect(payload.more, "a truncated page was reported as the whole ledger").toBe(true);
  });

  it("the screen built from that payload says 'At least', not a bare figure", async () => {
    const html = render((await assembleSyncStatus("vitality")) as SyncStatusPayloadShape);
    expect(html).toContain("At least 900");
    expect(html).toContain("Counted from the most recent writes only");
    // Every per-status card is off the SAME truncated scan, so a nought among
    // them is "none counted", never "none ever".
    expect(html).toContain("None counted");
    expect(html).toContain("of more");
  });

  it("CONTROL: an uncapped, complete read prints plain figures and no hedge", async () => {
    h.capped = false;
    h.more = false;
    h.total = 8;
    const payload = await assembleSyncStatus("vitality");
    expect(payload.countCapped).toBe(false);
    expect(payload.more).toBe(false);
    const html = render(payload as SyncStatusPayloadShape);
    expect(html).not.toContain("At least");
    expect(html).not.toContain("Counted from the most recent writes only");
    expect(html).not.toContain("of more");
  });
});

describe("the page size is clamped by the assembly, not only by the repository", () => {
  it("clamps a hand-typed ?limit=100000 to the row cap, and says the clamped number", async () => {
    // The route passes a caller-supplied limit straight through. The repository
    // clamps its own read, so a broken clamp here is invisible in the ROWS — it
    // shows up in `pageSize`, which is the number the footer prints as a claim
    // about what the reader is looking at.
    const payload = await assembleSyncStatus("vitality", 100_000);
    expect(payload.pageSize).toBe(ROW_CAP);
    expect(h.askedFor, "the ledger was asked for more rows than the cap").toEqual([ROW_CAP]);
    const html = render(payload as SyncStatusPayloadShape);
    expect(html).toContain(`The most recent ${ROW_CAP}`);
    expect(html).not.toContain("The most recent 100000");
  });

  it("keeps a sane limit exactly as asked, and floors a nonsense one at one row", async () => {
    expect((await assembleSyncStatus("vitality", 25)).pageSize).toBe(25);
    expect(h.askedFor).toEqual([25]);
    h.askedFor = [];
    expect((await assembleSyncStatus("vitality", 0)).pageSize).toBe(1);
    expect(h.askedFor).toEqual([1]);
  });
});
