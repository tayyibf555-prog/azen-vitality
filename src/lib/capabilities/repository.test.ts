import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The single door to the database in this module. Everything below is about what
// happens on the way through it, and what happens when it fails.
const db = vi.hoisted(() => ({
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  rows: [] as Array<{ capability: string; granted: boolean }>,
  error: null as { message: string } | null,
  constructed: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => {
    db.constructed += 1;
    const builder = (table: string) => {
      const chain = {
        select: () => chain,
        order: () => chain,
        eq: (column: string, value: unknown) => {
          db.filters.push({ table, column, value });
          return chain;
        },
        then: undefined as unknown,
      };
      // A thenable so `await query` resolves like the real client does.
      return Object.assign(chain, {
        then: (resolve: (v: unknown) => void) => resolve({ data: db.rows, error: db.error }),
      });
    };
    return { from: (table: string) => builder(table) };
  },
  anonServerClient: () => {
    throw new Error("the capability overlay must never use the anon client");
  },
}));

import type { AuthedUser } from "@/lib/auth/session";
import { ROLE_DEFAULTS, safeDefaults } from "./defaults";
import { isDestructive } from "./keys";
import { getCapabilities } from "./repository";

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: "user-1",
    name: "Blerta",
    email: "blerta@vitalitydental.co.uk",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: ["site-cc"],
    ...overrides,
  };
}

beforeEach(() => {
  db.filters = [];
  db.rows = [];
  db.error = null;
  db.constructed = 0;
});

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("1. the query is scoped to the practice AND the person", () => {
  it("filters on client_id and app_user_id, both", () => {
    // Either one alone is a cross-tenant or cross-person read. The composite FK in
    // 0072 is the boundary; this is the control that sits on top of it.
    return getCapabilities(user()).then(() => {
      const cols = db.filters.filter((f) => f.table === "user_capability").map((f) => f.column);
      expect(cols).toContain("client_id");
      expect(cols).toContain("app_user_id");
      expect(db.filters).toContainEqual({ table: "user_capability", column: "client_id", value: "vitality" });
      expect(db.filters).toContainEqual({ table: "user_capability", column: "app_user_id", value: "user-1" });
    });
  });

  it("applies the rows it reads", async () => {
    db.rows = [{ capability: "reports.run", granted: true }];
    const held = await getCapabilities(user({ id: "user-grant" }));
    expect(held.has("reports.run")).toBe(true);
    expect(ROLE_DEFAULTS.client_coordinator.has("reports.run")).toBe(false);
  });

  it("a revoke really removes it", async () => {
    db.rows = [{ capability: "patient.note.write", granted: false }];
    const held = await getCapabilities(user({ id: "user-revoke" }));
    expect(held.has("patient.note.write")).toBe(false);
  });
});

describe("2. agency_admin short-circuits with NO query at all", () => {
  it("issues no read and returns the role defaults", async () => {
    // app_user.client_id is null for them, and a null cannot satisfy the composite
    // tenant FK in 0072 — so an override row for an agency admin cannot exist. A
    // query would be guaranteed to return nothing.
    const held = await getCapabilities(user({ id: "agency-1", role: "agency_admin", clientId: null }));
    expect(db.constructed).toBe(0);
    expect(db.filters).toEqual([]);
    expect(sorted(held)).toEqual(sorted(ROLE_DEFAULTS.agency_admin));
  });
});

describe("3. a read error FAILS CLOSED, it does not fall back to the full defaults", () => {
  it("returns the role's non-destructive defaults", async () => {
    db.error = { message: "relation \"user_capability\" does not exist" };
    const held = await getCapabilities(user({ id: "user-error" }));
    expect(sorted(held)).toEqual(sorted(safeDefaults("client_coordinator")));
  });

  it("which means every write is gone and every read survives", async () => {
    db.error = { message: "connection reset" };
    const held = await getCapabilities(user({ id: "user-error-2" }));
    for (const key of held) expect(isDestructive(key)).toBe(false);
    // Not empty — a failed overlay read must not blank the screen either.
    expect(held.size).toBeGreaterThan(0);
  });

  it("and is strictly less than the defaults, so the failure is real", async () => {
    db.error = { message: "boom" };
    const held = await getCapabilities(user({ id: "user-error-3" }));
    expect(held.size).toBeLessThan(ROLE_DEFAULTS.client_coordinator.size);
    // The specific one that matters: an unreadable overlay must never hand back a
    // permission an owner had explicitly revoked.
    expect(held.has("patient.profile.edit")).toBe(false);
  });
});

describe("4. an unknown stored key cannot grant anything", () => {
  it("ignores a row naming a capability the catalog does not have", async () => {
    db.rows = [
      { capability: "money.payment.delete", granted: true },
      { capability: "reports.run", granted: true },
    ];
    const held = await getCapabilities(user({ id: "user-junk" }));
    expect([...held]).not.toContain("money.payment.delete");
    expect(held.has("reports.run")).toBe(true);
  });

  it("and a stored LOCKED key cannot escalate", async () => {
    db.rows = [{ capability: "security.capability.manage", granted: true }];
    const held = await getCapabilities(user({ id: "user-escalate" }));
    expect(held.has("security.capability.manage")).toBe(false);
  });
});
