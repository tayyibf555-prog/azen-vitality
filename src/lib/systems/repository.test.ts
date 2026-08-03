import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// A chainable Supabase builder mock: every step returns the same thenable object,
// so `await sb.from().select().eq().eq()` resolves to the configured result, and
// `.maybeSingle()` / `.upsert()` resolve to it too. h.set(...) swaps the result
// per test.
const h = vi.hoisted(() => {
  let result: { data: unknown; error: unknown } = { data: null, error: null };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.upsert = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    set: (r: { data: unknown; error: unknown }) => {
      result = r;
    },
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import {
  isSystemEnabled,
  getDisabledSlugs,
  getSystemStates,
  setSystemEnabled,
  __resetDisabledSlugsFailureLogForTests,
} from "./repository";
import { SYSTEMS } from "./catalog";

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
  __resetDisabledSlugsFailureLogForTests();
});

describe("isSystemEnabled (default ON, fail OPEN)", () => {
  it("returns true when no row exists (absence = enabled)", async () => {
    h.set({ data: null, error: null });
    expect(await isSystemEnabled("vitality", "recall")).toBe(true);
  });

  it("returns false only when a row explicitly disables it", async () => {
    h.set({ data: { enabled: false }, error: null });
    expect(await isSystemEnabled("vitality", "recall")).toBe(false);
  });

  it("returns true for a row that is explicitly enabled", async () => {
    h.set({ data: { enabled: true }, error: null });
    expect(await isSystemEnabled("vitality", "recall")).toBe(true);
  });

  it("fails OPEN: a read error resolves to enabled, never throws", async () => {
    h.set({ data: null, error: { message: "table missing" } });
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
  });
});

describe("getDisabledSlugs", () => {
  it("returns the set of disabled slugs", async () => {
    h.set({ data: [{ module_slug: "recall" }, { module_slug: "reviews" }], error: null });
    const disabled = await getDisabledSlugs("vitality");
    expect(disabled.has("recall")).toBe(true);
    expect(disabled.has("reviews")).toBe(true);
    expect(disabled.has("reactivation")).toBe(false);
  });

  it("fails OPEN: on error returns an empty set (nothing disabled)", async () => {
    h.set({ data: null, error: { message: "down" } });
    const disabled = await getDisabledSlugs("vitality");
    expect(disabled.size).toBe(0);
  });
});

describe("getDisabledSlugs failure log dedupe (the 120-issues bug)", () => {
  it("logs the first occurrence of a failure loudly", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await getDisabledSlugs("vitality");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not re-log an immediate repeat of the SAME failure for the SAME client", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await getDisabledSlugs("vitality");
    await getDisabledSlugs("vitality");
    await getDisabledSlugs("vitality");
    // Naive mutation to try: dedupe on clientId alone (drop the reason from the
    // key). That mutation would ALSO pass this assertion (still just 1 log),
    // which is exactly why the next test exists to catch it.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("still logs a DIFFERENT failure reason for the same client (proves the key isn't clientId-only)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await getDisabledSlugs("vitality");
    h.set({ data: null, error: { message: "permission denied" } });
    await getDisabledSlugs("vitality");
    // A clientId-only dedupe (the tempting-but-wrong mutation) would swallow
    // this second, materially different failure and leave spy at 1 call.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("still logs the same reason for a DIFFERENT client", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await getDisabledSlugs("vitality");
    await getDisabledSlugs("other-client");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("the fail-open return value (empty set) is unchanged whether logged or suppressed", async () => {
    h.set({ data: null, error: { message: "table missing" } });
    const first = await getDisabledSlugs("vitality");
    const second = await getDisabledSlugs("vitality");
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
  });
});

describe("getSystemStates", () => {
  it("returns the full catalog, defaulting missing rows to enabled", async () => {
    h.set({
      data: [{ module_slug: "recall", enabled: false, updated_at: "2026-07-04T00:00:00Z", updated_by: "owner@x" }],
      error: null,
    });
    const states = await getSystemStates("vitality");
    expect(states.length).toBe(SYSTEMS.length);
    const recall = states.find((s) => s.slug === "recall");
    expect(recall?.enabled).toBe(false);
    expect(recall?.updatedBy).toBe("owner@x");
    // A system with no row is enabled.
    const reactivation = states.find((s) => s.slug === "reactivation");
    expect(reactivation?.enabled).toBe(true);
    expect(reactivation?.updatedAt).toBeNull();
  });

  it("propagates a read error (panel shows a failure, not a false all-on grid)", async () => {
    h.set({ data: null, error: { message: "boom" } });
    await expect(getSystemStates("vitality")).rejects.toBeTruthy();
  });
});

describe("setSystemEnabled", () => {
  it("resolves on a successful upsert", async () => {
    h.set({ data: null, error: null });
    await expect(setSystemEnabled("vitality", "recall", false, "owner@x")).resolves.toBeUndefined();
  });

  it("propagates a write error", async () => {
    h.set({ data: null, error: { message: "denied" } });
    await expect(setSystemEnabled("vitality", "recall", false, "owner@x")).rejects.toBeTruthy();
  });
});
