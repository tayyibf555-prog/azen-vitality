// Recall must NEVER classify an INACTIVE Dentally patient (deceased, moved away,
// left the practice): a "your check-up is due" text to a deceased patient's phone
// is the worst message this system could send. The sync also settles any
// PREVIOUSLY-classified open recall rows for such a patient the moment the flag
// lands, and spends no appointment reads on them.
//
// The sync used to test `active === false || archived === true`. Verified against
// live Dentally on 2026-07-26: patient records carry NO `archived` field at all,
// only `archived_reason`, so the second half of that test could never fire and was
// dead code. It has been removed rather than repointed at `archived_reason`, which
// would have WIDENED the excluded set. The set of excluded patients is unchanged:
// `active === false` and nothing else. Both facts are pinned below.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TODAY = new Date().toISOString().slice(0, 10);

const store = vi.hoisted(() => ({
  patients: [] as Array<Record<string, unknown>>,
  openTargets: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<{ id: string; status: string }>,
  statusSets: [] as Array<{ id: string; status: string }>,
  cadenceSets: [] as Array<{ id: string; status: string }>,
  apptCalls: [] as string[],
  /** Force the site's run to blow up, to exercise the per-site failure contract. */
  listTargetsThrows: false,
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
    if (store.listTargetsThrows) throw new Error("supabase down");
    // First call collects open (due + in_cadence) rows for settlement; the later
    // graduation reconcile asks for just "due", so return nothing there.
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
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true ,
  // Ruling W1-B/1: the sweep now reads isSystemEnabledForSend (fail-closed once
  // messaging is live), and liveSwitch re-reads it every ten rows. Same verdict as
  // isSystemEnabled above, so these cases keep meaning exactly what they meant.
  isSystemEnabledForSend: async () => true}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => new Set<string>(),
  // Ruling W1-B/2: loadExcludedTargetKeys REFUSES when the override table is
  // unreadable and messaging is live. This fake never refuses, so the guard reads
  // false; the refusal itself is proved in src/lib/agent-wiring/scenarios.test.ts.
  isExclusionsUnavailable: () => false,
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
  return (await res.json()) as { ok: boolean; failedSites: string[]; perSite: Array<{ error?: string }> };
}

beforeEach(() => {
  store.patients = [];
  store.openTargets = [];
  store.upserted = [];
  store.statusSets = [];
  store.cadenceSets = [];
  store.apptCalls = [];
  store.listTargetsThrows = false;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rc-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("recall sync excludes inactive patients", () => {
  it("never classifies them, settles their open rows, and spends no appointment reads", async () => {
    store.patients = [
      // Deactivated (e.g. deceased, left the practice), mid-cadence from an earlier
      // classification. This is the flag that live Dentally actually sets.
      { id: "p-inact", first_name: "Ivy", last_name: "Inactive", active: false, dentist_recall_date: TODAY, use_sms: true },
      // Control: live patient, recall due today -> classified as usual.
      { id: "p-live", first_name: "Liam", last_name: "Live", active: true, dentist_recall_date: TODAY, use_sms: true },
    ];
    store.openTargets = [
      { id: "site-1:p-inact:dentist", dentallyPatientId: "p-inact", status: "in_cadence", dueAt: TODAY },
    ];

    const out = await run();
    expect(out.ok).toBe(true);

    // Only the live patient is classified.
    expect(store.upserted.map((t) => t.id)).toEqual(["site-1:p-live:dentist"]);

    // The excluded patient's open row is retired as 'exhausted' (not converted,
    // not graduated - reactivation must not adopt them either).
    expect(store.statusSets).toContainEqual({ id: "site-1:p-inact:dentist", status: "exhausted" });
    // The running cadence is ended the same way.
    expect(store.cadenceSets).toContainEqual({ id: "cad-site-1:p-inact:dentist", status: "exhausted" });

    // No Dentally appointment reads were spent on the excluded patient.
    expect(store.apptCalls).toEqual(["p-live"]);
  });

  it("does not exclude a patient who merely carries archived_reason", async () => {
    // Live Dentally has no `archived` boolean; only `archived_reason` exists, and it
    // is NOT an outreach exclusion. Pinning this stops a future reader "repairing"
    // the removed test by pointing it at archived_reason, which would silently widen
    // the excluded set and stop chasing patients who should be chased.
    store.patients = [
      { id: "p-reason", first_name: "Ada", last_name: "Reason", active: true, archived_reason: "lapsed", dentist_recall_date: TODAY, use_sms: true },
    ];

    await run();

    expect(store.upserted.map((t) => t.id)).toEqual(["site-1:p-reason:dentist"]);
    expect(store.statusSets).toEqual([]);
    expect(store.apptCalls).toEqual(["p-reason"]);
  });
});

describe("recall run reports a failed site", () => {
  it("answers ok:false and names the site when one fails, instead of a green ok:true", async () => {
    store.listTargetsThrows = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await run();

    // Still HTTP 200 (pg_cron's trigger_app_cron fires http_get and never sees the
    // status), but unmistakably not ok: a site failing every tick used to leave the
    // cron history looking perfectly green.
    expect(out.ok).toBe(false);
    expect(out.failedSites).toEqual(["site-1"]);
    expect(out.perSite[0].error).toContain("supabase down");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("answers ok:true with an empty failedSites list on a clean run", async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.failedSites).toEqual([]);
  });
});
