import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE DEFAULT-OFF TRAP, AND THIS MODULE'S ANSWER TO IT.
//
// system_toggle is DEFAULT-ON by design: a system with no row is ENABLED, which
// is what lets the kill switch ship dormant and change nothing for the modules
// that already existed. That default is exactly wrong for a new send surface, and
// it is a landmine: a module that simply forgets to declare itself is ARMED, for
// every client, in every environment, from the moment its code deploys.
//
// The post-op check-in is the second system in the platform to invert it (the
// treatment-plan closer was the first), and it inverts it in CODE as well as in a
// seeded row. This file proves both halves, exercising the REAL systems repository
// against a fake toggle table — because the seed in migration 0091 covers exactly
// one client in exactly one database and cannot speak for a second client, a fresh
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

const SLUG = "postop-checkin";

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
  __resetDisabledSlugsFailureLogForTests();
});

describe("the catalog declaration", () => {
  it("declares defaultEnabled: false", () => {
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def, "postop-checkin is missing from the catalog entirely").toBeTruthy();
    expect(def?.defaultEnabled).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(SLUG)).toBe(true);
    expect(defaultEnabledFor(SLUG)).toBe(false);
  });

  it("says, in owner-facing words, that replies are STILL triaged when it is off", () => {
    // The halts line is what an owner reads before flipping the switch. It must not
    // let them believe that switching this off stops the practice hearing about a
    // symptom: it stops the SENDING, and nothing else.
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def?.halts).toMatch(/still (be )?triag/i);
    expect(def?.halts).toMatch(/escalat/i);
  });
});

describe("no toggle row means DISABLED", () => {
  it("isSystemEnabled says no", async () => {
    h.set({ data: null, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    // The contract for everything else is untouched.
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

  it("the drain's disabled set contains it, so its outbox cannot drain", async () => {
    h.set({ data: [], error: null });
    const disabled = await getDisabledSlugsForSend("vitality");
    expect(disabled.has(SLUG)).toBe(true);
    expect(disabled.has("recall")).toBe(false);
  });

  it("the owner panel renders it as off", async () => {
    h.set({ data: [], error: null });
    const states = await getSystemStates("vitality");
    expect(states.find((s) => s.slug === SLUG)?.enabled).toBe(false);
  });
});

describe("a toggle-read failure can never arm it", () => {
  it("isSystemEnabled fails CLOSED here while still failing open for others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
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
  });
});

describe("the second, independent OFF: the migration seeds a disabled row", () => {
  const MIGRATION = readFileSync(
    join(process.cwd(), "supabase/migrations/0091_postop_checkin.sql"),
    "utf8",
  );

  it("inserts an explicitly disabled system_toggle row", () => {
    expect(MIGRATION).toMatch(/insert into system_toggle/i);
    expect(MIGRATION).toMatch(/'postop-checkin',\s*false/);
  });

  it("uses `on conflict do nothing`, so a re-run cannot stamp OFF over an owner's ON", () => {
    expect(MIGRATION).toMatch(/on conflict \(client_id, module_slug\) do nothing/i);
  });

  it("locks the tables down: RLS on, no anon/authenticated grants", () => {
    for (const t of ["postop_target", "postop_touch", "postop_outbox", "postop_escalation"]) {
      expect(MIGRATION, t).toContain(`alter table ${t} enable row level security`);
      expect(MIGRATION, t).toContain(`revoke all on ${t} from anon, authenticated`);
    }
  });
});

describe("the sweep and the release both consult the switch", () => {
  const SWEEP = readFileSync(join(process.cwd(), "src/app/api/postop/sweep/route.ts"), "utf8");
  const ACTION = readFileSync(join(process.cwd(), "src/app/api/postop/[action]/route.ts"), "utf8");

  it("the sweep checks it FIRST, before it reads anything at all", () => {
    expect(SWEEP).toContain('isSystemEnabled(CLIENT_ID, "postop-checkin")');
    const gate = SWEEP.indexOf('isSystemEnabled(CLIENT_ID, "postop-checkin")');
    const read = SWEEP.indexOf("listAppointments(");
    expect(gate).toBeGreaterThan(0);
    expect(gate, "the kill switch must be consulted before any Dentally read").toBeLessThan(read);
  });

  it("the release checks it, and the DISCARD deliberately does not", () => {
    expect(ACTION).toContain('isSystemEnabled(clientId, "postop-checkin")');
    // Discarding is the direction that STOPS a message; gating it would strand every
    // outstanding draft the moment an owner switched the system off.
    //
    // The branch condition is pinned LITERALLY, not just by position: an edit that
    // leaves the discard block where it is but makes it unreachable (`if (false &&
    // action === "discard")`) would satisfy a position check and silently push every
    // discard through the kill switch and the capability guard.
    expect(ACTION, "the discard branch must be unconditional on the switch").toContain(
      '\n  if (action === "discard") {',
    );
    const discardReturn = ACTION.indexOf("const discarded = await discardDraft(");
    const killSwitch = ACTION.indexOf('isSystemEnabled(clientId, "postop-checkin")');
    expect(discardReturn).toBeGreaterThan(0);
    expect(discardReturn, "discard must return BEFORE the kill switch is consulted").toBeLessThan(
      killSwitch,
    );
  });
});
