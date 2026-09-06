// ===========================================================================
// THE REACTIVATION SWEEP, WITH THE EXCLUSION LIST UNREADABLE (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." The refusal was written in
// wave 1 and NOTHING observed it: this module's own suite hands the route
// `isExclusionsUnavailable: () => false` next to an empty
// `loadExcludedTargetKeys`, which makes the branch structurally unreachable, so
// replacing the refusal with `excludedKeys = new Set<string>()` — the exact
// fail-OPEN regression the ruling forbids — left the whole suite green, and every
// patient a human marked `inactive` would have been drafted an unsolicited
// come-back text.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced), because a test that mocks the
// predicate proves the route's `if`, not the ruling.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  unavailable: false,
  otherFailure: false,
  drafted: [] as string[],
  outbox: [] as string[],
}));

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

vi.mock("@/lib/reactivation/draft", () => ({
  draftReactivation: vi.fn(async (t: { id: string }) => {
    h.drafted.push(t.id);
    return { body: "Hello from Vitality" };
  }),
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: vi.fn(async () => 25),
  countContactedToday: vi.fn(async () => 0),
}));
vi.mock("@/lib/reactivation/repository", () => ({
  listDueCadences: vi.fn(async () => [{ id: "cad-1", targetId: "t-1", currentStep: 0 }]),
  getTarget: vi.fn(async (id: string) => ({
    id,
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    patientName: "Alex Berry",
    lastVisitAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    consent: { sms: true, email: true, marketing: true },
    value: 300,
  })),
  listTouches: vi.fn(async () => []),
  insertTouch: vi.fn(async () => ({ id: "touch-1" })),
  approveTouch: vi.fn(async () => {}),
  enqueueOutbox: vi.fn(async (row: { toRef: string }) => {
    h.outbox.push(row.toRef);
  }),
  incrementPriorAttempts: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
}));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/reactivation/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafted = [];
  h.outbox = [];
});

describe("reactivation sweep: an unreadable exclusion list stops the tick", () => {
  it("reactivation-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafted, "a patient was drafted against an unknown exclusion list").toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it("and runs normally again as soon as the list can be read", async () => {
    h.unavailable = false;
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.swept, "the tick refused with a readable exclusion list").toBeDefined();
    expect(body.skipped).toBeUndefined();
  });

  it("does NOT report an unrelated failure as a tidy skip", async () => {
    h.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.drafted).toEqual([]);
  });
});
