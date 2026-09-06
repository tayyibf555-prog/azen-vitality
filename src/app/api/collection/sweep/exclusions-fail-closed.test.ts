// ===========================================================================
// THE BALANCE-REMINDER SWEEP, WITH THE EXCLUSION LIST UNREADABLE (W1-B/2).
//
// "Exclusions unknown means nobody may be drafted", and this is the agent that
// tells a patient they owe money — the route's own comment says the ruling
// "matters most here". The refusal was written in wave 1 and NOTHING observed it:
// this route had no test of its own driving the branch at all, and the fail-OPEN
// regression the ruling forbids (`excludedKeys = new Set<string>()`) left the
// FULL suite green, texting a patient a human had marked do_not_contact about a
// debt.
//
// The catch goes round a `Promise.all` DESTRUCTURING, so a rejection from any of
// the four reads lands in it; the narrowing on `isExclusionsUnavailable` is the
// only thing keeping a real outage from being reported as a tidy skip. Both
// directions are tested, with the REAL predicate and the REAL error class.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  unavailable: false,
  otherFailure: false,
  drafted: [] as string[],
  inserted: [] as string[],
}));

vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => true),
  isSystemEnabledForSend: vi.fn(async () => true),
}));

// PARTIAL: the real ExclusionsUnavailableError and the real isExclusionsUnavailable.
vi.mock("@/lib/patient-status/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-status/repository")>();
  return {
    ...actual,
    loadExcludedTargetKeys: vi.fn(async () => {
      if (h.otherFailure) throw new Error("something else entirely");
      if (h.unavailable) throw new actual.ExclusionsUnavailableError(new Error("PGRST301"));
      return new Set<string>();
    }),
  };
});

// No Dentally is spoken to: both reads this route makes are faked here.
vi.mock("@/lib/dentally/read", () => ({
  listOutstandingDetailed: vi.fn(async () => ({
    truncated: false,
    rows: [
      {
        siteId: "site-cc",
        patientId: "p1",
        patientName: "Sarah Lindqvist",
        outstandingPence: 12_000,
        oldestInvoiceAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      },
    ],
  })),
  listPatients: vi.fn(async () => [
    {
      id: "p1",
      siteId: "site-cc",
      firstName: "Sarah",
      lastName: "Lindqvist",
      consent: { sms: true, email: true, marketing: false },
    },
  ]),
}));
vi.mock("@/lib/collection/read", () => ({ readPatientInvoices: vi.fn(async () => []) }));
vi.mock("@/lib/collection/repository", () => ({
  listStatesByPatient: vi.fn(async () => new Map()),
  listInboundBodiesByPatient: vi.fn(async () => new Map()),
  insertDraft: vi.fn(async (d: { patientId?: string }) => {
    h.inserted.push(String(d?.patientId ?? "?"));
    return { id: "t-1" };
  }),
  stopTarget: vi.fn(async () => {}),
  settleTarget: vi.fn(async () => {}),
  escalate: vi.fn(async () => {}),
  coolOff: vi.fn(async () => {}),
}));
vi.mock("@/lib/collection/draft", () => ({
  draftCollectionMessage: vi.fn(async () => {
    h.drafted.push("p1");
    return { ok: true, body: "Hello from Vitality" };
  }),
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: vi.fn(async () => false) }));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/collection/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafted = [];
  h.inserted = [];
});

describe("balance-reminder sweep: an unreadable exclusion list stops the tick", () => {
  it("collection-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafted, "a patient was told about a debt against an unknown exclusion list").toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("and runs normally again as soon as the list can be read", async () => {
    h.unavailable = false;
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.examined, "the tick refused with a readable exclusion list").toBeDefined();
    expect(body.skipped).not.toBe("exclusions unavailable");
  });

  it("does NOT report an unrelated failure in the same Promise.all as a tidy skip", async () => {
    h.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.drafted).toEqual([]);
  });
});
