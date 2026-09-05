// ===========================================================================
// THE GRACEFUL LANDING FOR RULING W1-B/2 ON THE OUTREACH BUILD PATH.
//
//     ONCE MESSAGING IS LIVE, UNCERTAINTY FAILS CLOSED.
//     A skipped tick is a delay. An audience built against an unknown
//     exclusion list is an incident.
//
// src/lib/patient-status/exclusion-fail-closed.test.ts pins the READ: while
// messaging is live, an unreadable patient_status_override makes
// loadExcludedPatientIds throw ExclusionsUnavailableError instead of handing the
// builder an empty Set. That was the whole safety fix, and it is not repeated
// here.
//
// THE DEFECT THIS FILE PINS is what happened next. build.ts called that loader
// OUTSIDE its own try, under a doc comment promising "Never throws". So the
// refusal escaped runOutreachBuildTick entirely: fail-CLOSED (nobody enrolled)
// but not graceful — the cron path survived only because continueBuilds wraps
// each tick, while /api/outreach/build, the campaigns PATCH `start-build` action
// and the co-pilot's create_outreach_campaign tool would each have surfaced a
// 500 or a tool error where the honest answer is "not this tick".
//
// FOUR THINGS MUST HOLD, and each is a different way this could be got wrong:
//
//   1. NOBODY IS ENROLLED, and no Dentally budget is spent. This is the ruling
//      itself and it outranks the other three: an outreach enrolment is
//      PERMANENT (sweepCampaign re-checks target status, consent and the daily
//      cap, never the exclusion list), and `inactive` has no second net at the
//      send choke point — applyStatusChange writes message_suppression rows for
//      do_not_contact only.
//   2. THE TICK DOES NOT THROW, and says WHY it did nothing: ok:true, done:false,
//      skipped "exclusions unavailable". A caller must be able to tell this from
//      "already built" (done:true) and from a real failure (ok:false).
//   3. THE CURSOR IS UNADVANCED and nothing is persisted, so the next tick
//      resumes on the SAME page and the campaign stays 'building' for the sweep
//      to pick up. A skip that advanced the cursor would silently skip a page of
//      the patient base for the life of the campaign.
//   4. A DIFFERENT ERROR IS STILL A FAILURE. Dressing an unrelated fault up as a
//      polite "skipped" is how a broken build looks healthy on a dashboard.
//
// The loader runs FOR REAL below (only Supabase is doubled), so the error
// identity and `isExclusionsUnavailable` are the live ones, not a stand-in.
// ===========================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OutreachCampaign } from "./types";

const h = vi.hoisted(() => ({
  /** Whether the override table is currently unreadable. */
  down: true,
  /** When set, loadExcludedPatientIds throws THIS instead of running for real. */
  otherError: null as Error | null,
  /** Patient ids handed to insertTargets, i.e. actually enrolled into the campaign. */
  inserts: [] as string[][],
  /** Per-patient Dentally appointment reads the build performed. */
  apptCalls: [] as string[],
  /** Every persistence write the tick made to the campaign row. */
  updates: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table !== "patient_status_override") throw new Error(`unexpected table: ${table}`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: () => builder,
        then<R>(onF?: ((v: { data: unknown; error: unknown }) => R) | null) {
          const res = h.down
            ? { data: null, error: { message: "permission denied for table patient_status_override" } }
            : { data: [], error: null };
          return Promise.resolve(res).then(onF ?? undefined);
        },
      };
      return builder;
    },
  }),
}));

// The REAL exclusion loader, the REAL ExclusionsUnavailableError and the REAL
// isExclusionsUnavailable predicate: the only thing this wrapper adds is a way to
// make the loader fail with something that is NOT the refusal (case 4 above),
// which the real implementation can never do on its own because it catches
// everything the database throws.
vi.mock("@/lib/patient-status/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-status/repository")>();
  return {
    ...actual,
    loadExcludedPatientIds: async (siteId: string) => {
      if (h.otherError) throw h.otherError;
      return actual.loadExcludedPatientIds(siteId);
    },
  };
});

// Only Dentally and the campaign repository are doubled, exactly as
// build-status-exclusion.test.ts does: the builder itself runs for real.
vi.mock("@/lib/dentally/read", () => ({
  dentallyFromEnv: () => ({
    listPatients: async ({ page }: { page: number }) =>
      page === 1
        ? {
            patients: [
              {
                id: "p-marked-inactive",
                first_name: "Ex",
                last_name: "Cluded",
                mobile_phone: "07700900000",
                use_sms: true,
                active: true,
              },
            ],
          }
        : { patients: [] },
    getPatientAppointments: async (id: string) => {
      h.apptCalls.push(id);
      return { appointments: [{ start_time: "2025-06-01T09:00:00Z", reason: "hygiene", state: "closed" }] };
    },
  }),
  dentallyReadKey: () => "test-key",
}));
vi.mock("@/lib/mock/clients", () => ({ dentallySiteId: (id: string) => id }));
vi.mock("./repository", () => ({
  getCampaign: async () => null,
  updateCampaign: async (_id: string, patch: Record<string, unknown>) => {
    h.updates.push(patch);
  },
  insertTargets: async (targets: { patientId: string }[]) => {
    h.inserts.push(targets.map((t) => t.patientId));
    return targets.length;
  },
}));

import { initBuildCursor, runOutreachBuildTick } from "./build";

const SITE = "site-cc";
const ORIGINAL_ENV = { ...process.env };

function campaign(): OutreachCampaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: SITE,
    name: "seg",
    // 'building' already, so the tick's own status flip does not fire and every
    // persistence write the assertions see is one the tick chose to make.
    status: "building",
    filters: {},
    practitionerId: null,
    practitionerName: null,
    messageAngle: "a hygiene visit",
    messageAngleB: null,
    dailyCap: 25,
    buildCursor: initBuildCursor(),
    counts: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

/** MESSAGING_DRY_RUN is live only for the exact string "false". */
function goLive(): void {
  process.env.MESSAGING_DRY_RUN = "false";
}

// THE CLOCK IS FROZEN for the reason build-status-exclusion.test.ts states: the
// control cases only enrol anybody because their one visit (2025-06-01) sits inside
// the 1,095-day treatment lookback build.ts measures back from `new Date()`. Let
// real time run and in 2028 the controls stop proving anything, and the refusal
// cases start passing vacuously because nobody is enrolled either way.
// Only Date is faked; faking every timer would hang the async build tick.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2025-07-01T09:00:00.000Z"));
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MESSAGING_DRY_RUN; // absent = dry run
  h.down = true;
  h.otherError = null;
  h.inserts = [];
  h.apptCalls = [];
  h.updates = [];
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("outreach build tick: an unreadable targeting-exclusion list", () => {
  it("LIVE: the tick is skipped gracefully - it does not throw, enrols nobody and reads no Dentally", async () => {
    goLive();

    const result = await runOutreachBuildTick(campaign());

    expect(h.inserts.flat(), "a patient who may be marked inactive was enrolled for good").toEqual([]);
    expect(h.apptCalls, "the build spent Dentally budget on an audience it must not build").toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.done).toBe(false);
    expect(result.skipped).toBe("exclusions unavailable");
    expect(result.error).toBeUndefined();
    expect(result.appointmentReads).toBe(0);
    expect(result.insertedThisRun).toBe(0);
  });

  it("LIVE: the cursor is unadvanced and nothing is persisted, so the next tick resumes on the same page", async () => {
    goLive();

    const result = await runOutreachBuildTick(campaign());

    expect(result.cursor).toEqual(initBuildCursor());
    expect(result.cursor?.page).toBe(1);
    expect(result.cursor?.done).toBe(false);
    // No cursor, no counts, and above all no 'ready': the campaign stays 'building'
    // so the sweep picks it up again on the next tick.
    expect(h.updates, "a refused tick persisted campaign state").toEqual([]);
  });

  it("DRY-RUN: the same unreadable table keeps the old behaviour, proving the live flag is the cause", async () => {
    const result = await runOutreachBuildTick(campaign());

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(h.inserts.flat()).toContain("p-marked-inactive");
  });

  it("LIVE with a readable list: the build runs normally, proving the read failure is the cause", async () => {
    h.down = false;
    goLive();

    const result = await runOutreachBuildTick(campaign());

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(h.inserts.flat()).toContain("p-marked-inactive");
  });

  it("an error that is not the exclusion refusal is reported as a failure, never as a skipped tick", async () => {
    goLive();
    h.otherError = new TypeError("exclusions loader blew up in some other way");

    const result = await runOutreachBuildTick(campaign());

    expect(result.ok).toBe(false);
    expect(result.skipped, "an unrelated fault was dressed up as a polite skip").toBeUndefined();
    expect(result.error).toContain("some other way");
    expect(h.inserts.flat()).toEqual([]);
    expect(h.apptCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });
});
