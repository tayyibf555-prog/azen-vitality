import { describe, it, expect, vi, beforeEach } from "vitest";

// booking_hold lifecycle (create / confirm / expire / list-abandoned) against a
// chainable Supabase mock, plus the pure earliest-first slot ordering that powers
// the "next available" quick-picks.

const h = vi.hoisted(() => {
  let result: { data: unknown; error: unknown } = { data: null, error: null };
  const insert = vi.fn();
  const update = vi.fn();
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    b.insert = (...a: unknown[]) => {
      insert(...a);
      return b;
    };
    b.update = (...a: unknown[]) => {
      update(...a);
      return b;
    };
    b.select = () => b;
    b.eq = () => b;
    b.lt = () => b;
    b.gte = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.single = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    set: (r: { data: unknown; error: unknown }) => {
      result = r;
    },
    insert,
    update,
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import {
  createHold,
  markHoldConfirmed,
  markHoldExpired,
  listAbandonedHolds,
} from "./holds";
import { earliestSlots } from "./slots";
import type { BookingDay } from "./slots";

const HOLD_ROW = {
  id: "hold-1",
  client_id: "vitality",
  site_id: "site-cc",
  slot_start: "2026-07-20T09:00:00.000Z",
  slot_finish: "2026-07-20T09:30:00.000Z",
  practitioner_id: "7",
  practitioner_name: null,
  treatment: "Exam",
  name: "Alex Patient",
  phone: "+447700900123",
  email: null,
  status: "held",
  created_at: "2026-07-20T08:00:00.000Z",
  updated_at: "2026-07-20T08:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
});

describe("createHold", () => {
  it("inserts a held row and maps it to the domain shape", async () => {
    h.set({ data: HOLD_ROW, error: null });
    const hold = await createHold({
      clientId: "vitality",
      siteId: "site-cc",
      slotStart: "2026-07-20T09:00:00.000Z",
      slotFinish: "2026-07-20T09:30:00.000Z",
      practitionerId: "7",
      name: "Alex Patient",
      phone: "+447700900123",
    });
    expect(hold.id).toBe("hold-1");
    expect(hold.status).toBe("held");
    expect(hold.slotStart).toBe("2026-07-20T09:00:00.000Z");
    // treatment defaults to Exam and email to null when not supplied.
    const payload = h.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.site_id).toBe("site-cc");
    expect(payload.treatment).toBe("Exam");
    expect(payload.email).toBeNull();
    expect(payload.practitioner_id).toBe("7");
    // status is left to the DB default ('held'), never sent from app code.
    expect(payload).not.toHaveProperty("status");
  });

  it("propagates an insert error", async () => {
    h.set({ data: null, error: { message: "denied" } });
    await expect(
      createHold({
        clientId: "vitality",
        siteId: "site-cc",
        slotStart: "2026-07-20T09:00:00.000Z",
        slotFinish: "2026-07-20T09:30:00.000Z",
        name: "Alex",
        phone: "+447700900123",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("markHoldConfirmed / markHoldExpired", () => {
  it("confirms with a status flip and a fresh updated_at", async () => {
    h.set({ data: null, error: null });
    await expect(markHoldConfirmed("hold-1", "site-cc")).resolves.toBeUndefined();
    const patch = h.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.status).toBe("confirmed");
    expect(typeof patch.updated_at).toBe("string");
  });

  it("expires with a status flip", async () => {
    h.set({ data: null, error: null });
    await markHoldExpired("hold-1");
    const patch = h.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.status).toBe("expired");
  });

  it("propagates a confirm error", async () => {
    h.set({ data: null, error: { message: "boom" } });
    await expect(markHoldConfirmed("hold-1", "site-cc")).rejects.toBeTruthy();
  });
});

describe("listAbandonedHolds", () => {
  it("maps returned rows to holds", async () => {
    h.set({ data: [HOLD_ROW], error: null });
    const holds = await listAbandonedHolds(
      "2026-07-20T08:40:00.000Z",
      "2026-07-18T08:00:00.000Z",
      25,
    );
    expect(holds).toHaveLength(1);
    expect(holds[0]!.id).toBe("hold-1");
    expect(holds[0]!.status).toBe("held");
  });

  it("propagates a read error", async () => {
    h.set({ data: null, error: { message: "down" } });
    await expect(
      listAbandonedHolds("2026-07-20T08:40:00.000Z", "2026-07-18T08:00:00.000Z", 25),
    ).rejects.toBeTruthy();
  });
});

describe("earliestSlots (earliest-first ordering)", () => {
  const days: BookingDay[] = [
    {
      date: "2026-07-21",
      slots: [
        { start: "2026-07-21T09:00:00.000Z", finish: "2026-07-21T09:30:00.000Z", practitionerId: "7" },
        { start: "2026-07-21T14:00:00.000Z", finish: "2026-07-21T14:30:00.000Z", practitionerId: "7" },
      ],
    },
    {
      date: "2026-07-20",
      slots: [
        { start: "2026-07-20T16:00:00.000Z", finish: "2026-07-20T16:30:00.000Z", practitionerId: "8" },
        { start: "2026-07-20T10:00:00.000Z", finish: "2026-07-20T10:30:00.000Z", practitionerId: "8" },
      ],
    },
  ];

  it("returns the soonest N slots across all days, soonest first", () => {
    const picks = earliestSlots(days, 3);
    expect(picks.map((s) => s.start)).toEqual([
      "2026-07-20T10:00:00.000Z",
      "2026-07-20T16:00:00.000Z",
      "2026-07-21T09:00:00.000Z",
    ]);
    // Each pick carries its own day key for labelling.
    expect(picks[0]!.date).toBe("2026-07-20");
  });

  it("caps at the requested count and copes with fewer than N", () => {
    expect(earliestSlots(days, 1)).toHaveLength(1);
    expect(earliestSlots(days, 99)).toHaveLength(4);
  });

  it("returns nothing for a non-positive limit or empty input", () => {
    expect(earliestSlots(days, 0)).toEqual([]);
    expect(earliestSlots([], 3)).toEqual([]);
  });
});
