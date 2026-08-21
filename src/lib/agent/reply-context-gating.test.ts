// Recall-aware booking replies: the switch, and the order of operations.
//
// ---------------------------------------------------------------------------
// THE DEFAULT-OFF TRAP.
//
// system_toggle is DEFAULT-ON by design: a system with no row is ENABLED, which
// is what lets the kill switch ship dormant for the modules that already existed.
// That default is exactly wrong for anything new that changes what a patient is
// told, and it is a landmine: a surface that forgets to declare itself is ARMED,
// for every client, in every environment, the moment its code deploys.
//
// This feature sends nothing, but it changes how the practice's 24/7 booking agent
// OPENS a conversation, so it inverts the default in CODE as well as in a seeded
// row, and this file proves both halves against the REAL systems repository. The
// seed in migration 0092 covers exactly one client in exactly one database and
// cannot speak for a second client, a fresh environment, or a deployment where the
// migration has not run.
//
// The second half of the file pins the ORDER the inbound webhook does things in.
// Every one of those positions is a safety property: an opt-out, a structured
// no-show reply and a post-op reply must all be answered before anything here
// runs, and the switch must be read before the database is.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  getDisabledSlugs,
  getDisabledSlugsForSend,
  getSystemStates,
  __resetDisabledSlugsFailureLogForTests,
} from "@/lib/systems/repository";
import { DEFAULT_OFF_SLUGS, SYSTEMS, defaultEnabledFor } from "@/lib/systems/catalog";

const SLUG = "booking-reply-context";

beforeEach(() => {
  vi.clearAllMocks();
  h.set({ data: null, error: null });
  __resetDisabledSlugsFailureLogForTests();
});

describe("the catalog declaration", () => {
  it("declares defaultEnabled: false", () => {
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def, `${SLUG} is missing from the catalog entirely`).toBeTruthy();
    expect(def?.defaultEnabled).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(SLUG)).toBe(true);
    expect(defaultEnabledFor(SLUG)).toBe(false);
  });

  it("tells the owner, in their words, what switching it off does", () => {
    const def = SYSTEMS.find((s) => s.slug === SLUG);
    expect(def?.group).toBe("Conversational agents");
    expect(def?.halts).toMatch(/reply/i);
    expect(def?.halts.length).toBeGreaterThan(20);
  });
});

describe("no toggle row means DISABLED", () => {
  it("isSystemEnabledForSend says no, and the contract for everything else is untouched", async () => {
    h.set({ data: null, error: null });
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabledForSend("vitality", "recall")).resolves.toBe(true);
  });

  it("says no for a client the seeding migration never covered", async () => {
    h.set({ data: null, error: null });
    await expect(isSystemEnabledForSend("some-other-practice", SLUG)).resolves.toBe(false);
    await expect(isSystemEnabled("some-other-practice", SLUG)).resolves.toBe(false);
  });

  it("the owner panel renders it as off", async () => {
    h.set({ data: [], error: null });
    const states = await getSystemStates("vitality");
    expect(states.find((s) => s.slug === SLUG)?.enabled).toBe(false);
  });
});

describe("a toggle-read failure can never arm it", () => {
  it("fails CLOSED here while still failing open for the systems that shipped default-on", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.set({ data: null, error: { message: "table missing" } });
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(false);
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

describe("an owner can switch it on, and the switch is respected", () => {
  it("an explicit enabled row turns it on", async () => {
    h.set({ data: { enabled: true }, error: null });
    await expect(isSystemEnabledForSend("vitality", SLUG)).resolves.toBe(true);
  });
});

describe("the second, independent OFF: migration 0092 seeds a disabled row", () => {
  const MIGRATION = readFileSync(
    join(process.cwd(), "supabase/migrations/0092_booking_reply_context.sql"),
    "utf8",
  );

  it("inserts an explicitly disabled system_toggle row", () => {
    expect(MIGRATION).toMatch(/insert into system_toggle/i);
    expect(MIGRATION).toMatch(/'booking-reply-context',\s*false/);
  });

  it("uses `on conflict do nothing`, so a re-run cannot stamp OFF over an owner's ON", () => {
    expect(MIGRATION).toMatch(/on conflict \(client_id, module_slug\) do nothing/i);
  });

  it("creates nothing: this feature owns no tables", () => {
    expect(MIGRATION).not.toMatch(/create table/i);
    expect(MIGRATION).not.toMatch(/alter table/i);
    expect(MIGRATION).not.toMatch(/drop /i);
  });
});

describe("the inbound webhook's order of operations", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/webhooks/twilio/inbound/route.ts"),
    "utf8",
  );
  const at = (needle: string): number => {
    const i = ROUTE.indexOf(needle);
    expect(i, `not found in the inbound route: ${needle}`).toBeGreaterThan(0);
    return i;
  };

  const collect = () => at("await collectReplyContext(from)");

  it("consults the owner's switch BEFORE it reads a single row", () => {
    expect(at('isSystemEnabledForSend(agentClientId, "booking-reply-context")')).toBeLessThan(
      collect(),
    );
  });

  it("runs only after STOP, the no-show handler and the post-op handler have had the message", () => {
    // Each of these RETURNS for the messages it owns, so being after them is what
    // keeps this out of an opt-out, a structured confirmation and a clinical reply.
    expect(at("if (isStopKeyword(body)) {")).toBeLessThan(collect());
    expect(at("await handleNoshowInbound(")).toBeLessThan(collect());
    expect(at("await handlePostopInbound(")).toBeLessThan(collect());
  });

  it("runs after the opt-out gate, so a suppressed number is never primed", () => {
    expect(at("const optedOut =")).toBeLessThan(collect());
    expect(at("if (optedOut) {")).toBeLessThan(collect());
  });

  it("scopes the resolution to THIS conversation's site and patient", () => {
    expect(ROUTE).toContain("conversationSiteId: siteId");
    expect(ROUTE).toContain("conversationPatientId: identity?.patientId ?? null");
  });

  it("passes the closer's own dispute classification through", () => {
    expect(ROUTE).toContain('disputed: closerReplyKind === "dispute"');
    // ...and the classification is made before the resolution reads it.
    expect(at("closerReplyKind = kind;")).toBeLessThan(collect());
  });

  it("hands the resolved context to the agent, and nothing else", () => {
    expect(ROUTE).toContain("outreachInvite,\n    replyContext,\n  };");
  });

  it("degrades to undefined on any failure", () => {
    const block = ROUTE.slice(collect());
    expect(block).toContain("replyContext = undefined;");
    expect(block).toContain("[inbound] reply-context resolution failed; answering without it");
  });

  it("never lets the resolution write anything", () => {
    // The whole block is a read. If it ever gains a write it must be re-argued,
    // because it runs on every inbound message the practice receives.
    const start = at("// RECALL-AWARE BOOKING REPLIES.");
    const end = at("const context: AgentContext = {");
    const block = ROUTE.slice(start, end).toLowerCase();
    for (const word of ["sendmessage(", "addsuppression(", "insert", "update", "delete", ".from("]) {
      expect(block, `the reply-context block must not ${word}`).not.toContain(word);
    }
  });
});
