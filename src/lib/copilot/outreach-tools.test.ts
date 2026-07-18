import { describe, it, expect, vi, beforeEach } from "vitest";

// The co-pilot outreach tools, mirroring the send_sms two-step discipline: create_
// outreach_campaign builds a DRAFT and NEVER launches; launch_outreach_campaign reads
// back without confirm and only launches with confirm true, refusing when the campaign
// is not ready / has no angle / the outreach system is off. Repo/build/systems/Dentally
// are mocked so we test the branching deterministically.

type Campaign = {
  id: string;
  clientId: string;
  siteId: string;
  status: string;
  filters: Record<string, unknown>;
  messageAngle: string | null;
  messageAngleB?: string | null;
  practitionerName: string | null;
  dailyCap: number;
  counts?: Record<string, number> | null;
};

const store = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  updated: [] as { id: string; fields: Record<string, unknown> }[],
  logged: [] as Record<string, unknown>[],
  campaign: null as Campaign | null, // what getCampaign returns (for launch)
  isSystemEnabled: true,
  buildCounts: { matched: 5, excludedMissingData: 0 } as Record<string, number>,
  buildDone: true,
  buildStopped: null as "403" | "429" | null,
  buildOk: true,
  variantCounts: {
    a: { assigned: 20, sent: 18, replied: 3, booked: 1 },
    b: { assigned: 20, sent: 19, replied: 5, booked: 2 },
  },
}));

vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: (a: Record<string, unknown>) => {
    store.logged.push(a);
  },
}));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: async () => [{ id: "prac-1", name: "Dr Patel" }],
  dentallyReadKey: () => "test-key",
}));
vi.mock("@/lib/mock", () => ({ getSite: (id: string) => ({ id, name: id === "site-cc" ? "N15 Vitality Dental" : id }) }));
vi.mock("@/lib/mock/clients", () => ({
  getSites: (cid: string) =>
    cid === "vitality" ? [{ id: "site-cc", name: "N15 Vitality Dental" }, { id: "site-rv", name: "N17 Dental" }] : [],
}));
vi.mock("@/lib/outreach/repository", () => ({
  createCampaign: async (input: Record<string, unknown>) => {
    store.created.push(input);
    return {
      id: "camp-x",
      clientId: input.clientId,
      siteId: input.siteId,
      status: "draft",
      filters: input.filters ?? {},
      messageAngle: input.messageAngle ?? null,
      messageAngleB: input.messageAngleB ?? null,
      practitionerName: input.practitionerName ?? null,
      dailyCap: input.dailyCap ?? 25,
    };
  },
  getCampaign: async () => store.campaign,
  updateCampaign: async (id: string, fields: Record<string, unknown>) => {
    store.updated.push({ id, fields });
  },
  campaignStatusCounts: async () => ({ built: 42, contacted: 0, replied: 0, booked: 0 }),
  campaignVariantCounts: async () => store.variantCounts,
}));
vi.mock("@/lib/outreach/build", () => ({
  runOutreachBuildTick: async () => ({
    ok: store.buildOk,
    done: store.buildDone,
    stopped: store.buildStopped,
    counts: store.buildCounts,
    cursor: null,
  }),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.isSystemEnabled }));

import { makeCopilotDispatch } from "./tools";

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

function launchCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: "site-cc",
    status: "ready",
    filters: { treatmentContains: ["hygiene"], gender: "female" },
    messageAngle: "a hygiene visit",
    practitionerName: "Dr Patel",
    dailyCap: 25,
    ...over,
  };
}

beforeEach(() => {
  store.created = [];
  store.updated = [];
  store.logged = [];
  store.campaign = null;
  store.isSystemEnabled = true;
  store.buildCounts = { matched: 5, excludedMissingData: 0 };
  store.buildDone = true;
  store.buildStopped = null;
  store.buildOk = true;
});

describe("create_outreach_campaign", () => {
  it("creates a DRAFT, builds the list, and NEVER launches", async () => {
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit", treatmentContains: ["hygiene"] }),
    );
    expect(out.created).toBe(true);
    expect(out.launched).toBe(false);
    expect(out.campaignId).toBe("camp-x");
    expect(out.segment).toContain("hygiene");
    expect(out.matchedSoFar).toBe(5);
    expect(store.created).toHaveLength(1);
    // Never launches: no status:'running' write.
    expect(store.updated.some((u) => u.fields.status === "running")).toBe(false);
  });

  it("surfaces the SMS-contactable count honestly, not just the matched total (finding #2)", async () => {
    // 10 match the segment but only 7 have SMS consent; the read-back must say so, since
    // consent is applied at send time and the other 3 are counted but never texted.
    store.buildCounts = { matched: 10, contactable: 7, excludedMissingData: 0 };
    const out = JSON.parse(await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit" }));
    expect(out.matchedSoFar).toBe(10);
    expect(out.contactableSoFar).toBe(7);
    expect(out.note).toMatch(/7 have SMS consent/i);
  });

  it("reports how many records were excluded for missing age/gender when those filters are used", async () => {
    store.buildCounts = { matched: 8, excludedMissingData: 3 };
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", { messageAngle: "a check-up", gender: "female", ageMin: 25, ageMax: 35 }),
    );
    expect(out.excludedForMissingAgeOrGender).toBe(3);
    expect(out.segment).toContain("female patients");
    expect(out.segment).toContain("aged 25 to 35");
  });

  it("allows a list preview with NO message angle (no send intent)", async () => {
    const out = JSON.parse(await dispatch("create_outreach_campaign", { gender: "female", ageMin: 30, ageMax: 35 }));
    expect(out.created).toBe(true);
    expect(out.listPreview).toBe(true);
    expect(store.created[0].messageAngle).toBeNull();
  });

  it("rejects an invalid demographic filter", async () => {
    const out = JSON.parse(await dispatch("create_outreach_campaign", { messageAngle: "x", ageMin: 40, ageMax: 30 }));
    expect(out.created).toBe(false);
    expect(store.created).toHaveLength(0);
  });

  // Finding #5: the target site must stay within the co-pilot's VIEW SCOPE (siteIds =
  // ["site-cc"]), never every client site. site-rv is a real vitality site but is out
  // of scope, so it must be refused, not built.
  it("REFUSES a site outside the co-pilot's view scope, pointing at the selector (finding #5)", async () => {
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit", siteId: "site-rv" }),
    );
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/site selector|outside/i);
    expect(store.created).toHaveLength(0); // nothing built against the out-of-scope site
  });

  it("targets an explicit IN-scope site", async () => {
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit", siteId: "site-cc" }),
    );
    expect(out.created).toBe(true);
    expect(store.created[0].siteId).toBe("site-cc");
  });

  it("refuses an unknown site with a not-found message", async () => {
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit", siteId: "site-zzz" }),
    );
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/could not find/i);
    expect(store.created).toHaveLength(0);
  });

  // Finding #6: honour the build tick's ok/stopped, not just done. A Dentally 403/429
  // stop must be reported as a PAUSE, not "the count will keep climbing".
  it("reports a rate-limit PAUSE honestly, not as a healthy climb (finding #6)", async () => {
    store.buildDone = false;
    store.buildStopped = "429";
    const out = JSON.parse(await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit" }));
    expect(out.buildStatus).toBe("paused");
    expect(out.note).toMatch(/paused/i);
    expect(out.note).not.toMatch(/climbing/i);
  });

  it("still reports a genuinely running build as 'building' with the climbing note", async () => {
    store.buildDone = false;
    store.buildStopped = null; // clean, still-running tick
    const out = JSON.parse(await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit" }));
    expect(out.buildStatus).toBe("building");
    expect(out.note).toMatch(/climbing/i);
  });

  it("reports a FAILED build tick (!ok) as paused, never as building", async () => {
    store.buildOk = false;
    store.buildDone = false;
    const out = JSON.parse(await dispatch("create_outreach_campaign", { messageAngle: "a hygiene visit" }));
    expect(out.buildStatus).toBe("paused");
    expect(out.note).not.toMatch(/climbing/i);
  });
});

describe("launch_outreach_campaign (two-step, mirrors send_sms)", () => {
  it("reads back WITHOUT launching when confirm is absent", async () => {
    store.campaign = launchCampaign();
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1" }));
    expect(out.launched).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.matched).toBe(42);
    expect(out.segment).toContain("hygiene");
    expect(store.updated).toHaveLength(0);
  });

  it("does not launch with confirm false", async () => {
    store.campaign = launchCampaign();
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: false }));
    expect(out.launched).toBe(false);
    expect(store.updated).toHaveLength(0);
  });

  it("reads back the SMS-contactable count when the build recorded it (finding #2)", async () => {
    // campaignStatusCounts (mocked) reports 42 matched; the build recorded 30 with SMS
    // consent. The read-back must surface the reachable 30, not let 42 read as reachable.
    store.campaign = launchCampaign({ counts: { built: 42, contactable: 30 } });
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1" }));
    expect(out.preview).toBe(true);
    expect(out.matched).toBe(42);
    expect(out.contactable).toBe(30);
    expect(out.note).toMatch(/30 have SMS consent/i);
  });

  it("launches with confirm true when ready + angle + outreach ON", async () => {
    store.campaign = launchCampaign();
    store.isSystemEnabled = true;
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: true }));
    expect(out.launched).toBe(true);
    expect(store.updated).toContainEqual({ id: "camp-1", fields: { status: "running" } });
  });

  it("REFUSES to launch (confirm true) when the outreach system is OFF", async () => {
    store.campaign = launchCampaign();
    store.isSystemEnabled = false;
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: true }));
    expect(out.launched).toBe(false);
    expect(out.reason).toBe("outreach_off");
    expect(out.message).toMatch(/System controls/);
    expect(store.updated).toHaveLength(0);
  });

  it("refuses to launch (confirm true) a campaign with no message angle", async () => {
    store.campaign = launchCampaign({ messageAngle: null });
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: true }));
    expect(out.launched).toBe(false);
    expect(out.reason).toBe("no_angle");
    expect(store.updated).toHaveLength(0);
  });

  it("refuses to launch (confirm true) a campaign that is not ready", async () => {
    store.campaign = launchCampaign({ status: "building" });
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: true }));
    expect(out.launched).toBe(false);
    expect(out.reason).toBe("not_ready");
    expect(store.updated).toHaveLength(0);
  });

  it("will not act on another practice's campaign (IDOR guard)", async () => {
    store.campaign = launchCampaign({ clientId: "someone-else" });
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1", confirm: true }));
    expect(out.launched).toBe(false);
    expect(store.updated).toHaveLength(0);
  });
});

describe("two-message A/B", () => {
  it("create_outreach_campaign accepts a second angle and reads both back", async () => {
    const out = JSON.parse(
      await dispatch("create_outreach_campaign", {
        messageAngle: "a hygiene visit",
        messageAngleB: "time for your check-up",
        treatmentContains: ["hygiene"],
      }),
    );
    expect(out.created).toBe(true);
    // Stored on the campaign...
    expect(store.created[0].messageAngleB).toBe("time for your check-up");
    // ...and named in the read-back so the owner sees both messages.
    expect(out.messageAngle).toBe("a hygiene visit");
    expect(out.messageAngleB).toBe("time for your check-up");
    expect(out.abTest).toBe(true);
    // Honest framing: a test, never a claim of learning.
    expect(JSON.stringify(out).toLowerCase()).toContain("honest counting");
    expect(JSON.stringify(out).toLowerCase()).not.toContain("learn");
  });

  it("a second angle with no primary angle is ignored (a second message needs a first)", async () => {
    await dispatch("create_outreach_campaign", { messageAngleB: "time for your check-up" });
    expect(store.created[0].messageAngleB ?? null).toBeNull();
  });

  it("launch preview names both angles and reads back per-message counts", async () => {
    store.campaign = launchCampaign({ messageAngleB: "time for your check-up" });
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1" }));
    expect(out.launched).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.messageAngle).toBe("a hygiene visit");
    expect(out.messageAngleB).toBe("time for your check-up");
    // Honest per-message counts, straight from the variant read-back.
    expect(out.messagePerformance.messageA).toMatchObject({ sent: 18, replied: 3, booked: 1 });
    expect(out.messagePerformance.messageB).toMatchObject({ sent: 19, replied: 5, booked: 2 });
    // Nothing is launched at the preview step.
    expect(store.updated).toHaveLength(0);
  });

  it("a single-angle launch preview carries no per-message breakdown", async () => {
    store.campaign = launchCampaign(); // no messageAngleB
    const out = JSON.parse(await dispatch("launch_outreach_campaign", { campaignId: "camp-1" }));
    expect(out.preview).toBe(true);
    expect(out.messagePerformance).toBeUndefined();
    expect(out.messageAngleB).toBeUndefined();
  });
});
