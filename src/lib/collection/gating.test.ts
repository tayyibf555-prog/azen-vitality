import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE TWO SAFETY PROPERTIES OF A MONEY AGENT, PINNED.
//
//   1. IT CANNOT BE ARMED BY ACCIDENT. system_toggle is default-ON by design (a
//      system with no row is enabled, which is what lets the kill switch ship
//      dormant), and that default is exactly wrong for a surface that tells
//      patients they owe money. "Nobody has ever opened the control panel" and
//      "the toggle table was briefly unreadable" must not be why somebody gets
//      the first one.
//
//   2. A DRAFT CANNOT BE SENT. Not by convention, not by a comment: by three
//      independent structural facts, each of which alone would stop it, and each
//      of which is asserted below against the actual FILES rather than against a
//      description of them.
// ===========================================================================

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
import { DEFAULT_OFF_SLUGS, DRAIN_SOURCE_TO_SLUG, SYSTEMS, defaultEnabledFor } from "@/lib/systems/catalog";

const SLUG = "balance-reminders";
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * A file's CODE, with its prose removed.
 *
 * These files explain themselves at length, and several of the explanations name
 * exactly the thing they exist to forbid ("it does not write collection_outbox",
 * "this module has no auto-send mode"). An assertion that reads the raw file
 * therefore fails on the documentation of the rule rather than on a breach of it,
 * and the obvious fix - deleting the sentence - makes the codebase worse. Block
 * comments and whole-line // comments are stripped; a trailing comment on a line
 * of code is left alone, because stripping those safely means parsing strings.
 */
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
  __resetDisabledSlugsFailureLogForTests();
});

// ---------------------------------------------------------------------------
describe("the balance-reminders system is DEFAULT-OFF in code, not only in a seeded row", () => {
  it("is declared default-off in the catalog", () => {
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def, "balance-reminders is missing from the catalog entirely").toBeTruthy();
    expect(def?.defaultEnabled).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(SLUG)).toBe(true);
    expect(defaultEnabledFor(SLUG)).toBe(false);
  });

  it("no toggle row means DISABLED, for vitality and for a client the migration never covered", async () => {
    // This is the hole a seeded row alone cannot close: the seed is scoped to one
    // client_id in one database.
    h.set({ data: null, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabled("some-other-practice", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabledStrict("vitality", SLUG)).resolves.toBe(false);
    // ...and the platform-wide default-ON contract is untouched for everything else.
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
  });

  it("the drain's disabled set and the owner panel both agree it is off", async () => {
    h.set({ data: [], error: null });
    expect((await getDisabledSlugsForSend("vitality")).has(SLUG)).toBe(true);
    expect((await getDisabledSlugs("vitality")).has(SLUG)).toBe(true);
    expect((await getSystemStates("vitality")).find((s) => s.slug === SLUG)?.enabled).toBe(false);
  });

  it("a toggle-read FAILURE can never arm it, while still failing open for everything else", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabled("vitality", "recall")).resolves.toBe(true);
    spy.mockRestore();
  });

  it("an owner can still switch it on, and the switch is respected", async () => {
    h.set({ data: { enabled: true }, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(true);
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(true);
    h.set({ data: { enabled: false }, error: null });
    await expect(isSystemEnabled("vitality", SLUG)).resolves.toBe(false);
  });

  it("migration 0090 ALSO ships an explicit disabled row (the second, independent gate)", () => {
    const sql = read("supabase/migrations/0090_collection_agent.sql");
    expect(sql).toMatch(/insert into system_toggle[\s\S]*'balance-reminders', false/);
    // `on conflict do nothing` is essential: a re-run must never stamp OFF over an
    // owner's later deliberate ON.
    expect(sql).toMatch(/on conflict \(client_id, module_slug\) do nothing/);
  });
});

// ---------------------------------------------------------------------------
describe("the kill switch actually reaches the outbox", () => {
  it("the drain source is mapped to the slug: an unmapped source is an UNKILLABLE one", () => {
    // The drain skips a system only when it can turn a source name into a slug.
    expect(DRAIN_SOURCE_TO_SLUG.collection).toBe(SLUG);
  });

  it("the source is registered in the drain's SOURCES array", () => {
    const drain = read("src/app/api/messaging/drain/route.ts");
    expect(drain).toContain('name: "collection"');
    expect(drain).toContain('from "@/lib/collection/repository"');
  });

  it("it drains AFTER every automatic lifecycle message and BEFORE segment outreach", () => {
    // A patient who can receive one message today should not receive the asking one
    // instead of an offer of care; a discretionary campaign still yields to a fact.
    const drain = read("src/app/api/messaging/drain/route.ts");
    const block = drain.slice(drain.indexOf("const SOURCES: OutboxSource[] = ["));
    const order = [...block.slice(0, block.indexOf("\n];")).matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(order.indexOf("collection")).toBeGreaterThan(order.indexOf("recall"));
    expect(order.indexOf("collection")).toBeGreaterThan(order.indexOf("reactivation"));
    expect(order.indexOf("collection")).toBeGreaterThan(order.indexOf("coordinator"));
    expect(order.indexOf("collection")).toBeGreaterThan(order.indexOf("reviews"));
    expect(order.indexOf("collection")).toBeLessThan(order.indexOf("outreach"));
  });

  it("it is NOT transactional: a reminder about money never bypasses the daily frequency cap", () => {
    const drain = read("src/app/api/messaging/drain/route.ts");
    const line = drain.split("\n").find((l) => l.includes('name: "collection"')) ?? "";
    expect(line).not.toContain("transactional");
  });

  it("both Twilio webhooks know about this outbox", () => {
    // Without the status webhook the row never reaches 'delivered'; without the
    // inbound one a patient's reply never stops the conversation.
    expect(read("src/app/api/webhooks/twilio/status/route.ts")).toContain("@/lib/collection/repository");
    expect(read("src/app/api/webhooks/twilio/inbound/route.ts")).toContain("@/lib/collection/repository");
  });
});

// ---------------------------------------------------------------------------
describe("A DRAFT CANNOT BE SENT: three independent structural reasons", () => {
  it("1. the outbox check constraint has no 'draft' value, so a draft cannot even be represented there", () => {
    const sql = read("supabase/migrations/0090_collection_agent.sql");
    const outbox = sql.slice(sql.indexOf("create table if not exists collection_outbox"));
    const check = outbox.slice(0, outbox.indexOf(");"));
    expect(check).toContain("check (status in ('queued', 'sending', 'sent', 'delivered', 'failed'))");
    expect(check).not.toContain("draft");
  });

  it("2. the insert path writes the touch table ONLY, and one function writes the outbox", () => {
    const repo = read("src/lib/collection/repository.ts");
    const insert = repo.slice(repo.indexOf("export async function insertDraft"));
    const insertBody = insert.slice(0, insert.indexOf("\n}\n"));
    expect(insertBody).toContain('from("collection_touch")');
    expect(insertBody).not.toContain("collection_outbox");

    // Exactly ONE function inserts into collection_outbox, and it is approveDraft.
    const inserts = [...repo.matchAll(/from\("collection_outbox"\)\s*\n\s*\.insert/g)];
    expect(inserts).toHaveLength(1);
    const approve = repo.slice(repo.indexOf("export async function approveDraft"));
    expect(approve.indexOf('.from("collection_outbox")')).toBeGreaterThan(-1);
    // ...and it does so only after a CONDITIONAL transition out of 'draft', so a
    // double click cannot produce two outbox rows for one message.
    expect(approve).toMatch(/\.eq\("status", "draft"\)/);
  });

  it("a BLOCKED send is counted separately from a FAILED one", () => {
    // The drain calls markBlocked for four different things, and one of them is the
    // cross-module once-per-day frequency cap doing exactly its job. Counting that
    // as a delivery failure retires a perfectly reachable patient as
    // "undeliverable", which is a false statement in the record about a real person.
    const repo = read("src/lib/collection/repository.ts");
    const failed = repo.slice(repo.indexOf("export async function markOutboxFailed"));
    expect(failed.slice(0, failed.indexOf("\n}\n"))).toContain('"consecutive_failures"');
    const blocked = repo.slice(repo.indexOf("export async function markOutboxBlocked"));
    expect(blocked.slice(0, blocked.indexOf("\n}\n"))).toContain('"consecutive_blocks"');
  });

  it("3. the drain lists only 'queued' rows, so an unapproved draft is invisible to it", () => {
    const repo = read("src/lib/collection/repository.ts");
    const list = repo.slice(repo.indexOf("export async function listQueuedOutbox"));
    expect(list.slice(0, list.indexOf("\n}\n"))).toContain('.eq("status", "queued")');
  });
});

// ---------------------------------------------------------------------------
describe("THERE IS NO AUTO-SEND, and no path that could become one", () => {
  const sweep = read("src/app/api/collection/sweep/route.ts");

  it("the sweep never touches the outbox, in any form", () => {
    const code = codeOf("src/app/api/collection/sweep/route.ts");
    expect(code).not.toContain("collection_outbox");
    expect(code).not.toMatch(/approveDraft|listQueuedOutbox|claimOutbox|recordOutboxSent/);
    expect(code).not.toContain("@/lib/messaging/send");
  });

  it("the sweep always reports queued: 0, so a send path could not hide in it", () => {
    expect(sweep).toContain("queued: 0");
    expect(sweep).not.toMatch(/queued:\s*(?!0)\w/);
  });

  it("no configuration anywhere in the module could enable an auto-send", () => {
    // The treatment-plan closer ships approval-first intending to earn auto-send
    // later. This module has no such plan and no such switch: money plus patients
    // is the one combination where a wrong message is a false statement about
    // somebody's finances rather than a tone problem.
    const files = [
      "src/lib/collection/types.ts",
      "src/lib/collection/cadence.ts",
      "src/lib/collection/draft.ts",
      "src/lib/collection/repository.ts",
      "src/app/api/collection/sweep/route.ts",
      "src/app/api/collection/[action]/route.ts",
    ];
    for (const f of files) {
      expect(codeOf(f), f).not.toMatch(/auto[_ -]?send/i);
    }
  });

  it("the only route to the outbox is a human approving, and it is gated on the kill switch and a capability", () => {
    const action = read("src/app/api/collection/[action]/route.ts");
    expect(action).toContain('requireModuleApiAccess(auth, "payments")');
    expect(action).toContain('requireCapability(auth, "messaging.lifecycle.send")');
    expect(action).toContain('isSystemEnabled(clientId, "balance-reminders")');
    // Discard is deliberately NOT gated on either: stopping a message must keep
    // working when the system is switched off, and the person trusted to prepare
    // the work must be able to reject it even if they cannot release it.
    const discardBranch = action.slice(action.indexOf('if (action === "discard")'));
    expect(discardBranch.indexOf("return handleDiscard")).toBeLessThan(
      discardBranch.indexOf("isSystemEnabled"),
    );
  });

  it("approve RE-VERIFIES the balance live before it releases anything", () => {
    // A draft can sit with a human for days, and in those days the patient can walk
    // into reception and pay.
    const action = read("src/app/api/collection/[action]/route.ts");
    expect(action).toContain("readPatientInvoices");
    expect(action).toContain("verifyBalance");
    expect(action).toContain("discardSettledDraft");
  });
});

// ---------------------------------------------------------------------------
describe("the sweep's own guardrails", () => {
  const sweep = read("src/app/api/collection/sweep/route.ts");

  it("is cron-gated, lease-guarded and classified BACKGROUND", () => {
    expect(sweep).toContain("cronUnauthorized");
    expect(sweep).toContain('acquireCronLock("sweep-collection"');
    expect(sweep).toContain('runWithDentallyPriority("background"');
  });

  it("checks the kill switch FIRST, before it reads anything at all", () => {
    const idx = sweep.indexOf('isSystemEnabled(CLIENT_ID, "balance-reminders")');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(sweep.indexOf("listOutstandingDetailed(siteIds)"));
    expect(idx).toBeLessThan(sweep.indexOf('acquireCronLock("sweep-collection"'));
  });

  it("bounds the live per-patient verification reads independently of the draft cap", () => {
    // Each one costs the practice's shared hourly Dentally quota, so a run where
    // every candidate fails verification must still cost a known number of reads.
    expect(sweep).toContain("verifyReads >= config.maxVerifyReadsPerRun");
  });

  it("treats a suppression read that throws as a SKIP, never as 'not opted out'", () => {
    expect(sweep).toContain("suppression_unavailable");
  });
});
