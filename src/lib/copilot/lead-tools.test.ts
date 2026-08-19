import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LEAD SIGHT: the co-pilot's three reads of the acquisition pipeline and its one
 * act.
 *
 * The repositories are stubbed, but stubbed FAITHFULLY: listResponses honours the
 * site scope, the band filter, the window and the bound, and listLeadsByIds
 * honours the site scope. A stub that ignored its arguments would let every scope
 * check in tools.ts be deleted with the suite still green — which is the one class
 * of bug that matters most here, because the scope IS the tenancy boundary.
 *
 * The send path is a spy, so this file cannot deliver a message even if the code
 * under test tried to. `toAddress` and `channelConsented` are the REAL ones
 * (importOriginal), so the consent rule the tools apply is the pipeline's own.
 */

import type { SpeedToLeadAttempt, SpeedToLeadLead } from "@/lib/speed-to-lead/types";
import type { AssessmentResponse } from "@/lib/smile-assessment/types";

// ---------------------------------------------------------------------------
// The world.
// ---------------------------------------------------------------------------

const SITES: Record<string, { id: string; name: string; clientId: string }> = {
  "site-cc": { id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" },
  "site-rv": { id: "site-rv", name: "N17 Dental", clientId: "vitality" },
  // A DIFFERENT PRACTICE. Nothing scoped to vitality may ever see this one.
  "site-other": { id: "site-other", name: "Rival Dental", clientId: "rival" },
};

const store = vi.hoisted(() => ({
  responses: [] as unknown[],
  leads: [] as unknown[],
  attempts: [] as unknown[],
  logged: [] as Record<string, unknown>[],
  systemOn: true,
  campaign: null as Record<string, unknown> | null,
  scan: { rows: [] as unknown[], truncated: false },
  scanThrows: null as "missing-table" | null,
  contactCalls: [] as unknown[],
  contactBehaviour: "sends" as "sends" | "throws" | "retires" | "silent" | "delivery-failed",
  claimWins: true,
  stageWrites: [] as { id: string; stage: string }[],
  // Recorded so the tests can assert WHAT was asked for, not only what came back.
  responseQueries: [] as Record<string, unknown>[],
  leadQueries: [] as Record<string, unknown>[],
  leadsByIdQueries: [] as Record<string, unknown>[],
  campaignQueries: [] as { clientId: string; slug: string }[],
  scanQueries: [] as Record<string, unknown>[],
}));

// `@/lib/speed-to-lead/contact` is loaded for real below (so the consent rule the
// tools apply is the pipeline's own), and it opens with `import "server-only"` — a
// Next.js marker package that is not installed here and that vitest cannot resolve
// through a mock factory's import. Stubbing it to an empty module is exactly what
// it is at runtime on the server: nothing.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: async (a: Record<string, unknown>) => {
    store.logged.push(a);
  },
}));

vi.mock("@/lib/mock", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) => (id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) => (id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));

vi.mock("@/lib/dentally/read", () => ({
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: vi.fn(),
}));

vi.mock("@/lib/systems/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemEnabled: async () => store.systemOn,
}));

// --- the assessment side ---------------------------------------------------

vi.mock("@/lib/smile-assessment/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listResponses: async (args: { siteIds: string[]; bands?: string[]; sinceIso?: string; limit?: number }) => {
    store.responseQueries.push(args);
    let rows = (store.responses as AssessmentResponse[]).filter((r) => args.siteIds.includes(r.siteId));
    if (args.bands && args.bands.length > 0) rows = rows.filter((r) => args.bands!.includes(r.band));
    if (args.sinceIso) rows = rows.filter((r) => r.createdAt >= args.sinceIso!);
    rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, args.limit ?? 200);
  },
}));

vi.mock("@/lib/smile-assessment/campaign-repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCampaignBySlug: async (clientId: string, slug: string) => {
    store.campaignQueries.push({ clientId, slug });
    const c = store.campaign;
    if (!c) return null;
    return c.clientId === clientId && c.slug === slug ? c : null;
  },
}));

vi.mock("@/lib/smile-assessment/step-events-repository", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Missing = actual.StepEventTableMissingError as new () => Error;
  return {
    ...actual,
    readStepEvents: async (args: Record<string, unknown>) => {
      store.scanQueries.push(args);
      if (store.scanThrows === "missing-table") throw new Missing();
      return store.scan;
    },
  };
});

// --- the leads side --------------------------------------------------------

vi.mock("@/lib/speed-to-lead/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // COPIES, like the real mappers: rowToLead builds a fresh object per read, so a
  // caller holding a lead does NOT see a later stage change made by someone else.
  // Handing back the stored object instead would hide exactly the bug this tool
  // could have — passing a lead already flipped to 'contacting' into contactLead.
  getLead: async (id: string) => {
    const found = (store.leads as SpeedToLeadLead[]).find((l) => l.id === id);
    return found ? { ...found } : null;
  },
  listLeads: async (args: { siteIds: string[]; stages?: string[]; sinceIso?: string; limit?: number }) => {
    store.leadQueries.push(args);
    let rows = (store.leads as SpeedToLeadLead[]).filter((l) => args.siteIds.includes(l.siteId));
    if (args.stages && args.stages.length > 0) rows = rows.filter((l) => args.stages!.includes(l.stage));
    if (args.sinceIso) rows = rows.filter((l) => l.createdAt >= args.sinceIso!);
    rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, args.limit ?? 200).map((l) => ({ ...l }));
  },
  listLeadsByIds: async (args: { siteIds: string[]; ids: string[] }) => {
    store.leadsByIdQueries.push(args);
    if (args.siteIds.length === 0 || args.ids.length === 0) return [];
    // FAITHFUL: the real query filters on BOTH, so the stub must too, or a test
    // asserting "another site's lead is invisible" would pass with no scope at all.
    return (store.leads as SpeedToLeadLead[])
      .filter((l) => args.siteIds.includes(l.siteId) && args.ids.includes(l.id))
      .map((l) => ({ ...l }));
  },
  listAttemptsForLeads: async (ids: string[]) =>
    (store.attempts as SpeedToLeadAttempt[]).filter((a) => ids.includes(a.leadId)),
  claimLeadFromStage: async (id: string, from: string) => {
    if (!store.claimWins) return false;
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === id);
    if (!l || l.stage !== from) return false;
    l.stage = "contacting";
    return true;
  },
  setLeadStage: async (id: string, stage: string) => {
    store.stageWrites.push({ id, stage });
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === id);
    if (l) l.stage = stage as SpeedToLeadLead["stage"];
  },
}));

vi.mock("@/lib/speed-to-lead/contact", async (importOriginal) => ({
  // toAddress and channelConsented stay REAL, so the rule the tools apply is the
  // pipeline's own rather than a second copy written for the test.
  ...(await importOriginal<Record<string, unknown>>()),
  contactLead: async (lead: SpeedToLeadLead) => {
    store.contactCalls.push({ id: lead.id, stage: lead.stage });
    const row = (store.leads as SpeedToLeadLead[]).find((x) => x.id === lead.id);
    switch (store.contactBehaviour) {
      case "throws":
        throw new Error("provider exploded");
      case "retires":
        if (row) row.stage = "lost";
        return;
      case "silent":
        // The retry-cap path: contactLead returns having written nothing at all,
        // leaving the lead claimed at 'contacting'.
        return;
      case "delivery-failed":
        store.attempts.push(makeAttempt({ id: `att-new-${lead.id}`, leadId: lead.id, status: "failed", createdAt: "2026-08-18T12:00:00.000Z" }));
        return;
      default:
        store.attempts.push(makeAttempt({ id: `att-new-${lead.id}`, leadId: lead.id, status: "sent", createdAt: "2026-08-18T12:00:00.000Z" }));
        if (row) row.stage = "contacted";
        return;
    }
  },
}));

import { makeCopilotDispatch, COPILOT_TOOLS } from "./tools";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-18T12:00:00.000Z");
const TODAY = "2026-08-18";
const YESTERDAY = "2026-08-17";

function makeResponse(over: Partial<AssessmentResponse> = {}): AssessmentResponse {
  return {
    id: "resp-1",
    siteId: "site-cc",
    leadId: null,
    campaignId: null,
    firstName: "Amara",
    email: null,
    phone: "+447700900001",
    channel: "sms",
    treatmentInterest: "Invisalign",
    responses: {},
    rawScore: 80,
    band: "high",
    source: "smile-assessment",
    createdAt: `${TODAY}T09:00:00.000Z`,
    ...over,
  };
}

function makeLead(over: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Amara Osei",
    email: null,
    phone: "+447700900001",
    channel: "sms",
    treatmentInterest: "Invisalign",
    source: "smile-assessment",
    score: 80,
    stage: "new",
    consent: { sms: true },
    createdAt: `${TODAY}T09:00:00.000Z`,
    firstResponseAt: null,
    conversationId: null,
    updatedAt: `${TODAY}T09:00:00.000Z`,
    nurtureStep: 0,
    nurtureNextAt: null,
    ...over,
  };
}

function makeAttempt(over: Partial<SpeedToLeadAttempt> = {}): SpeedToLeadAttempt {
  return {
    id: "att-1",
    leadId: "lead-1",
    channel: "sms",
    toAddress: "+447700900001",
    body: "hello",
    status: "sent",
    provider: "twilio",
    providerMessageId: "SM1",
    createdAt: `${TODAY}T09:05:00.000Z`,
    ...over,
  };
}

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");
const allSites = makeCopilotDispatch(["site-cc", "site-rv"], "vitality", "tester");

async function call(tool: string, input: Record<string, unknown> = {}) {
  return JSON.parse(await dispatch(tool, input));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.responses = [];
  store.leads = [];
  store.attempts = [];
  store.logged = [];
  store.systemOn = true;
  store.campaign = null;
  store.scan = { rows: [], truncated: false };
  store.scanThrows = null;
  store.contactCalls = [];
  store.contactBehaviour = "sends";
  store.claimWins = true;
  store.stageWrites = [];
  store.responseQueries = [];
  store.leadQueries = [];
  store.leadsByIdQueries = [];
  store.campaignQueries = [];
  store.scanQueries = [];
  delete process.env.MESSAGING_DRY_RUN;
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// The tools exist and are shaped like the rest.
// ===========================================================================

describe("registration", () => {
  it("registers all four tools with schemas", () => {
    for (const n of ["list_recent_assessment_leads", "list_speed_to_lead", "assessment_dropoff_summary", "nudge_lead"]) {
      const tool = COPILOT_TOOLS.find((t) => t.name === n);
      expect(tool, `${n} is not registered`).toBeDefined();
      expect((tool!.description ?? "").length).toBeGreaterThan(40);
      expect(tool!.input_schema.type).toBe("object");
    }
  });

  it("makes only nudge_lead a confirmed step, and requires the lead id", () => {
    const nudge = COPILOT_TOOLS.find((t) => t.name === "nudge_lead")!;
    expect(nudge.input_schema.required).toEqual(["leadId"]);
    expect(nudge.description).toMatch(/TWO STEPS/);
    // The three reads must NOT advertise a confirm step: a read the model thinks
    // needs confirming is a read it will not do.
    for (const n of ["list_recent_assessment_leads", "list_speed_to_lead", "assessment_dropoff_summary"]) {
      const props = COPILOT_TOOLS.find((t) => t.name === n)!.input_schema.properties as Record<string, unknown>;
      expect(props.confirm).toBeUndefined();
    }
  });
});

// ===========================================================================
// list_recent_assessment_leads
// ===========================================================================

describe("list_recent_assessment_leads", () => {
  it("answers 'who filled it in today' with today alone", async () => {
    store.responses = [
      makeResponse({ id: "r-today", firstName: "Amara", createdAt: `${TODAY}T09:00:00.000Z` }),
      makeResponse({ id: "r-yesterday", firstName: "Ben", createdAt: `${YESTERDAY}T09:00:00.000Z` }),
    ];
    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(out.total).toBe(1);
    expect(out.leads.map((l: { name: string }) => l.name)).toEqual(["Amara"]);
    expect(out.window).toEqual({ days: 1, from: TODAY, to: TODAY });
  });

  it("defaults to the past week and buckets by day, zeros included", async () => {
    store.responses = [
      makeResponse({ id: "r1", createdAt: `${TODAY}T09:00:00.000Z` }),
      makeResponse({ id: "r2", createdAt: `${TODAY}T10:00:00.000Z` }),
      makeResponse({ id: "r3", createdAt: "2026-08-15T10:00:00.000Z" }),
    ];
    const out = await call("list_recent_assessment_leads");
    expect(out.window.days).toBe(7);
    expect(out.total).toBe(3);
    expect(out.byDay).toHaveLength(7);
    expect(out.byDay[0]).toEqual({ day: TODAY, count: 2 });
    expect(out.byDay[1]).toEqual({ day: YESTERDAY, count: 0 });
  });

  it("says whether each person has actually been contacted", async () => {
    store.leads = [makeLead({ id: "lead-1", firstResponseAt: `${TODAY}T09:02:00.000Z`, stage: "contacted" })];
    store.responses = [
      makeResponse({ id: "r-bridged", firstName: "Amara", leadId: "lead-1" }),
      makeResponse({ id: "r-nurture", firstName: "Ben", band: "low", leadId: null }),
    ];
    const out = await call("list_recent_assessment_leads", { days: 1 });
    const amara = out.leads.find((l: { name: string }) => l.name === "Amara");
    const ben = out.leads.find((l: { name: string }) => l.name === "Ben");
    expect(amara.inLeadsPipeline).toBe(true);
    expect(amara.contacted).toBe(true);
    expect(amara.stage).toBe("contacted");
    // The medium/low band is recorded for nurture and NOBODY was contacted. That
    // must read as a plain false with a reason, never as an absence the model can
    // fill in with an optimistic guess.
    expect(ben.inLeadsPipeline).toBe(false);
    expect(ben.contacted).toBe(false);
    expect(ben.note).toMatch(/nobody has been contacted/i);
  });

  it("hands over what the person actually SAID, not just their score", async () => {
    // The band is a number; the answers are the reason an owner would ring them.
    // They come through the shared answerLines projection, which is deliberately
    // label-based (our own question bank, never patient-typed text) and skips the
    // funding question outright.
    store.responses = [
      makeResponse({
        responses: { readiness: "book_now", treatment: "invisalign", budget: "plan" },
      }),
    ];
    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(out.leads[0].answers).toEqual(["When you find the right fit, how ready are you to book? => Ready to book a consultation now"]);
    expect(out.leads[0].band).toBe("high");
    expect(out.leads[0].treatmentInterest).toBe("Invisalign");
  });

  it("reports an uncontacted lead's wait rather than leaving it to be inferred", async () => {
    store.leads = [makeLead({ id: "lead-1", createdAt: `${TODAY}T11:30:00.000Z` })];
    store.responses = [makeResponse({ leadId: "lead-1", createdAt: `${TODAY}T11:30:00.000Z` })];
    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(out.leads[0].contacted).toBe(false);
    expect(out.leads[0].waitingMinutes).toBe(30);
  });

  // --- scope ---------------------------------------------------------------

  it("only reads the sites in view", async () => {
    store.responses = [
      makeResponse({ id: "r-cc", firstName: "Amara", siteId: "site-cc" }),
      makeResponse({ id: "r-rv", firstName: "Sister", siteId: "site-rv" }),
      makeResponse({ id: "r-other", firstName: "Rival", siteId: "site-other" }),
    ];
    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(out.leads.map((l: { name: string }) => l.name)).toEqual(["Amara"]);
    expect(store.responseQueries[0].siteIds).toEqual(["site-cc"]);

    // Widening the view widens the answer, and never past the client.
    const wide = JSON.parse(await allSites("list_recent_assessment_leads", { days: 1 }));
    expect(wide.leads.map((l: { name: string }) => l.name).sort()).toEqual(["Amara", "Sister"]);
  });

  it("cannot read a lead outside the scope, even when a response points straight at one", async () => {
    // The lead id is a foreign key on a row we ARE allowed to read. If the lead
    // lookup were not scoped, this is exactly how another practice's enquiry -
    // their patient's name, stage and contact history - would arrive in an answer
    // scoped to N15.
    store.leads = [makeLead({ id: "lead-foreign", siteId: "site-other", name: "Rival Patient", stage: "booked" })];
    store.responses = [makeResponse({ id: "r1", firstName: "Amara", leadId: "lead-foreign" })];

    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(store.leadsByIdQueries[0].siteIds).toEqual(["site-cc"]);
    const row = out.leads[0];
    expect(row.stage).toBeNull();
    expect(row.contacted).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Rival Patient");
    expect(JSON.stringify(out)).not.toContain("booked");
  });

  // --- arguments -----------------------------------------------------------

  it("filters by band, and refuses a band it does not recognise", async () => {
    store.responses = [
      makeResponse({ id: "r-high", firstName: "Amara", band: "high" }),
      makeResponse({ id: "r-low", firstName: "Ben", band: "low" }),
    ];
    const high = await call("list_recent_assessment_leads", { days: 1, band: "high" });
    expect(high.leads.map((l: { name: string }) => l.name)).toEqual(["Amara"]);
    expect(store.responseQueries[0].bands).toEqual(["high"]);

    const bad = await call("list_recent_assessment_leads", { days: 1, band: "hot" });
    expect(bad.error).toContain("hot");
    expect(bad.leads).toBeUndefined();
  });

  it("refuses an out-of-range window WITHOUT reading anything", async () => {
    const out = await call("list_recent_assessment_leads", { days: 4000 });
    expect(out.error).toMatch(/between 1 and 90/);
    expect(store.responseQueries).toHaveLength(0);
  });

  it("says the list may be incomplete when it filled the bound", async () => {
    store.responses = Array.from({ length: 100 }, (_, i) =>
      makeResponse({ id: `r-${i}`, createdAt: `${TODAY}T09:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    const out = await call("list_recent_assessment_leads", { days: 1 });
    expect(out.truncated).toBe(true);

    store.responses = store.responses.slice(0, 5);
    const small = await call("list_recent_assessment_leads", { days: 1 });
    expect(small.truncated).toBe(false);
  });

  it("asks the database for the window, with a day of slack for the London boundary", async () => {
    await call("list_recent_assessment_leads", { days: 1 });
    // Today is the 18th; the query reaches back to the 17th at UTC midnight so a
    // 00:30-London submission (23:30 UTC on the 17th) is inside it.
    expect(store.responseQueries[0].sinceIso).toBe("2026-08-17T00:00:00.000Z");
  });
});

// ===========================================================================
// list_speed_to_lead
// ===========================================================================

describe("list_speed_to_lead", () => {
  it("shows only live enquiries by default, and everything on request", async () => {
    store.leads = [
      makeLead({ id: "l-new", name: "Waiting", stage: "new" }),
      makeLead({ id: "l-booked", name: "Booked", stage: "booked" }),
      makeLead({ id: "l-done", name: "Nurtured", stage: "nurture_done" }),
    ];
    const open = await call("list_speed_to_lead");
    expect(open.leads.map((l: { name: string }) => l.name)).toEqual(["Waiting"]);
    expect(store.leadQueries[0].stages).toEqual(["new", "contacting", "contacted", "qualifying"]);

    const all = await call("list_speed_to_lead", { filter: "all" });
    expect(all.leads).toHaveLength(3);
    expect(store.leadQueries[1].stages).toBeUndefined();
  });

  it("names the source in plain English, abandoned bookings included", async () => {
    store.leads = [
      makeLead({ id: "l1", name: "Abandoned", source: "abandoned-booking" }),
      makeLead({ id: "l2", name: "Campaign", source: "smile:invisalign-2026", createdAt: `${TODAY}T08:00:00.000Z` }),
      makeLead({ id: "l3", name: "Missed", source: "missed-call", createdAt: `${TODAY}T07:00:00.000Z` }),
    ];
    const out = await call("list_speed_to_lead");
    const byName = Object.fromEntries(out.leads.map((l: { name: string; source: string }) => [l.name, l.source]));
    expect(byName.Abandoned).toBe("Abandoned booking");
    expect(byName.Campaign).toBe("Smile Assessment · invisalign-2026");
    expect(byName.Missed).toBe("Missed call");
    // The raw value is kept too, so nothing has to be reverse-engineered from a label.
    expect(out.leads.find((l: { name: string }) => l.name === "Abandoned").sourceRaw).toBe("abandoned-booking");
  });

  it("reports the attempt state, taking 'last' from the newest attempt", async () => {
    store.leads = [makeLead({ id: "lead-1", stage: "contacted", firstResponseAt: `${TODAY}T09:05:00.000Z` })];
    store.attempts = [
      // Deliberately out of order: the batched read hands back one flat list.
      makeAttempt({ id: "a2", status: "sent", createdAt: `${TODAY}T10:00:00.000Z` }),
      makeAttempt({ id: "a1", status: "failed", createdAt: `${TODAY}T09:00:00.000Z` }),
    ];
    const out = await call("list_speed_to_lead");
    expect(out.leads[0].attempts).toMatchObject({ total: 2, failed: 1, lastStatus: "sent" });
    expect(out.leads[0].contacted).toBe(true);
    expect(out.leads[0].waitingMinutes).toBeNull();
  });

  it("flags a lead nobody could nudge before the owner tries", async () => {
    store.leads = [
      makeLead({ id: "l-ok", name: "Fine" }),
      makeLead({ id: "l-noconsent", name: "NoConsent", consent: {}, createdAt: `${TODAY}T08:00:00.000Z` }),
      makeLead({ id: "l-noaddress", name: "NoAddress", phone: null, createdAt: `${TODAY}T07:00:00.000Z` }),
    ];
    const out = await call("list_speed_to_lead");
    const byName = Object.fromEntries(out.leads.map((l: Record<string, unknown>) => [l.name, l]));
    expect(byName.Fine.contactable).toBe(true);
    expect(byName.NoConsent.contactable).toBe(false);
    expect(byName.NoConsent.consentedOnChannel).toBe(false);
    expect(byName.NoAddress.contactable).toBe(false);
    expect(byName.NoAddress.hasContactDetails).toBe(false);
  });

  it("returns the id nudge_lead takes, so nothing has to be invented", async () => {
    store.leads = [makeLead({ id: "lead-abc" })];
    const out = await call("list_speed_to_lead");
    expect(out.leads[0].id).toBe("lead-abc");
  });

  it("stays inside the sites in view", async () => {
    store.leads = [
      makeLead({ id: "l-cc", name: "Ours", siteId: "site-cc" }),
      makeLead({ id: "l-other", name: "Theirs", siteId: "site-other" }),
    ];
    const out = await call("list_speed_to_lead");
    expect(out.leads.map((l: { name: string }) => l.name)).toEqual(["Ours"]);
    expect(store.leadQueries[0].siteIds).toEqual(["site-cc"]);
    expect(JSON.stringify(out)).not.toContain("Theirs");
  });

  it("has NO default window: the oldest untouched lead is the point", async () => {
    store.leads = [makeLead({ id: "l-ancient", name: "Ancient", createdAt: "2025-01-01T09:00:00.000Z" })];
    const out = await call("list_speed_to_lead");
    expect(store.leadQueries[0].sinceIso).toBeUndefined();
    expect(out.leads.map((l: { name: string }) => l.name)).toEqual(["Ancient"]);
  });

  it("narrows to a window when one is asked for", async () => {
    store.leads = [
      makeLead({ id: "l-today", name: "Today" }),
      makeLead({ id: "l-old", name: "Old", createdAt: "2026-08-01T09:00:00.000Z" }),
    ];
    const out = await call("list_speed_to_lead", { days: 1 });
    expect(out.leads.map((l: { name: string }) => l.name)).toEqual(["Today"]);
    expect(store.leadQueries[0].sinceIso).toBe("2026-08-17T00:00:00.000Z");
  });

  it("refuses a bad filter or a bad limit, and reads nothing", async () => {
    expect((await call("list_speed_to_lead", { filter: "everything" })).error).toContain("everything");
    expect((await call("list_speed_to_lead", { limit: 5000 })).error).toMatch(/limit must be/);
    expect(store.leadQueries).toHaveLength(0);
  });

  it("honours the limit and says when it filled it", async () => {
    store.leads = Array.from({ length: 6 }, (_, i) =>
      makeLead({ id: `l-${i}`, createdAt: `${TODAY}T0${i}:00:00.000Z` }),
    );
    const out = await call("list_speed_to_lead", { limit: 3 });
    expect(out.leads).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });
});

// ===========================================================================
// assessment_dropoff_summary
// ===========================================================================

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: "site-cc",
    slug: "invisalign-2026",
    name: "Invisalign 2026",
    headline: "Straighten your smile",
    intro: "Two minutes",
    flow: null,
    flowVersion: 3,
    ...over,
  };
}

/** Sessions reaching steps 0,1,2 — 4, then 2, then 1. */
const SCAN_ROWS = [
  { stepIndex: 0, nonce: "a" },
  { stepIndex: 0, nonce: "b" },
  { stepIndex: 0, nonce: "c" },
  { stepIndex: 0, nonce: "d" },
  { stepIndex: 1, nonce: "a" },
  { stepIndex: 1, nonce: "b" },
  { stepIndex: 2, nonce: "a" },
];

describe("assessment_dropoff_summary", () => {
  it("gives the per-step funnel with the drop between each pair", async () => {
    store.campaign = campaign();
    store.scan = { rows: SCAN_ROWS, truncated: false };
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(out.found).toBe(true);
    expect(out.sessions).toBe(4);
    expect(out.steps.map((s: { views: number }) => s.views)).toEqual([4, 2, 1]);
    expect(out.steps[0].dropOffPct).toBeNull(); // nothing before the first screen
    expect(out.steps[1].dropOffPct).toBe(50);
    expect(out.completionPct).toBe(25);
  });

  it("labels the bars 'Step N' when the funnel's own wording is not available", async () => {
    // The same fallback the on-screen chart uses, so the co-pilot and the panel
    // name the same bar the same way.
    store.campaign = campaign({ flow: null });
    store.scan = { rows: SCAN_ROWS, truncated: false };
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(out.steps.map((s: { label: string }) => s.label)).toEqual(["Step 1", "Step 2", "Step 3"]);
  });

  it("does NOT label an older version with today's questions", async () => {
    // A campaign row stores ONE funnel. Numbering an older version with the graph
    // in hand would put today's wording on bars those events never came from.
    const { buildScratchFlow } = await import("@/lib/smile-assessment/flow-templates");
    store.campaign = campaign({ flow: buildScratchFlow(), flowVersion: 3 });
    store.scan = { rows: SCAN_ROWS, truncated: false };

    const current = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(current.isCurrentVersion).toBe(true);
    const older = await call("assessment_dropoff_summary", { slug: "invisalign-2026", flowVersion: 2 });
    expect(older.isCurrentVersion).toBe(false);
    expect(older.steps.every((s: { label: string }) => /^Step \d+$/.test(s.label))).toBe(true);
    expect(store.scanQueries[1].flowVersion).toBe(2);
  });

  it("scopes the campaign lookup to THIS practice", async () => {
    // getCampaignBySlug is client-keyed, and this is the assertion that the key
    // passed is the co-pilot's own client and not something from the model.
    store.campaign = campaign({ clientId: "rival" });
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(store.campaignQueries[0]).toEqual({ clientId: "vitality", slug: "invisalign-2026" });
    expect(out.found).toBe(false);
    expect(store.scanQueries).toHaveLength(0);
  });

  it("names the site the assessment belongs to", async () => {
    store.campaign = campaign({ siteId: "site-rv" });
    store.scan = { rows: SCAN_ROWS, truncated: false };
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(out.assessment.site).toBe("N17 Dental");
  });

  it("asks for the slug rather than guessing one", async () => {
    const out = await call("assessment_dropoff_summary", {});
    expect(out.error).toMatch(/slug/i);
    expect(store.campaignQueries).toHaveLength(0);
  });

  it("refuses an absurd flowVersion instead of handing it to Postgres", async () => {
    store.campaign = campaign();
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026", flowVersion: 1e20 });
    expect(out.error).toMatch(/flowVersion/);
    expect(store.scanQueries).toHaveLength(0);
  });

  it("refuses a window past a year", async () => {
    store.campaign = campaign();
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026", days: 400 });
    expect(out.error).toMatch(/between 1 and 365/);
    expect(store.scanQueries).toHaveLength(0);
  });

  it("says the telemetry table is missing rather than reporting no traffic", async () => {
    // "0 sessions" would tell an owner nobody uses their funnel.
    store.campaign = campaign();
    store.scanThrows = "missing-table";
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(out.sessions).toBeUndefined();
    expect(out.error).toBeTruthy();
    expect(out.note).toMatch(/not report it as zero/i);
  });

  it("passes a truncated scan through rather than presenting a partial tally as whole", async () => {
    store.campaign = campaign();
    store.scan = { rows: SCAN_ROWS, truncated: true };
    const out = await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(out.truncated).toBe(true);
  });
});

// ===========================================================================
// nudge_lead
// ===========================================================================

describe("nudge_lead: the read-back", () => {
  beforeEach(() => {
    store.leads = [makeLead({ id: "lead-1", createdAt: `${TODAY}T11:00:00.000Z` })];
  });

  it("sends NOTHING and claims nothing without confirm", async () => {
    const out = await call("nudge_lead", { leadId: "lead-1" });
    expect(out.sent).toBe(false);
    expect(out.preview).toBe(true);
    expect(store.contactCalls).toHaveLength(0);
    expect(store.stageWrites).toHaveLength(0);
    expect((store.leads as SpeedToLeadLead[])[0].stage).toBe("new");
  });

  it("reads back who they are, where they came from and how long they have waited", async () => {
    const out = await call("nudge_lead", { leadId: "lead-1" });
    expect(out.patient).toBe("Amara Osei");
    expect(out.source).toBe("Smile Assessment");
    expect(out.waitingMinutes).toBe(60);
    expect(out.site).toBe("N15 Vitality Dental");
    expect(out.note).toMatch(/no message has gone out yet/i);
  });

  it("reads back what has already been tried, failures named", async () => {
    store.attempts = [
      makeAttempt({ id: "a1", status: "failed", createdAt: `${TODAY}T09:00:00.000Z` }),
      makeAttempt({ id: "a2", status: "failed", createdAt: `${TODAY}T10:00:00.000Z` }),
    ];
    const out = await call("nudge_lead", { leadId: "lead-1" });
    expect(out.attempts).toMatchObject({ total: 2, failed: 2 });
    expect(out.note).toMatch(/2 of which failed/);
  });
});

describe("nudge_lead: the boundary", () => {
  it("treats another practice's lead exactly like one that does not exist", async () => {
    // getLead is keyed on the id alone. Any difference between these two answers
    // would make the co-pilot an oracle for whether an id exists somewhere in the
    // platform, and would leak the other practice's site and patient name.
    store.leads = [makeLead({ id: "lead-foreign", siteId: "site-other", name: "Rival Patient" })];
    const foreign = await call("nudge_lead", { leadId: "lead-foreign" });
    const missing = await call("nudge_lead", { leadId: "lead-nope" });
    expect(foreign).toEqual(missing);
    expect(foreign.error).toBe("I could not find a lead with that id.");
    expect(store.contactCalls).toHaveLength(0);
    expect(JSON.stringify(foreign)).not.toContain("Rival");
  });

  it("records the cross-tenant attempt without copying the other practice's data into our audit", async () => {
    store.leads = [makeLead({ id: "lead-foreign", siteId: "site-other", name: "Rival Patient" })];
    await call("nudge_lead", { leadId: "lead-foreign", confirm: true });
    const row = store.logged.find((l) => l.status === "blocked:out_of_tenant");
    expect(row).toBeDefined();
    expect(row!.clientId).toBe("vitality");
    expect(row!.siteId).toBeNull();
    expect(row!.targetName).toBeNull();
    expect(store.contactCalls).toHaveLength(0);
  });

  it("refuses a sister site that is not in view, and says which site it is", async () => {
    store.leads = [makeLead({ id: "lead-rv", siteId: "site-rv", name: "Sister Site Lead" })];
    const out = await call("nudge_lead", { leadId: "lead-rv", confirm: true });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("out_of_scope");
    expect(out.message).toContain("N17 Dental");
    expect(store.contactCalls).toHaveLength(0);

    // ...and it works once that site IS in view: the refusal is about scope, not
    // about the lead.
    const wide = JSON.parse(await allSites("nudge_lead", { leadId: "lead-rv" }));
    expect(wide.preview).toBe(true);
  });

  it("refuses when Speed-to-lead is switched off", async () => {
    store.leads = [makeLead({ id: "lead-1" })];
    store.systemOn = false;
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.reason).toBe("system_off");
    expect(store.contactCalls).toHaveLength(0);
    expect(store.logged.some((l) => l.status === "blocked:system_off")).toBe(true);
  });

  it("refuses a booked or a lost lead, with the right reason for each", async () => {
    store.leads = [
      makeLead({ id: "lead-booked", stage: "booked" }),
      makeLead({ id: "lead-lost", stage: "lost" }),
    ];
    const booked = await call("nudge_lead", { leadId: "lead-booked", confirm: true });
    const lost = await call("nudge_lead", { leadId: "lead-lost", confirm: true });
    expect(booked.reason).toBe("stage");
    expect(booked.message).toMatch(/already booked/i);
    expect(lost.message).toMatch(/closed as lost/i);
    expect(store.contactCalls).toHaveLength(0);
    expect(store.logged.map((l) => l.status)).toEqual(["blocked:stage_booked", "blocked:stage_lost"]);
  });

  it("refuses an unconsented lead WITHOUT retiring them", async () => {
    // contactLead's answer to "no consent" is to close the lead as lost. That is
    // right for an automated sweep and wrong as the silent result of an owner
    // saying "yes, text them": they asked for a message, not for the enquiry to be
    // closed. So the refusal happens here, and the lead stays where the worklist
    // can still see it.
    store.leads = [makeLead({ id: "lead-1", consent: {} })];
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.reason).toBe("no_consent");
    expect(store.contactCalls).toHaveLength(0);
    expect(store.stageWrites).toHaveLength(0);
    expect((store.leads as SpeedToLeadLead[])[0].stage).toBe("new");
    expect(store.logged.some((l) => l.status === "blocked:no_consent")).toBe(true);
  });

  it("refuses a lead with nothing to send to", async () => {
    store.leads = [makeLead({ id: "lead-1", phone: null, email: null })];
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.reason).toBe("no_destination");
    expect(store.contactCalls).toHaveLength(0);
  });

  it("asks for an id rather than inventing one", async () => {
    const out = await call("nudge_lead", {});
    expect(out.error).toMatch(/never invent/i);
    expect(store.contactCalls).toHaveLength(0);
  });
});

describe("nudge_lead: the send", () => {
  beforeEach(() => {
    store.leads = [makeLead({ id: "lead-1" })];
  });

  it("claims the lead, re-fires the EXISTING contact path, and reports it sent", async () => {
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(store.contactCalls).toEqual([{ id: "lead-1", stage: "new" }]);
    expect(out.sent).toBe(true);
    expect(out.patient).toBe("Amara Osei");
    expect(store.logged.some((l) => l.status === "sent" && l.targetRef === "lead:lead-1")).toBe(true);
  });

  it("reports a dry run as a dry run", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.note).toMatch(/not delivered/i);
    expect(store.logged.some((l) => l.status === "dry_run")).toBe(true);
  });

  it("does not send a second message when a contact is already in flight", async () => {
    // The atomic claim is the only thing standing between a nudge and the SLA
    // sweep texting the same person twice.
    store.claimWins = false;
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.reason).toBe("in_progress");
    expect(store.contactCalls).toHaveLength(0);
    expect(store.logged.some((l) => l.status === "skipped:in_progress")).toBe(true);
  });

  it("succeeds for an ALREADY-CONTACTED lead, which is the whole point of a nudge", async () => {
    // first_response_at is stamped only once (so a resend cannot corrupt the SLA
    // metric), so a tool that watched that field would call every real nudge a
    // failure. The attempt ledger is what a resend always writes.
    store.leads = [makeLead({ id: "lead-1", stage: "contacted", firstResponseAt: `${TODAY}T09:05:00.000Z` })];
    store.attempts = [makeAttempt({ id: "a1", status: "sent" })];
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(true);
  });
});

describe("nudge_lead: when nothing actually went out", () => {
  beforeEach(() => {
    store.leads = [makeLead({ id: "lead-1" })];
  });

  it("does not claim a message was sent when the lead was retired as unreachable", async () => {
    store.contactBehaviour = "retires";
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("unreachable");
    expect(out.message).toMatch(/nothing was sent/i);
    expect(store.logged.some((l) => l.status === "retired:unreachable")).toBe(true);
  });

  it("does not claim a message was sent when the contact path wrote nothing", async () => {
    // The failed-attempt cap: contactLead declines to draft again and returns.
    store.contactBehaviour = "silent";
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("not_sent");
    expect(out.message).toMatch(/needs a person/i);
  });

  it("restores the original stage so a nudge cannot strand a lead at 'contacting'", async () => {
    store.contactBehaviour = "silent";
    await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect((store.leads as SpeedToLeadLead[])[0].stage).toBe("new");
    expect(store.stageWrites).toContainEqual({ id: "lead-1", stage: "new" });
  });

  it("does not claim a message was sent when delivery failed", async () => {
    store.contactBehaviour = "delivery-failed";
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("delivery_failed");
    expect(out.message).toMatch(/do not tell the owner they have been contacted/i);
    expect(store.logged.some((l) => l.status === "failed:not_delivered")).toBe(true);
  });

  it("reports a thrown contact honestly, restores the stage, and audits it", async () => {
    store.contactBehaviour = "throws";
    const out = await call("nudge_lead", { leadId: "lead-1", confirm: true });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("error");
    expect((store.leads as SpeedToLeadLead[])[0].stage).toBe("new");
    expect(store.logged.some((l) => l.status === "error:contact_failed")).toBe(true);
  });
});

// ===========================================================================
// The house rule the reads follow.
// ===========================================================================

describe("the reads are reads", () => {
  it("never send, never claim, and never write an audit row", async () => {
    // Every logCopilotAction call site in this file is a send, a launch, a publish
    // or a write; the existing read tools log nothing, and these follow that rule.
    store.responses = [makeResponse()];
    store.leads = [makeLead()];
    store.campaign = campaign();
    await call("list_recent_assessment_leads", { days: 1 });
    await call("list_speed_to_lead");
    await call("assessment_dropoff_summary", { slug: "invisalign-2026" });
    expect(store.logged).toHaveLength(0);
    expect(store.contactCalls).toHaveLength(0);
    expect(store.stageWrites).toHaveLength(0);
  });
});
