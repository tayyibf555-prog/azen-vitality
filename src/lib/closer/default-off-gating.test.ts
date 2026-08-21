import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// THE SAFE-GATING ANSWER, PINNED.
//
// system_toggle is DEFAULT-ON by design: a system with no row is enabled, which
// is what lets the kill switch ship dormant and change nothing. That default is
// exactly wrong for a brand new outbound surface. "Nobody has ever opened the
// control panel" and "the toggle table was briefly unreadable" must not be the
// reasons a patient receives the first message from a system nobody switched on.
//
// So the closer inverts it, in CODE rather than only in a seeded row, and this
// file is the proof. It exercises the REAL systems repository against a fake
// toggle table, because the seeded row in migration 0085 covers exactly one
// client in exactly one database, and cannot speak for a second client, a fresh
// environment, or a deployment where the migration has not run.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

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
  isSystemEnabledForSend,
  isSystemEnabledStrict,
  getDisabledSlugs,
  getDisabledSlugsForSend,
  getSystemStates,
  __resetDisabledSlugsFailureLogForTests,
} from "@/lib/systems/repository";
import { DEFAULT_OFF_SLUGS, SYSTEMS, defaultEnabledFor } from "@/lib/systems/catalog";

const SLUG = "treatment-closer";

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
  __resetDisabledSlugsFailureLogForTests();
});

describe("the closer is the platform's one default-OFF system", () => {
  it("is declared default-off in the catalog", () => {
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def, "treatment-closer is missing from the catalog entirely").toBeTruthy();
    expect(def?.defaultEnabled).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(SLUG)).toBe(true);
    expect(defaultEnabledFor(SLUG)).toBe(false);
  });

  it("is the ONLY default-off system, so this inversion has not spread by accident", () => {
    // Every other module's absent-row contract is unchanged. If a future system
    // wants this treatment it should be a deliberate edit that lands here.
    expect([...DEFAULT_OFF_SLUGS]).toEqual([SLUG]);
  });

  it("leaves every OTHER system default-ON, byte for byte", () => {
    for (const s of SYSTEMS) {
      if (s.slug === SLUG) continue;
      expect(defaultEnabledFor(s.slug), s.slug).toBe(true);
    }
  });
});

describe("no toggle row means DISABLED for the closer", () => {
  it("isSystemEnabled says no", async () => {
    h.set({ data: null, error: null }); // no row at all
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    // and the contract for everything else is untouched.
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
  });

  it("says no for a client the seeding migration never covered", async () => {
    // This is the hole a seeded row alone cannot close: the seed is scoped to
    // client_id = 'vitality'.
    h.set({ data: null, error: null });
    await expect(isSystemEnabled("some-other-practice", SLUG)).resolves.toBe(false);
  });

  it("isSystemEnabledForSend says no, in dry-run and live alike", async () => {
    h.set({ data: null, error: null });
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
  });

  it("isSystemEnabledStrict says no", async () => {
    h.set({ data: null, error: null });
    await expect(isSystemEnabledStrict("vitality", SLUG)).resolves.toBe(false);
  });

  it("the drain's disabled set contains it", async () => {
    h.set({ data: [], error: null }); // no rows for this client
    const disabled = await getDisabledSlugsForSend("vitality");
    expect(disabled.has(SLUG)).toBe(true);
    expect(disabled.has("recall")).toBe(false);
  });

  it("the display disabled set contains it too, so the panel agrees with the drain", async () => {
    h.set({ data: [], error: null });
    const disabled = await getDisabledSlugs("vitality");
    expect(disabled.has(SLUG)).toBe(true);
  });

  it("the owner panel renders it as off", async () => {
    h.set({ data: [], error: null });
    const states = await getSystemStates("vitality");
    expect(states.find((s) => s.slug === SLUG)?.enabled).toBe(false);
    expect(states.find((s) => s.slug === "recall")?.enabled).toBe(true);
  });
});

describe("an owner can still switch it on, and the switch is respected", () => {
  it("an explicit enabled row turns it on", async () => {
    h.set({ data: { enabled: true }, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(true);
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(true);
  });

  it("an explicit enabled row removes it from the disabled sets", async () => {
    h.set({ data: [{ module_slug: SLUG, enabled: true }], error: null });
    expect((await getDisabledSlugsForSend("vitality")).has(SLUG)).toBe(false);
    expect((await getDisabledSlugs("vitality")).has(SLUG)).toBe(false);
    expect((await getSystemStates("vitality")).find((s) => s.slug === SLUG)?.enabled).toBe(true);
  });

  it("an explicit disabled row keeps it off", async () => {
    h.set({ data: { enabled: false }, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
  });
});

describe("a toggle-read failure can never arm it", () => {
  it("isSystemEnabled fails CLOSED for the closer while still failing open for others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    // The platform-wide fail-open contract is intact for every other system: a
    // toggle blip must not blank the nav.
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
    spy.mockRestore();
  });

  it("isSystemEnabledForSend fails CLOSED for the closer even under dry-run", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "down" } });
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
    spy.mockRestore();
  });

  it("both disabled sets keep it disabled on an error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "down" } });
    expect((await getDisabledSlugsForSend("vitality")).has(SLUG)).toBe(true);
    __resetDisabledSlugsFailureLogForTests();
    expect((await getDisabledSlugs("vitality")).has(SLUG)).toBe(true);
    spy.mockRestore();
  });
});
