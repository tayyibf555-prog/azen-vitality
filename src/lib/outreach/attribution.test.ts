// Per-variant read-back + stamp-once attribution.
//
// campaignVariantCounts reports assigned/sent/replied/booked per message from the
// target's durable columns (variant, replied_at, booked_at) and the distinct set of
// targets with an actually-sent touch of each variant. markOutreachReplied /
// markOutreachBooked stamp their timestamp exactly ONCE: the `.is(col, null)` guard means
// a repeat call (a second reply, a retried webhook) matches no rows and never moves the
// original time. This test drives a small in-memory stand-in for the service client so
// the update guard and the row reads are exercised end to end.
import { describe, it, expect, beforeEach, vi } from "vitest";

interface TargetRow {
  id: string;
  campaign_id: string;
  variant: string | null;
  status: string;
  replied_at: string | null;
  booked_at: string | null;
  ended_at: string | null;
  next_due_at: string | null;
}
interface TouchRow {
  id: string;
  campaign_id: string;
  variant: string | null;
  target_id: string;
  direction: string;
  status: string;
}

const store = vi.hoisted(() => ({
  targets: [] as TargetRow[],
  touches: [] as TouchRow[],
}));

vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    const eqs: Record<string, unknown> = {};
    const ins: Record<string, unknown[]> = {};
    const nulls: string[] = [];
    let updatePayload: Record<string, unknown> | null = null;

    const rows = (): Array<Record<string, unknown>> =>
      table === "outreach_target" ? (store.targets as unknown as Array<Record<string, unknown>>)
        : (store.touches as unknown as Array<Record<string, unknown>>);

    const matches = (r: Record<string, unknown>): boolean => {
      for (const [k, v] of Object.entries(eqs)) if (r[k] !== v) return false;
      for (const [k, vs] of Object.entries(ins)) if (!vs.includes(r[k] as never)) return false;
      for (const k of nulls) if (r[k] != null) return false;
      return true;
    };

    const builder = {
      select() { return builder; },
      update(payload: Record<string, unknown>) { updatePayload = payload; return builder; },
      eq(col: string, val: unknown) { eqs[col] = val; return builder; },
      in(col: string, vals: unknown[]) { ins[col] = vals; return builder; },
      is(col: string) { nulls.push(col); return builder; },
      then(resolve: (v: { data: unknown[] | null; count: number | null; error: unknown }) => unknown) {
        if (updatePayload) {
          const affected = rows().filter(matches);
          for (const r of affected) Object.assign(r, updatePayload);
          return resolve({ data: affected.map((r) => ({ id: r.id })), count: null, error: null });
        }
        return resolve({ data: rows().filter(matches), count: null, error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { campaignVariantCounts, markOutreachReplied, markOutreachBooked } from "./repository";

beforeEach(() => {
  store.targets.length = 0;
  store.touches.length = 0;
});

function target(over: Partial<TargetRow>): TargetRow {
  return {
    id: over.id ?? "t",
    campaign_id: over.campaign_id ?? "C",
    variant: over.variant ?? null,
    status: over.status ?? "contacted",
    replied_at: over.replied_at ?? null,
    booked_at: over.booked_at ?? null,
    ended_at: over.ended_at ?? null,
    next_due_at: over.next_due_at ?? null,
  };
}

describe("campaignVariantCounts", () => {
  it("tallies assigned/sent/replied/booked per message, per patient", async () => {
    // Arm A: 3 assigned, 2 sent (one blocked-before-send so no sent touch), 1 replied, 1 booked.
    store.targets.push(target({ id: "a1", variant: "a", replied_at: "2026-07-10T00:00:00Z", booked_at: "2026-07-11T00:00:00Z", status: "booked" }));
    store.targets.push(target({ id: "a2", variant: "a", replied_at: "2026-07-10T00:00:00Z" }));
    store.targets.push(target({ id: "a3", variant: "a" })); // assigned but its send was blocked
    // Arm B: 2 assigned, 2 sent, 0 replied, 0 booked.
    store.targets.push(target({ id: "b1", variant: "b" }));
    store.targets.push(target({ id: "b2", variant: "b" }));
    // A patient still pending (no variant yet) must not count.
    store.targets.push(target({ id: "p1", variant: null, status: "pending" }));

    // Sent touches (only these count towards "sent"). a1 has TWO sent touches (cadence
    // steps 1 and 2) but must count as ONE sent patient. a3 has none (blocked).
    store.touches.push({ id: "x1", campaign_id: "C", variant: "a", target_id: "a1", direction: "outbound", status: "sent" });
    store.touches.push({ id: "x2", campaign_id: "C", variant: "a", target_id: "a1", direction: "outbound", status: "sent" });
    store.touches.push({ id: "x3", campaign_id: "C", variant: "a", target_id: "a2", direction: "outbound", status: "sent" });
    store.touches.push({ id: "x4", campaign_id: "C", variant: "b", target_id: "b1", direction: "outbound", status: "sent" });
    store.touches.push({ id: "x5", campaign_id: "C", variant: "b", target_id: "b2", direction: "outbound", status: "sent" });
    // A failed/blocked touch is not a send.
    store.touches.push({ id: "x6", campaign_id: "C", variant: "a", target_id: "a3", direction: "outbound", status: "failed" });

    const counts = await campaignVariantCounts("C");
    expect(counts.a).toEqual({ assigned: 3, sent: 2, replied: 2, booked: 1 });
    expect(counts.b).toEqual({ assigned: 2, sent: 2, replied: 0, booked: 0 });
  });

  it("is all zeros for a campaign with no assigned targets", async () => {
    const counts = await campaignVariantCounts("EMPTY");
    expect(counts).toEqual({ a: { assigned: 0, sent: 0, replied: 0, booked: 0 }, b: { assigned: 0, sent: 0, replied: 0, booked: 0 } });
  });
});

describe("markOutreachReplied (stamp once)", () => {
  it("stamps replied_at and ends the cadence, and a second call never moves it", async () => {
    store.targets.push(target({ id: "t1", variant: "a", status: "contacted" }));
    await markOutreachReplied("t1");
    const row = store.targets.find((t) => t.id === "t1")!;
    expect(row.status).toBe("replied");
    expect(row.replied_at).toBeTruthy();
    expect(row.next_due_at).toBeNull();
    const firstStamp = row.replied_at;

    // A later duplicate reply must NOT overwrite the original time (the .is(null) guard).
    await new Promise((r) => setTimeout(r, 2));
    await markOutreachReplied("t1");
    expect(row.replied_at).toBe(firstStamp);
  });
});

describe("markOutreachBooked (stamp once)", () => {
  it("upgrades to booked and stamps booked_at once, keeping any existing replied_at", async () => {
    store.targets.push(target({ id: "t1", variant: "b", status: "replied", replied_at: "2026-07-10T00:00:00Z" }));
    await markOutreachBooked("t1");
    const row = store.targets.find((t) => t.id === "t1")!;
    expect(row.status).toBe("booked");
    expect(row.booked_at).toBeTruthy();
    expect(row.replied_at).toBe("2026-07-10T00:00:00Z"); // reply funnel preserved
    const firstStamp = row.booked_at;

    await new Promise((r) => setTimeout(r, 2));
    await markOutreachBooked("t1");
    expect(row.booked_at).toBe(firstStamp);
  });
});
