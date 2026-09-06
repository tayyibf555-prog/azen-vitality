// ===========================================================================
// THE REACTIVATION SYNC, WITH THE EXCLUSION LIST UNREADABLE (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be ENROLLED." This route's catch is the
// second lawful shape of the ruling — the one that does NOT abort, because the
// read-only Dentally mirroring below it keeps the dashboard current and the
// catalog promises that keeps running whatever the messaging systems are doing.
// The enrolment allowance drops to zero for this tick and the mirror carries on.
//
// AND NOTHING OBSERVED IT. Every suite over this route hands it
// `isExclusionsUnavailable: () => false` next to an empty
// `loadExcludedTargetKeys`, so the branch was structurally unreachable: deleting
// it left the suite green while enrolling a patient a human marked `inactive`
// into a cadence that then texts them unsolicited for weeks.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced).
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DAY = 86_400_000;

const store = vi.hoisted(() => ({
  dormant: [] as Array<Record<string, unknown>>,
  created: [] as string[],
  unavailable: false,
  otherFailure: false,
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "k" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(...args: unknown[]) { void args; }
    listTreatmentPlans() { return Promise.resolve({ treatment_plans: [] as unknown[] }); }
    listPatients() { return Promise.resolve({ patients: [] as unknown[] }); }
    getPatientAppointments() { return Promise.resolve({ appointments: [] as unknown[] }); }
    getPatientInvoices() { return Promise.resolve({ invoices: [] as unknown[] }); }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async (q: { statuses?: string[]; limit?: number }) => {
    if (!(q.statuses?.length === 1 && q.statuses[0] === "dormant")) return [];
    const limit = q.limit;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? store.dormant.slice(0, Math.floor(limit))
      : store.dormant;
  }),
  setTargetStatus: vi.fn(async () => {}),
  getCadenceByTarget: vi.fn(async () => null),
  createCadence: vi.fn(async (i: { targetId: string }) => {
    store.created.push(i.targetId);
    return { id: `cad-${i.targetId}` };
  }),
  listCadences: vi.fn(async () => []),
  listDueCadences: vi.fn(async () => []),
  updateCadence: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  getBackfillCursor: vi.fn(async () => ({ page: 5, done: true })),
  setBackfillCursor: vi.fn(async () => {}),
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: async () => 25,
  countContactedToday: async () => 0,
  getMaxLapseMonths: async () => Number.POSITIVE_INFINITY,
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
}));

// PARTIAL: the real ExclusionsUnavailableError and the real isExclusionsUnavailable.
vi.mock("@/lib/patient-status/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-status/repository")>();
  return {
    ...actual,
    loadExcludedTargetKeys: vi.fn(async () => {
      if (store.otherFailure) throw new Error("something else entirely");
      if (store.unavailable) throw new actual.ExclusionsUnavailableError(new Error("PGRST301"));
      return new Set<string>();
    }),
    excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
  };
});
vi.mock("@/lib/recall/repository", () => ({ listOpenRecallPatientKeys: async () => new Set<string>() }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

/** A dormant reactivation target whose last visit is six months ago. */
function target(id: string) {
  return {
    id: `site-1:${id}`,
    siteId: "site-1",
    dentallyPatientId: id,
    patientName: "Test Patient",
    reason: "lapsed",
    lastVisitAt: new Date(Date.now() - 180 * DAY).toISOString(),
    recoverableValue: 180,
    status: "dormant",
    priorAttempts: 0,
    consent: { sms: true, email: true, marketing: false },
  };
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/reactivation", {
      method: "POST",
      headers: { authorization: "Bearer rx-secret" },
    }),
  );
  return (await res.json()) as {
    ok: boolean;
    enrolBudget: number;
    perSite: Array<{ enrolled: number }>;
  };
}

beforeEach(() => {
  store.dormant = [target("p-1"), target("p-2")];
  store.created = [];
  store.unavailable = false;
  store.otherFailure = false;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rx-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("reactivation sync: an unreadable exclusion list enrols nobody", () => {
  it("sync-reactivation-enrols-nobody-when-the-exclusion-list-refuses", async () => {
    store.unavailable = true;
    const out = await run();
    expect(out.enrolBudget).toBe(0);
    expect(store.created, "a patient was enrolled against an unknown exclusion list").toEqual([]);
    expect(out.perSite[0].enrolled).toBe(0);
  });

  it("sync-reactivation-keeps-mirroring-while-it-enrols-nobody", async () => {
    // What makes this shape different from the sweeps': the run does NOT abort.
    store.unavailable = true;
    const out = await run();
    expect(out.ok, "the whole sync aborted over a messaging-side read").toBe(true);
    expect(out.perSite).toHaveLength(1);
  });

  it("and enrols normally again as soon as the list can be read", async () => {
    store.unavailable = false;
    const out = await run();
    expect(out.enrolBudget).toBeGreaterThan(0);
    expect(store.created.length).toBeGreaterThan(0);
  });

  it("does NOT treat an unrelated failure as the exclusion refusal", async () => {
    // The catch is narrowed to ExclusionsUnavailableError, so an ordinary database
    // failure surfaces rather than being folded into "enrolled nobody, all well".
    store.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(store.created).toEqual([]);
  });
});
