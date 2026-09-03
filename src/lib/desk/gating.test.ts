import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_OFF_SLUGS,
  DRAIN_SOURCE_TO_SLUG,
  SYSTEM_BY_SLUG,
  defaultEnabledFor,
} from "@/lib/systems/catalog";
import { CLIENT_NAV, NAV_SWITCH_EXEMPT_SLUGS, canRoleAccessModule } from "@/lib/nav";
import { srcPath } from "@/lib/test-support/walk-src";
import { EQUIPMENT_SLUG } from "@/lib/equipment/types";
import { IT_DESK_SLUG } from "@/lib/itdesk/types";

// ===========================================================================
// THE TWO DESK MODULES SHIP OFF, TWICE OVER, AND SEND NOTHING.
//
// THE TRAP THIS FILE EXISTS FOR: an ABSENT system_toggle row means ENABLED. That
// is the platform's default-ON contract, and it is what makes the kill switch
// dormant until an owner uses it — so a new module that merely seeds a disabled
// row in its migration is ON for every client the seed did not cover and in
// every database the migration has not reached. `defaultEnabled: false` in the
// catalog is the half that covers those; the seed is the half that covers the
// pilot client explicitly. Both, or neither counts.
//
// AND THE OPPOSITE HALF, which is just as easy to get wrong: switching them off
// must NOT hide the pages. The register, the manuals and the IT contact are what
// has to exist BEFORE the agent is switched on, so hiding them would leave an
// owner with a system they cannot prepare and therefore cannot sensibly turn on.
// ===========================================================================

const SLUGS = [EQUIPMENT_SLUG, IT_DESK_SLUG];

const MIGRATIONS: Record<string, string> = {
  [EQUIPMENT_SLUG]: "supabase/migrations/0098_equipment_register.sql",
  [IT_DESK_SLUG]: "supabase/migrations/0099_it_desk.sql",
};

function migrationSource(slug: string): string {
  // Rooted through the module's own URL, not process.cwd(), so a run from a
  // worktree reads THIS tree's migrations (the walk-src precedent).
  return readFileSync(srcPath(`../${MIGRATIONS[slug]}`), "utf8");
}

describe("1. both desks are default-OFF in the CODE", () => {
  it.each(SLUGS)("%s declares defaultEnabled:false in the catalog", (slug) => {
    expect(SYSTEM_BY_SLUG.get(slug)?.defaultEnabled).toBe(false);
  });

  it.each(SLUGS)("%s is in DEFAULT_OFF_SLUGS, so an ABSENT row reads DISABLED", (slug) => {
    // This is the half that covers a client the seed never reached and a database
    // the migration has not run against.
    expect(DEFAULT_OFF_SLUGS.has(slug)).toBe(true);
    expect(defaultEnabledFor(slug)).toBe(false);
  });
});

describe("2. both desks are default-OFF in the DATA as well", () => {
  it.each(SLUGS)("%s's migration seeds an explicit disabled row for the pilot client", (slug) => {
    const sql = migrationSource(slug);
    expect(sql).toMatch(new RegExp(`insert into system_toggle[\\s\\S]*'${slug}', false`));
  });

  it.each(SLUGS)("%s's seed cannot stamp OFF over an owner's later deliberate ON", (slug) => {
    // Re-running a migration is normal. Without this clause it would silently
    // switch a live system back off.
    expect(migrationSource(slug)).toContain("on conflict (client_id, module_slug) do nothing");
  });

  it.each(SLUGS)("%s's tables are RLS-locked with no anon/authenticated grant", (slug) => {
    const sql = migrationSource(slug);
    const tables = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(sql, `${table} RLS`).toContain(`alter table ${table} enable row level security`);
      expect(sql, `${table} grants`).toContain(`revoke all on ${table} from anon, authenticated`);
    }
  });
});

describe("3. switching a desk off halts the CHAT, not the page", () => {
  it.each(SLUGS)("%s stays in the nav when its switch is off", (slug) => {
    expect(NAV_SWITCH_EXEMPT_SLUGS.has(slug)).toBe(true);
  });

  it.each(SLUGS)("%s's own route refuses the chat when the switch is off", (slug) => {
    // The page-level exemption above is only safe because the ROUTE refuses.
    // Asserted as source, because the behaviour is proven by the route tests and
    // what is proven here is that the two halves belong to each other.
    const route =
      slug === EQUIPMENT_SLUG
        ? readFileSync(srcPath("app/api/equipment/[action]/route.ts"), "utf8")
        : readFileSync(srcPath("app/api/itdesk/[action]/route.ts"), "utf8");
    expect(route).toContain("isSystemEnabled");
    expect(route).toMatch(/reason: "system_off"/);
  });

  it.each(SLUGS)("%s's halts copy tells the owner what stays reachable", (slug) => {
    // Owner-facing copy in the control panel. If it said "the module is hidden"
    // it would be describing a different product from the one that ships.
    const halts = SYSTEM_BY_SLUG.get(slug)?.halts ?? "";
    expect(halts).toMatch(/stays? readable|stay readable|stay reachable|editable/i);
  });
});

describe("4. neither desk is a sending surface", () => {
  it.each(SLUGS)("%s registers no source with the shared messaging drain", (slug) => {
    // There is no touch table and no outbox in either module, so there is nothing
    // for the drain to deliver. An entry here would mean somebody had added one.
    expect(Object.values(DRAIN_SOURCE_TO_SLUG)).not.toContain(slug);
  });

  it.each(SLUGS)("%s's migration creates no outbox or touch table", (slug) => {
    const sql = migrationSource(slug);
    const tables = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
    expect(tables.filter((t) => /_outbox$|_touch$/.test(t))).toEqual([]);
  });
});

describe("5. the role lock: owner and practice manager, nobody else", () => {
  it.each(SLUGS)("%s admits the owner, the agency and the practice manager", (slug) => {
    for (const role of ["agency_admin", "client_owner", "client_coordinator"] as const) {
      expect(canRoleAccessModule(role, slug), `${role} -> ${slug}`).toBe(true);
    }
  });

  it.each(SLUGS)("%s refuses the clinician and the staff role", (slug) => {
    for (const role of ["client_clinician", "client_staff"] as const) {
      expect(canRoleAccessModule(role, slug), `${role} -> ${slug}`).toBe(false);
    }
  });

  it.each(SLUGS)("%s has a CLIENT_NAV entry whose roles array says the same thing", (slug) => {
    // The predicate above reads the nav, so this asserts the nav entry itself is
    // the shape the predicate is reading rather than the two agreeing by accident.
    const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);
    expect(item, slug).toBeDefined();
    expect(item?.roles?.sort()).toEqual(["agency_admin", "client_coordinator", "client_owner"]);
  });
});
