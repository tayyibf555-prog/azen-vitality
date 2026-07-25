// Recall must NEVER classify an inactive or archived Dentally patient (deceased,
// moved away, left the practice): a "your check-up is due" text to a deceased
// patient's phone is the worst message this system could send. The sync also
// settles any PREVIOUSLY-classified open recall rows for such a patient the
// moment the flag lands, and spends no appointment reads on them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TODAY = new Date().toISOString().slice(0, 10);

const store = vi.hoisted(() => ({
  patients: [] as Array<Record<string, unknown>>,
  openTargets: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<{ id: string; status: string }>,
  statusSets: [] as Array<{ id: string; status: string }>,
  cadenceSets: [] as Array<{ id: string; status: string }>,
  apptCalls: [] as string[],
}));

const dent = vi.hoisted(() => ({
  listPatients: vi.fn(async (a: { page?: number }) => ({
    patients: (a?.page ?? 1) === 1 ? store.patients : [],
  })),
  getPatientAppointments: vi.fn(async (id: string) => {
    store.apptCalls.push(id);
    return { appointments: [] as unknown[] };
  }),
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "k" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number }); }
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(id as string); }
  },
}));
vi.mock("@/lib/recall/repository", () => ({
  upsertTargets: vi.fn(async (ts: Array<{ id: string; status: string }>) => { store.upserted.push(...ts); }),
  listTargets: vi.fn(async (q: { statuses?: string[] }) => {
    // First call collects open (due + in_cadence) rows for settlement; the later
    // graduation reconcile asks for just "due" — return nothing there.
    if (q.statuses?.includes("in_cadence")) return store.openTargets;
    return [];
  }),
  markGraduated: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async (id: string, status: string) => { store.statusSets.push({ id, status }); }),
  getCadenceByTarget: vi.fn(async (targetId: string) =>
    store.openTargets.some((t) => t.id === targetId && t.status === "in_cadence")
      ? { id: `cad-${targetId}`, status: "active" }
      : null,
  ),
  updateCadence: vi.fn(async (id: string, patch: { status: string }) => { store.cadenceSets.push({ id, status: patch.status }); }),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  // Incremental mode (backfill already done): the exclusion behaviour is mode-independent.
  getBackfillCursor: vi.fn(async () => ({ page: 5, done: true })),
  setBackfillCursor: vi.fn(async () => {}),
  // Auto-enrolment reads. No 'due' rows come back above, so nothing is enrolled here.
  createCadence: vi.fn(async () => ({ id: "cad-new" })),
  listCadences: vi.fn(async () => []),
  listDueCadences: vi.fn(async () => []),
  countContactedToday: vi.fn(async () => 0),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => new Set<string>(),
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/recall", { method: "POST", headers: { authorization: "Bearer rc-secret" } }),
  );
  return (await res.json()) as { ok: boolean };
}

beforeEach(() => {
  store.patients = [];
  store.openTargets = [];
  store.upserted = [];
  store.statusSets = [];
  store.cadenceSets = [];
  store.apptCalls = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rc-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("recall sync excludes inactive/archived patients", () => {
  it("never classifies them, settles their open rows, and spends no appointment reads", async () => {
    store.patients = [
      // Archived (e.g. deceased) with a recall due TODAY: would classify without the guard.
      { id: "p-arch", first_name: "Ada", last_name: "Archived", archived: true, dentist_recall_date: TODAY, use_sms: true },
      // Deactivated, mid-cadence from an earlier classification.
      { id: "p-inact", first_name: "Ivy", last_name: "Inactive", active: false, dentist_recall_date: TODAY, use_sms: true },
      // Control: live patient, recall due today -> classified as usual.
      { id: "p-live", first_name: "Liam", last_name: "Live", active: true, dentist_recall_date: TODAY, use_sms: true },
    ];
    store.openTargets = [
      { id: "site-1:p-arch:dentist", dentallyPatientId: "p-arch", status: "due", dueAt: TODAY },
      { id: "site-1:p-inact:dentist", dentallyPatientId: "p-inact", status: "in_cadence", dueAt: TODAY },
    ];

    const out = await run();
    expect(out.ok).toBe(true);

    // Only the live patient is classified.
    expect(store.upserted.map((t) => t.id)).toEqual(["site-1:p-live:dentist"]);

    // Both excluded patients' open rows are retired as 'exhausted' (not converted,
    // not graduated - reactivation must not adopt them either).
    expect(store.statusSets).toContainEqual({ id: "site-1:p-arch:dentist", status: "exhausted" });
    expect(store.statusSets).toContainEqual({ id: "site-1:p-inact:dentist", status: "exhausted" });
    // The running cadence is ended the same way.
    expect(store.cadenceSets).toContainEqual({ id: "cad-site-1:p-inact:dentist", status: "exhausted" });

    // No Dentally appointment reads were spent on excluded patients.
    expect(store.apptCalls).toEqual(["p-live"]);
  });
});
