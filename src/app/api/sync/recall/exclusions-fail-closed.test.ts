// ===========================================================================
// THE RECALL SYNC, WITH THE EXCLUSION LIST UNREADABLE (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be ENROLLED." This route's catch is the
// OTHER lawful shape of the ruling and the only one that does not abort: the
// read-only Dentally mirroring below it is what keeps the dashboard current and
// the catalog promises it keeps running whatever the messaging systems are doing.
// So the enrolment allowance drops to zero for this tick and the mirror carries
// on — a shape a source crawl can see and cannot prove.
//
// AND NOTHING OBSERVED IT. exclusion.test.ts and auto-enrol.test.ts both hand
// this route `isExclusionsUnavailable: () => false` next to an empty
// `loadExcludedTargetKeys`, so the branch was structurally unreachable and
// deleting it would have left the suite green — quietly enrolling a patient a
// human had marked `inactive` into a cadence that then texts them for weeks.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced).
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  due: [] as Array<Record<string, unknown>>,
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
    listPatients() { return Promise.resolve({ patients: [] as unknown[] }); }
    getPatientAppointments() { return Promise.resolve({ appointments: [] as unknown[] }); }
  },
}));
vi.mock("@/lib/recall/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async (q: { statuses?: string[] }) =>
    q.statuses?.length === 1 && q.statuses[0] === "due" ? store.due : [],
  ),
  markGraduated: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  getCadenceByTarget: vi.fn(async () => null),
  createCadence: vi.fn(async (i: { targetId: string }) => {
    store.created.push(i.targetId);
    return { id: `cad-${i.targetId}` };
  }),
  listCadences: vi.fn(async () => []),
  listDueCadences: vi.fn(async () => []),
  countContactedToday: vi.fn(async () => 0),
  updateCadence: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  getBackfillCursor: vi.fn(async () => ({ page: 5, done: true })),
  setBackfillCursor: vi.fn(async () => {}),
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
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

/** A classified, un-enrolled recall target, ready to be adopted into a cadence. */
function target(id: string) {
  return {
    id: `site-1:${id}:dentist`,
    siteId: "site-1",
    dentallyPatientId: id,
    patientName: "Test Patient",
    recallType: "dentist",
    dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    overdueDays: 3,
    lastVisitAt: null,
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
  };
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/recall", {
      method: "POST",
      headers: { authorization: "Bearer rc-secret" },
    }),
  );
  return (await res.json()) as {
    ok: boolean;
    enrolBudget: number;
    perSite: Array<{ enrolled: number }>;
  };
}

beforeEach(() => {
  store.due = [target("p-1"), target("p-2")];
  store.created = [];
  store.unavailable = false;
  store.otherFailure = false;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rc-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("recall sync: an unreadable exclusion list enrols nobody", () => {
  it("sync-recall-enrols-nobody-when-the-exclusion-list-refuses", async () => {
    store.unavailable = true;
    const out = await run();
    expect(out.enrolBudget).toBe(0);
    expect(store.created, "a patient was enrolled against an unknown exclusion list").toEqual([]);
    expect(out.perSite[0].enrolled).toBe(0);
  });

  it("sync-recall-keeps-mirroring-while-it-enrols-nobody", async () => {
    // The half that makes this shape different from the sweeps': the run does NOT
    // abort. The dashboard keeps being fed; only the messaging half stops.
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
    // The catch is narrowed to ExclusionsUnavailableError, and this read sits
    // ahead of the per-site loop, so an ordinary database failure surfaces rather
    // than being folded into "enrolled nobody, all well". Either way, nobody is
    // enrolled against a list we could not read.
    store.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(store.created).toEqual([]);
  });
});
