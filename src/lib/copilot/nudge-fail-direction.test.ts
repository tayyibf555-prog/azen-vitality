import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

// ===========================================================================
// THE CO-PILOT'S ONE SEND DOOR FAILS CLOSED WHEN MESSAGING IS LIVE (W1-B/1-5).
//
// WHAT THIS FILE HOLDS THAT lead-tools.test.ts CANNOT. Every other nudge_lead
// test stubs the systems repository — `isSystemEnabled(ForSend): async () =>
// store.systemOn` — so the switch always answers cleanly and the ERROR BRANCH,
// the only branch where the fail direction exists at all, is unreachable in all
// of them. This suite runs the REAL `isSystemEnabledForSend` against a Supabase
// client whose every read errors, which is the one thing that tells the two
// helpers apart.
//
// WHY IT MATTERS HERE MORE THAN ALMOST ANYWHERE. `speed-to-lead` is a default-ON
// slug, so `isSystemEnabled` resolves an unreadable `system_toggle` to ENABLED —
// and `contactLead` sends through `sendMessage` DIRECTLY (its own comment: speed
// matters, not the drain). There is no outbox behind this door and therefore no
// second reading of the switch: every other acting tool in tools.ts enqueues, and
// the drain re-gates it with `getDisabledSlugsForSend`. So on this one path a
// transient toggle-read blip was the whole distance between "refused" and a real
// SMS out of a system the owner had switched off.
//
// THE DIRECTION IS TIED TO THE DRY-RUN FLAG, NOT BLANKET. Both directions are
// asserted below, because a door that refused whatever the flag said would be a
// different bug — every local and staged nudge dead — and would pass a one-sided
// test happily.
//
// The message never leaves the process either way: `contactLead` is a spy.
// ===========================================================================

const SITES: Record<string, { id: string; name: string; clientId: string }> = {
  "site-cc": { id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" },
};

const store = vi.hoisted(() => ({
  leads: [] as unknown[],
  logged: [] as Record<string, unknown>[],
  contactCalls: [] as string[],
  attempts: [] as unknown[],
  /** Every Supabase read this suite serves. Errors unless a test says otherwise. */
  toggleResult: { data: null as unknown, error: { message: "system_toggle unreadable" } as unknown },
  toggleReads: 0,
}));

vi.mock("server-only", () => ({}));

// A chainable builder, same shape as src/lib/systems/repository.test.ts's: every
// step returns the thenable, so `await sb.from().select().eq().eq().maybeSingle()`
// resolves to whatever the test configured.
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => {
        store.toggleReads += 1;
        return Promise.resolve(store.toggleResult);
      };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        store.toggleReads += 1;
        return Promise.resolve(store.toggleResult).then(res, rej);
      };
      return b;
    },
  }),
}));

vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: async (a: Record<string, unknown>) => {
    store.logged.push(a);
  },
}));

vi.mock("@/lib/mock", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) => (id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) => (id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));

vi.mock("@/lib/dentally/read", () => ({
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: vi.fn(),
}));

// THE SYSTEMS REPOSITORY IS NOT MOCKED. That is the whole point of this file.

vi.mock("@/lib/speed-to-lead/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLead: async (id: string) => {
    const found = (store.leads as SpeedToLeadLead[]).find((l) => l.id === id);
    return found ? { ...found } : null;
  },
  listAttemptsForLeads: async (ids: string[]) =>
    (store.attempts as Array<{ leadId: string }>).filter((a) => ids.includes(a.leadId)),
  claimLeadFromStage: async (id: string, from: string) => {
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === id);
    if (!l || l.stage !== from) return false;
    l.stage = "contacting";
    return true;
  },
  setLeadStage: async () => {},
}));

// toAddress and channelConsented stay REAL; only the send itself is a spy.
vi.mock("@/lib/speed-to-lead/contact", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // FAITHFUL in the one way nudge_lead depends on: a successful contact WRITES AN
  // ATTEMPT, and the tool reads that ledger to decide whether anything really went
  // out. A spy that only recorded the call would let "it sent" pass vacuously.
  contactLead: async (lead: SpeedToLeadLead) => {
    store.contactCalls.push(lead.id);
    store.attempts.push({
      id: `att-${store.attempts.length + 1}`,
      leadId: lead.id,
      channel: "sms",
      toAddress: lead.phone ?? "",
      body: "[first contact, drafted by the pipeline]",
      status: "sent",
      provider: "test",
      providerMessageId: `SM-${store.attempts.length + 1}`,
      createdAt: new Date().toISOString(),
    });
  },
}));

import { makeCopilotDispatch } from "./tools";

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

function makeLead(over: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Amara Osei",
    email: null,
    phone: "+447700900001",
    channel: "sms",
    treatmentInterest: "Invisalign",
    source: "smile-assessment",
    score: 80,
    stage: "new",
    consent: { sms: true },
    createdAt: "2026-08-18T09:00:00.000Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-08-18T09:00:00.000Z",
    nurtureStep: 0,
    nurtureNextAt: null,
    ...over,
  };
}

const ORIGINAL_DRY_RUN = process.env.MESSAGING_DRY_RUN;

beforeEach(() => {
  store.leads = [makeLead()];
  store.logged = [];
  store.contactCalls = [];
  store.attempts = [];
  store.toggleReads = 0;
  store.toggleResult = { data: null, error: { message: "system_toggle unreadable" } };
  // The read errors are the point of the suite; the console noise is not.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.MESSAGING_DRY_RUN;
  else process.env.MESSAGING_DRY_RUN = ORIGINAL_DRY_RUN;
});

describe("nudge_lead when the kill switch cannot be read", () => {
  it("SENDS NOTHING when messaging is live and system_toggle is unreadable", async () => {
    // Live means the exact string "false" (the dry-run fail-safe inversion).
    process.env.MESSAGING_DRY_RUN = "false";

    const out = JSON.parse(await dispatch("nudge_lead", { leadId: "lead-1", confirm: true }));

    expect(store.toggleReads, "the switch was never consulted").toBeGreaterThan(0);
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("system_off");
    expect(store.contactCalls, "a lead was contacted off an unreadable switch").toEqual([]);
    // And it is recorded as what it is, so the refusal is auditable rather than silent.
    expect(store.logged.some((l) => l.status === "blocked:system_off")).toBe(true);
  });

  it("still answers for a default-ON system while messaging is only simulated", async () => {
    // The other half of ruling W1-B/1-5: the fail direction is tied to the flag.
    // In dry-run a toggle blip must not break a nudge nobody could receive anyway.
    process.env.MESSAGING_DRY_RUN = "true";

    const out = JSON.parse(await dispatch("nudge_lead", { leadId: "lead-1", confirm: true }));

    expect(store.toggleReads).toBeGreaterThan(0);
    expect(out.reason).not.toBe("system_off");
    expect(out.sent).toBe(true);
    expect(store.contactCalls).toEqual(["lead-1"]);
  });

  it("a readable switch still decides, live or not: an explicit OFF row refuses", async () => {
    // The error branch is the new half; the ordinary one must be untouched by it.
    process.env.MESSAGING_DRY_RUN = "false";
    store.toggleResult = { data: { enabled: false }, error: null };

    const out = JSON.parse(await dispatch("nudge_lead", { leadId: "lead-1", confirm: true }));

    expect(out.reason).toBe("system_off");
    expect(store.contactCalls).toEqual([]);

    // ...and an explicit ON row sends, which is what stops this suite passing
    // because nudge_lead refuses everything.
    store.toggleResult = { data: { enabled: true }, error: null };
    store.leads = [makeLead({ id: "lead-2" })];
    const on = JSON.parse(await dispatch("nudge_lead", { leadId: "lead-2", confirm: true }));
    expect(on.sent).toBe(true);
    expect(store.contactCalls).toEqual(["lead-2"]);
  });
});
