// ===========================================================================
// RULING W1-B/2, APPLIED TO THE SINGLE-SITE READ AS WELL.
//
//     ONCE MESSAGING IS LIVE, UNCERTAINTY FAILS CLOSED.
//     A skipped tick is a delay. A batch drafted against an unknown exclusion
//     list is an incident.
//
// The ruling was written against loadExcludedTargetKeys and its sweeps (pinned in
// src/lib/agent-wiring/rulings.test.ts, "ruling 2"). loadExcludedPatientIds — the
// SINGLE-SITE variant, and the only exclusion check anywhere on the outreach
// campaign path — kept logging and returning an empty Set, under a comment that
// claimed it matched its sibling.
//
// WHY THAT PATH HAD THE LEAST ROOM OF ALL TO BE FORGIVING:
//   * the audience is a SNAPSHOT. src/lib/outreach/build.ts checks the set once,
//     as it enrols a patient into outreach_target; sweepCampaign re-checks target
//     status, pending touches, consent and the daily cap, and never the exclusion
//     list again. A patient missed during one build tick is enrolled for the life
//     of the campaign;
//   * `inactive` has no second net. applyStatusChange writes message_suppression
//     rows for `do_not_contact` only, so the drain has nothing to stop on;
//   * the build pass is deliberately ungated by the outreach kill switch (building
//     a list is not sending), so it runs on every sweep tick regardless.
//
// So one transient blip on patient_status_override, while messaging is live, could
// put a patient a receptionist marked `inactive` into a live campaign permanently.
// It now refuses instead. Under MESSAGING_DRY_RUN the old behaviour is kept, so
// local work against a partial database is unaffected.
// ===========================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OutreachCampaign } from "@/lib/outreach/types";

const h = vi.hoisted(() => ({
  /** Whether the override table is currently unreadable. */
  down: true,
  /** Patient ids handed to insertTargets, i.e. actually enrolled into the campaign. */
  inserts: [] as string[][],
  /** Per-patient Dentally appointment reads the build performed. */
  apptCalls: [] as string[],
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

// The REAL outreach builder runs below; only Dentally and the campaign repository
// are doubled, exactly as src/lib/outreach/build-status-exclusion.test.ts does.
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
vi.mock("@/lib/outreach/repository", () => ({
  getCampaign: async () => null,
  updateCampaign: async () => {},
  insertTargets: async (targets: { patientId: string }[]) => {
    h.inserts.push(targets.map((t) => t.patientId));
    return targets.length;
  },
}));

import { isExclusionsUnavailable, loadExcludedPatientIds } from "./repository";
import { initBuildCursor, runOutreachBuildTick } from "@/lib/outreach/build";

const SITE = "site-cc";
const ORIGINAL_ENV = { ...process.env };

function campaign(): OutreachCampaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: SITE,
    name: "seg",
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

// THE CLOCK IS FROZEN, for the reason build-status-exclusion.test.ts states: the
// control case only enrols anybody because its one visit (2025-06-01) sits inside
// the 1,095-day treatment lookback build.ts measures back from `new Date()`. Let
// real time run and the control silently stops proving anything in 2028 — and the
// refusal case would then pass vacuously, because nobody is enrolled either way.
// Only Date is faked; faking every timer would hang the async build tick.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2025-07-01T09:00:00.000Z"));
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MESSAGING_DRY_RUN; // absent = dry run
  h.down = true;
  h.inserts = [];
  h.apptCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("loadExcludedPatientIds: the read itself", () => {
  it("REFUSES when the override table is unreadable and messaging is LIVE", async () => {
    goLive();
    await expect(loadExcludedPatientIds(SITE)).rejects.toSatisfy(isExclusionsUnavailable);
  });

  it("keeps the old fail-open behaviour under dry-run, so local work is unaffected", async () => {
    await expect(loadExcludedPatientIds(SITE)).resolves.toEqual(new Set());
  });

  it("a readable table is not affected either way", async () => {
    h.down = false;
    goLive();
    await expect(loadExcludedPatientIds(SITE)).resolves.toEqual(new Set());
  });
});

describe("the outreach audience builder, driven for real", () => {
  it("LIVE + unreadable exclusions: NOBODY is enrolled, and Dentally is not even read", async () => {
    goLive();

    // The refusal currently surfaces as a throw. build.ts documents "Never throws",
    // so the graceful landing — catch it, return an unadvanced cursor, resume next
    // tick — is a handoff to the outreach lane. What must hold either way, and what
    // this pins, is that no patient reaches outreach_target: a build enrolment is
    // permanent, because sweepCampaign never re-checks the exclusion list.
    let thrown: unknown = null;
    await runOutreachBuildTick(campaign()).catch((err) => {
      thrown = err;
    });

    expect(h.inserts.flat(), "a patient who may be marked inactive was enrolled for good").toEqual([]);
    expect(h.apptCalls, "the build spent Dentally budget on an audience it must not build").toEqual([]);
    if (thrown !== null) expect(thrown).toSatisfy(isExclusionsUnavailable);
  });

  it("DRY-RUN + the same unreadable exclusions: today's behaviour is kept (proves the flag is the cause)", async () => {
    const result = await runOutreachBuildTick(campaign());

    expect(result.ok).toBe(true);
    expect(h.inserts.flat()).toContain("p-marked-inactive");
  });

  it("LIVE + a readable exclusion list: the build runs normally (proves the failure is the cause)", async () => {
    h.down = false;
    goLive();

    const result = await runOutreachBuildTick(campaign());

    expect(result.ok).toBe(true);
    expect(h.inserts.flat()).toContain("p-marked-inactive");
  });
});
