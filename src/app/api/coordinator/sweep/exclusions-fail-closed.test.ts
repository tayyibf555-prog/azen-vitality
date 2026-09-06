// ===========================================================================
// THE COORDINATOR SWEEP, WITH THE EXCLUSION LIST UNREADABLE (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." The refusal existed in this
// route from wave 1 and NOTHING observed it: this module's other tests hand the
// route `isExclusionsUnavailable: () => false` next to an empty
// `loadExcludedTargetKeys`, which makes the branch structurally unreachable, so
// replacing the refusal with `excludedKeys = new Set<string>()` — the exact
// fail-OPEN regression the ruling forbids — left the whole suite green. Every
// patient a human had marked `inactive` would then have passed the `excluded:`
// check and been drafted a follow-up about their treatment.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced), because a test that mocks the
// predicate proves the route's `if`, not the ruling.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** The exclusion read refuses, as it does once messaging is live and the table is unreadable. */
  unavailable: false,
  /** A DIFFERENT failure, which must NOT be reported as a tidy skip. */
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

vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" }],
  getSite: (id: string) => ({ id, clientId: "vitality", name: "N15 Vitality Dental" }),
}));
vi.mock("@/lib/coordinator/draft", () => ({
  draftOutreach: vi.fn(async (o: { id: string }) => {
    h.drafted.push(o.id);
    return { body: "Hello from Vitality" };
  }),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  listOpportunities: vi.fn(async () => [
    {
      id: "opp-1",
      siteId: "site-cc",
      dentallyPatientId: "pat-1",
      patientName: "Alex Berry",
      status: "identified",
      value: 1200,
      consent: { sms: true, email: true, marketing: true },
    },
  ]),
  getCadence: vi.fn(async () => null),
  createCadence: vi.fn(async () => ({ id: "cad-1", currentStep: 0 })),
  updateCadence: vi.fn(async () => {}),
  insertTouch: vi.fn(async (t: { opportunityId?: string }) => {
    h.inserted.push(String(t.opportunityId ?? "?"));
    return { id: "touch-1" };
  }),
  approveTouch: vi.fn(async () => ({ id: "touch-1" })),
  enqueueOutbox: vi.fn(async () => ({})),
  listTouches: vi.fn(async () => []),
  setOpportunityStatus: vi.fn(async () => {}),
}));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/coordinator/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafted = [];
  h.inserted = [];
});

describe("coordinator sweep: an unreadable exclusion list stops the tick", () => {
  it("coordinator-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafted, "a patient was drafted against an unknown exclusion list").toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("and runs normally again as soon as the list can be read", async () => {
    // The other half: the refusal is a skip, not a latch. A skipped tick is a
    // delay. The normal answer carries the sweep's counters; the refusal carries
    // no `swept` at all, which is how the two are told apart without asserting a
    // whole draft path this file is not about.
    h.unavailable = false;
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.swept, "the tick refused with a readable exclusion list").toBeDefined();
    expect(body.skipped).not.toBe("exclusions unavailable");
  });

  it("does NOT report an unrelated failure as a tidy skip", async () => {
    h.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.drafted).toEqual([]);
  });
});
