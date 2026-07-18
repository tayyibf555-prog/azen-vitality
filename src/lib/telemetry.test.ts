import { describe, it, expect, vi, beforeEach } from "vitest";

// telemetry.ts is server-only and talks to Supabase via serviceClient. Stub the
// server-only marker and back serviceClient with a tiny in-memory usage_event table
// so the allowlist gate, the action write, and the grouped read are all covered.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  let rows: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  let throwNext = false;

  function makeBuilder() {
    const state: {
      head: boolean;
      count: boolean;
      cols: string;
      filters: Array<[string, unknown]>;
      range: [number, number] | null;
      insert: Array<Record<string, unknown>> | null;
    } = { head: false, count: false, cols: "", filters: [], range: null, insert: null };

    const resolve = () => {
      if (state.insert) {
        for (const r of state.insert) inserted.push(r);
        return { data: null, error: null };
      }
      const filtered = rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
      if (state.head && state.count) return { count: filtered.length, error: null };
      let slice = filtered;
      if (state.range) slice = filtered.slice(state.range[0], state.range[1] + 1);
      const cols = state.cols.split(",").map((c) => c.trim());
      const data = slice.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      return { data, error: null };
    };

    const b: Record<string, unknown> = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        state.cols = cols;
        if (opts?.head) state.head = true;
        if (opts?.count) state.count = true;
        return b;
      },
      insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
        state.insert = Array.isArray(payload) ? payload : [payload];
        return b;
      },
      eq(col: string, val: unknown) {
        state.filters.push([col, val]);
        return b;
      },
      gte() {
        return b;
      },
      lte() {
        return b;
      },
      order() {
        return b;
      },
      range(from: number, to: number) {
        state.range = [from, to];
        return b;
      },
      then(onFulfilled: (v: unknown) => void) {
        onFulfilled(resolve());
        return Promise.resolve();
      },
    };
    return b;
  }

  const serviceClient = vi.fn(() => {
    if (throwNext) {
      throwNext = false;
      throw new Error("boom");
    }
    return { from: () => makeBuilder() };
  });

  return {
    serviceClient,
    inserted,
    setRows(r: Array<Record<string, unknown>>) {
      rows = r;
    },
    reset() {
      rows = [];
      inserted.length = 0;
      throwNext = false;
    },
    failOnce() {
      throwNext = true;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { sanitiseSurface, recordUsage, usageSummary } from "@/lib/telemetry";

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe("sanitiseSurface", () => {
  it("accepts known module slugs", () => {
    expect(sanitiseSurface("patients")).toBe("patients");
    expect(sanitiseSurface("outreach")).toBe("outreach");
    expect(sanitiseSurface("co-pilot")).toBe("co-pilot");
  });

  it("maps the empty slug to overview", () => {
    expect(sanitiseSurface("")).toBe("overview");
    expect(sanitiseSurface("overview")).toBe("overview");
  });

  it("lower-cases before matching", () => {
    expect(sanitiseSurface("OUTREACH")).toBe("outreach");
  });

  it("rejects anything not on the allowlist (ids, junk, non-strings)", () => {
    expect(sanitiseSurface("patients/12345")).toBeNull();
    expect(sanitiseSurface("definitely-not-a-module")).toBeNull();
    expect(sanitiseSurface(42)).toBeNull();
    expect(sanitiseSurface(null)).toBeNull();
  });
});

describe("recordUsage", () => {
  it("writes one action event with the action name as detail", async () => {
    await recordUsage("outreach", "campaign_launch", {
      clientId: "vitality",
      userEmail: "owner@vitality.co.uk",
      role: "client_owner",
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      client_id: "vitality",
      user_email: "owner@vitality.co.uk",
      role: "client_owner",
      event: "action",
      surface: "outreach",
      detail: "campaign_launch",
    });
  });

  it("never throws when the write fails (telemetry must not break the app)", async () => {
    h.failOnce();
    await expect(
      recordUsage("patients", "note_added", { clientId: "vitality" }),
    ).resolves.toBeUndefined();
    expect(h.inserted).toHaveLength(0);
  });
});

describe("usageSummary", () => {
  it("groups page views by surface (desc) and finds the most active user", async () => {
    h.setRows([
      { id: "1", client_id: "vitality", event: "page_view", surface: "patients", user_email: "a@x.com" },
      { id: "2", client_id: "vitality", event: "page_view", surface: "patients", user_email: "a@x.com" },
      { id: "3", client_id: "vitality", event: "page_view", surface: "patients", user_email: "b@x.com" },
      { id: "4", client_id: "vitality", event: "page_view", surface: "outreach", user_email: "a@x.com" },
      // Excluded: an action event, and another client's page view.
      { id: "5", client_id: "vitality", event: "action", surface: "outreach", user_email: "a@x.com" },
      { id: "6", client_id: "other", event: "page_view", surface: "patients", user_email: "z@x.com" },
    ]);

    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });

    expect(summary.totalViews).toBe(4);
    expect(summary.surfaces).toEqual([
      { surface: "patients", views: 3 },
      { surface: "outreach", views: 1 },
    ]);
    expect(summary.mostActiveUser).toEqual({ email: "a@x.com", views: 3 });
  });

  it("returns an empty summary when there is no usage", async () => {
    h.setRows([]);
    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
    expect(summary.totalViews).toBe(0);
    expect(summary.surfaces).toEqual([]);
    expect(summary.mostActiveUser).toBeNull();
  });

  it("never throws on a read failure (returns an empty summary)", async () => {
    h.failOnce();
    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
    expect(summary.totalViews).toBe(0);
    expect(summary.surfaces).toEqual([]);
  });
});
