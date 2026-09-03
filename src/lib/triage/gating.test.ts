import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_OFF_SLUGS,
  DRAIN_SOURCE_TO_SLUG,
  SYSTEM_BY_SLUG,
  defaultEnabledFor,
} from "@/lib/systems/catalog";
import { CORRESPONDENCE_SOURCE_NAMES } from "@/lib/inbox/repository";
import { SOURCE_LABEL } from "@/lib/inbox/delivery";
import { TRIAGE_DRAIN_SOURCE, TRIAGE_SYSTEM_SLUG } from "./types";

// ===========================================================================
// NOTHING SENDS WHILE THIS SYSTEM IS OFF, and OFF is the shipped state.
//
// The platform's kill switch is DEFAULT-ON by the absence of a row, which is what
// makes it dormant until an owner uses it. A brand new send surface has to invert
// that, and it has to do so TWICE and independently:
//
//   1. CODE   `defaultEnabled: false` in the catalog, so an absent row means
//             disabled for EVERY client in EVERY environment, including one
//             where migration 0097 has not run.
//   2. DATA   the seeded disabled row in 0097, for the client and database it
//             was applied to.
//
// Neither is sufficient alone: a seed covers only the databases it ran against,
// and the code default cannot be seen by an operator reading system_toggle. Both
// are asserted here.
// ===========================================================================

const REPO = process.cwd();

function migrationSource(): string {
  return readFileSync(join(REPO, "supabase/migrations/0097_previsit_triage.sql"), "utf8");
}

function sourceOf(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

describe("the system ships OFF, twice and independently", () => {
  it("MECHANISM 1: the catalog declares it default-off", () => {
    const def = SYSTEM_BY_SLUG.get(TRIAGE_SYSTEM_SLUG);
    expect(def, `${TRIAGE_SYSTEM_SLUG} is not in the systems catalog`).toBeDefined();
    expect(def?.defaultEnabled).toBe(false);
  });

  it("MECHANISM 1, at the point of use: an absent toggle row resolves to DISABLED", () => {
    // The catalog flag only matters because defaultEnabledFor consults it, and
    // every read path in systems/repository.ts consults defaultEnabledFor.
    expect(defaultEnabledFor(TRIAGE_SYSTEM_SLUG)).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(TRIAGE_SYSTEM_SLUG)).toBe(true);
  });

  it("MECHANISM 2: migration 0097 seeds an explicit disabled row", () => {
    const sql = migrationSource();
    expect(sql).toMatch(/insert into system_toggle/i);
    expect(sql).toContain(`'${TRIAGE_SYSTEM_SLUG}', false`);
    // `on conflict do nothing` is essential: re-running the migration must never
    // stamp OFF over an owner's later deliberate ON.
    expect(sql).toMatch(/on conflict \(client_id, module_slug\) do nothing/i);
  });
});

describe("the kill switch reaches every surface this module has", () => {
  it("the SWEEP checks it before reading anything", () => {
    const src = sourceOf("src/app/api/previsit/sweep/route.ts");
    expect(src).toContain("isSystemEnabled(");
    expect(src).toContain("TRIAGE_SYSTEM_SLUG");
    // Before the Dentally key is even read, so an off system costs nothing.
    expect(src.indexOf("isSystemEnabled(")).toBeLessThan(src.indexOf("dentallyReadKey()"));
  });

  it("the MINING sweep checks it too, so an off system's list does not grow overnight", () => {
    const src = sourceOf("src/app/api/previsit/mining-sweep/route.ts");
    expect(src).toContain("isSystemEnabled(");
    expect(src).toContain("TRIAGE_SYSTEM_SLUG");
  });

  // STRICT on both public surfaces, i.e. fail CLOSED. An unreadable toggle must
  // not leave a form collecting answers after the owner has switched it off.
  it("the PUBLIC PAGE checks it STRICTLY", () => {
    const src = sourceOf("src/app/pv/[token]/page.tsx");
    expect(src).toContain("isSystemEnabledStrict(");
    expect(src).not.toContain("isSystemEnabled(");
  });

  it("the PUBLIC SUBMIT checks it STRICTLY", () => {
    const src = sourceOf("src/app/api/previsit/submit/route.ts");
    expect(src).toContain("isSystemEnabledStrict(");
    expect(src).not.toContain("isSystemEnabled(");
  });

  it("the sweep's off-branch returns BEFORE anything is queued", () => {
    const src = sourceOf("src/app/api/previsit/sweep/route.ts");
    const gate = src.indexOf('skipped: "system off"');
    const enqueue = src.indexOf("await enqueueSend(");
    expect(gate).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(0);
    expect(gate, "the kill switch must be checked before anything is queued").toBeLessThan(enqueue);
  });
});

describe("the module joins the shared drain, and is therefore killable", () => {
  // AN UNMAPPED DRAIN SOURCE IS AN UNKILLABLE ONE: the drain skips a system only
  // when it can turn the source name into a slug. catalog.test.ts already proves
  // the two lists agree in both directions; this names THIS module's entry so a
  // deletion is a named failure rather than an arithmetic one.
  it("the drain source maps to this system's slug", () => {
    expect(DRAIN_SOURCE_TO_SLUG[TRIAGE_DRAIN_SOURCE]).toBe(TRIAGE_SYSTEM_SLUG);
  });

  it("the drain really iterates it (the SOURCES array, read from the drain's own file)", () => {
    const src = sourceOf("src/app/api/messaging/drain/route.ts");
    const block = src.slice(src.indexOf("const SOURCES: OutboxSource[] = ["));
    const names = [...block.slice(0, block.indexOf("\n];")).matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(names).toContain(TRIAGE_DRAIN_SOURCE);
  });

  it("it drains AFTER the two appointment-critical confirmations and BEFORE outreach", () => {
    // The order is the cross-module priority for the once-per-day cap, so it is a
    // decision rather than an accident. A diary move and a no-show confirmation
    // are about turning up at the right hour and must not lose their slot; every
    // discretionary message must yield to this one.
    const src = sourceOf("src/app/api/messaging/drain/route.ts");
    const block = src.slice(src.indexOf("const SOURCES: OutboxSource[] = ["));
    const names = [...block.slice(0, block.indexOf("\n];")).matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    const at = (n: string) => names.indexOf(n);
    expect(at(TRIAGE_DRAIN_SOURCE)).toBeGreaterThan(at("diary"));
    expect(at(TRIAGE_DRAIN_SOURCE)).toBeGreaterThan(at("noshow"));
    for (const later of ["recall", "reactivation", "coordinator", "reviews", "outreach", "collection"]) {
      expect(at(TRIAGE_DRAIN_SOURCE), `previsit must drain before ${later}`).toBeLessThan(at(later));
    }
  });

  it("it is TRANSACTIONAL, so a recall text cannot swallow tomorrow's form", () => {
    // The sweep does not re-draft: the appointment does not come round again. If
    // the once-per-day cap could block this message the patient would simply never
    // get the form, silently.
    const src = sourceOf("src/app/api/messaging/drain/route.ts");
    const line = src.split("\n").find((l) => l.includes(`name: "${TRIAGE_DRAIN_SOURCE}"`));
    expect(line).toBeDefined();
    expect(line).toContain("transactional: true");
  });
});

describe("the module joins the correspondence record", () => {
  // The record claims to hold every message this platform has sent to a patient.
  // delivery.test.ts proves every DRAIN source is registered; this names ours.
  it("its touches are read onto the patient record", () => {
    expect(CORRESPONDENCE_SOURCE_NAMES).toContain(TRIAGE_DRAIN_SOURCE);
  });

  it("it has human words rather than a raw slug", () => {
    expect(SOURCE_LABEL[TRIAGE_DRAIN_SOURCE]).toBe("Pre-visit questions");
  });

  it("the Twilio delivery-status webhook updates this module's outbox too", () => {
    const src = sourceOf("src/app/api/webhooks/twilio/status/route.ts");
    expect(src).toContain("@/lib/triage/repository");
    expect(src).toContain("updatePrevisitStatus(sid, mapped)");
  });
});

describe("the migration's posture", () => {
  const sql = migrationSource();

  it("every table is RLS-on with no anon or authenticated grant", () => {
    const tables = [
      "previsit_bank",
      "previsit_target",
      "previsit_touch",
      "previsit_outbox",
      "previsit_response",
      "treatment_interest",
      "previsit_mining_scan",
      "previsit_mining_candidate",
    ];
    for (const t of tables) {
      expect(sql, `${t} is not created`).toContain(`create table if not exists ${t}`);
      expect(sql, `${t} has no RLS`).toContain(`alter table ${t} enable row level security`);
      expect(sql, `${t} keeps a public grant`).toContain(`revoke all on ${t} from anon, authenticated`);
    }
  });

  it("the outbox CHECK has no 'draft' value, so a draft could not be queued even by hand", () => {
    const outbox = sql.slice(sql.indexOf("create table if not exists previsit_outbox"));
    const check = outbox.slice(0, outbox.indexOf(");"));
    expect(check).toContain("check (status in ('queued', 'sending', 'sent', 'delivered', 'failed'))");
    expect(check).not.toContain("'draft'");
  });

  it("the link token is UNIQUE, which is the whole authorisation model for the public page", () => {
    expect(sql).toMatch(/create unique index if not exists idx_previsit_target_token on previsit_target \(link_token\)/i);
  });

  it("the fork column can only ever hold the two non-funding values", () => {
    // A funding word cannot leak from a column that cannot hold one.
    const forkChecks = sql.match(/check \(fork in \('full', 'brief'\)\)/g) ?? [];
    expect(forkChecks.length).toBeGreaterThanOrEqual(3); // bank, target, response
  });

  it("the mining candidate table refuses an under-age row at the database", () => {
    expect(sql).toContain("age integer not null check (age >= 18)");
  });
});
