import { describe, it, expect, vi, beforeEach } from "vitest";

// Campaign blocked-before-sending count.
//
// The shared drain records EVERY pre-send stop - undeliverable number (Twilio Lookup),
// missing consent/suppression, or the output safety guard - the same way: it sets the
// outbox row to status='failed' with provider='suppressed'. A genuine provider send
// failure sets status='failed' but leaves provider null. So the honest "blocked before
// sending" total is exactly the outbox rows for the campaign that are failed+suppressed,
// scoped through the touch (the outbox has no campaign_id; the touch does). There is no
// per-reason column, so no breakdown is possible and none is claimed.

interface TouchRow {
  id: string;
  campaign_id: string;
}
interface OutboxRow {
  id: string;
  touch_id: string;
  status: string;
  provider: string | null;
}

const store = vi.hoisted(() => ({
  touches: [] as TouchRow[],
  outbox: [] as OutboxRow[],
  targetCounts: {} as Record<string, number>, // "<status>" or "*" -> count, for campaignStatusCounts
}));

vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let inCol: string | null = null;
    let inVals: string[] = [];

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      in(col: string, vals: string[]) {
        inCol = col;
        inVals = vals;
        return builder;
      },
      then(resolve: (v: { data: unknown[] | null; count: number | null; error: unknown }) => unknown) {
        if (table === "outreach_touch") {
          const rows = store.touches.filter((t) => t.campaign_id === filters.campaign_id);
          return resolve({ data: rows.map((t) => ({ id: t.id })), count: null, error: null });
        }
        if (table === "outreach_outbox") {
          const rows = store.outbox.filter(
            (o) =>
              (inCol !== "touch_id" || inVals.includes(o.touch_id)) &&
              (filters.status === undefined || o.status === filters.status) &&
              (filters.provider === undefined || o.provider === filters.provider),
          );
          return resolve({ data: null, count: rows.length, error: null });
        }
        if (table === "outreach_target") {
          const key = filters.status === undefined ? "*" : String(filters.status);
          return resolve({ data: null, count: store.targetCounts[key] ?? 0, error: null });
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { campaignBlockedCount, campaignStatusCounts } from "./repository";

beforeEach(() => {
  store.touches.length = 0;
  store.outbox.length = 0;
  store.targetCounts = {};
});

describe("campaignBlockedCount", () => {
  it("counts only failed+suppressed outbox rows on the campaign's touches", async () => {
    store.touches.push({ id: "t1", campaign_id: "C" });
    store.touches.push({ id: "t2", campaign_id: "C" });
    store.touches.push({ id: "t-other", campaign_id: "OTHER" });
    store.outbox.push({ id: "o1", touch_id: "t1", status: "failed", provider: "suppressed" }); // blocked
    store.outbox.push({ id: "o2", touch_id: "t2", status: "failed", provider: "suppressed" }); // blocked
    store.outbox.push({ id: "o3", touch_id: "t1", status: "failed", provider: null }); // genuine failure - NOT blocked
    store.outbox.push({ id: "o4", touch_id: "t2", status: "sent", provider: "twilio" }); // sent
    store.outbox.push({ id: "o5", touch_id: "t-other", status: "failed", provider: "suppressed" }); // other campaign
    expect(await campaignBlockedCount("C")).toBe(2);
  });

  it("does NOT count a genuine provider failure (failed with provider null)", async () => {
    store.touches.push({ id: "t1", campaign_id: "C" });
    store.outbox.push({ id: "o1", touch_id: "t1", status: "failed", provider: null });
    expect(await campaignBlockedCount("C")).toBe(0);
  });

  it("returns 0 without touching the outbox when the campaign has no touches", async () => {
    expect(await campaignBlockedCount("C")).toBe(0);
  });
});

describe("campaignStatusCounts", () => {
  it("includes the blocked total alongside the target buckets", async () => {
    store.targetCounts = { "*": 40, contacted: 12, replied: 3, booked: 1 };
    store.touches.push({ id: "t1", campaign_id: "C" });
    store.outbox.push({ id: "o1", touch_id: "t1", status: "failed", provider: "suppressed" });
    const counts = await campaignStatusCounts("C");
    expect(counts).toEqual({ built: 40, contacted: 12, replied: 3, booked: 1, blocked: 1 });
  });
});
