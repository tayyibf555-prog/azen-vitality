// Targeting exclusion: a patient marked inactive / do_not_contact (platform admin
// override) is dropped from the outreach build BEFORE the expensive appointment read,
// even though Dentally still has them active. Uses the REAL prefilter/history matcher;
// only Dentally, the campaign repo and the override loader are doubled.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutreachCampaign } from "./types";

const h = vi.hoisted(() => ({
  apptCalls: [] as string[],
  inserts: [] as string[][],
  excluded: new Set<string>(),
}));

vi.mock("@/lib/dentally/read", () => ({
  dentallyFromEnv: () => ({
    listPatients: async ({ page }: { page: number }) =>
      page === 1
        ? {
            patients: [
              // Both are Dentally-ACTIVE with SMS consent and a recent matching visit -
              // the ONLY difference is the platform override on p-excl.
              { id: "p-excl", first_name: "Ex", last_name: "Cluded", mobile_phone: "07700900000", use_sms: true, active: true },
              { id: "p-ok", first_name: "O", last_name: "Kay", mobile_phone: "07700900001", use_sms: true, active: true },
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
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedPatientIds: async () => h.excluded,
}));
vi.mock("./repository", () => ({
  getCampaign: async () => null,
  updateCampaign: async () => {},
  insertTargets: async (targets: { patientId: string }[]) => {
    h.inserts.push(targets.map((t) => t.patientId));
    return targets.length;
  },
}));

import { runOutreachBuildTick, initBuildCursor } from "./build";

function campaign(): OutreachCampaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: "site-cc",
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

beforeEach(() => {
  h.apptCalls = [];
  h.inserts = [];
  h.excluded = new Set(["p-excl"]);
});

describe("outreach build override exclusion", () => {
  it("drops the overridden patient before the appointment read and never enrols them", async () => {
    await runOutreachBuildTick(campaign());
    const enrolled = h.inserts.flat();
    expect(enrolled).toContain("p-ok");
    expect(enrolled).not.toContain("p-excl");
    // Skipped BEFORE the expensive per-patient appointment read.
    expect(h.apptCalls).not.toContain("p-excl");
    expect(h.apptCalls).toContain("p-ok");
  });

  it("with no override set, the same patient enrols normally (proves the override is the cause)", async () => {
    h.excluded = new Set();
    await runOutreachBuildTick(campaign());
    const enrolled = h.inserts.flat();
    expect(enrolled).toEqual(expect.arrayContaining(["p-ok", "p-excl"]));
  });
});
