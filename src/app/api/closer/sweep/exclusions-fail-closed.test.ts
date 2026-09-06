// ===========================================================================
// THE TREATMENT-CLOSER SWEEP, WITH THE EXCLUSION LIST UNREADABLE (W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." The refusal was written in
// wave 1 and NOTHING observed it: closer-sweep.test.ts hands the route an
// exclusion mock that never refuses (and does not even define
// `isExclusionsUnavailable`), so the branch is structurally unreachable and the
// fail-OPEN regression the ruling forbids leaves the whole suite green.
//
// The catch here goes round a `Promise.all` DESTRUCTURING, which is the shape
// most likely to be lost in a refactor: a rejection anywhere in that array lands
// in the same catch, so the narrowing on `isExclusionsUnavailable` is the only
// thing keeping a genuine database outage from being reported as a tidy skip.
// Both directions are tested.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced).
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

vi.mock("@/lib/coordinator/repository", () => ({
  listOpportunities: vi.fn(async () => [
    {
      id: "site-cc:p1:pl1",
      siteId: "site-cc",
      dentallyPatientId: "p1",
      dentallyPlanId: "pl1",
      patientName: "Sarah Lindqvist",
      treatment: "Invisalign full arch",
      plannedValue: 4200,
      status: "presented",
      consent: { sms: true, email: true, marketing: true },
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    },
  ]),
}));
vi.mock("@/lib/closer/repository", () => ({
  insertDraft: vi.fn(async (d: { opportunityId?: string }) => {
    h.inserted.push(String(d.opportunityId ?? "?"));
    return { id: "t-1" };
  }),
  stopOpportunity: vi.fn(async () => {}),
  coolOff: vi.fn(async () => {}),
  listStatesByOpportunity: vi.fn(async () => new Map()),
  listInboundBodiesByOpportunity: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/closer/draft", () => ({
  draftCloserMessage: vi.fn(async (o: { id?: string }) => {
    h.drafted.push(String(o?.id ?? "?"));
    return { ok: true, body: "Hi Sarah." };
  }),
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: vi.fn(async () => false) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/closer/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafted = [];
  h.inserted = [];
});

describe("closer sweep: an unreadable exclusion list stops the tick", () => {
  it("closer-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafted, "a patient was drafted against an unknown exclusion list").toEqual([]);
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
