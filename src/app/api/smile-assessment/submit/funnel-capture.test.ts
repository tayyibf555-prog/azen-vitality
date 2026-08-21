import { describe, it, expect, vi, beforeEach } from "vitest";

// WHERE IN THE FUNNEL THE DETAILS WERE GIVEN (0094), at the moment of capture.
//
// The public progress endpoint's own gates live next door
// (funnel-progress/public-gates.test.ts). This file is about the OTHER half: the
// submit route deciding whether a position may be recorded at all, and what the two
// numbers are. Three properties, and each has a named test:
//
//   SERVER-DERIVED     N and M come from re-deriving the numbering off the
//                      campaign's OWN stored graph. The browser says one thing and
//                      one thing only — which SAVE of the funnel it walked.
//   VERSION-GATED      if the owner republished mid-session we can no longer
//                      measure the funnel this patient walked, so nothing is
//                      recorded. A blank is readable; a fraction from two versions
//                      is not.
//   NEVER COSTS AN ENQUIRY  the stamp is its own statement after the lead is
//                      committed, so a database without 0094 applied loses a
//                      progress number, never a patient.
//
// Every I/O seam is mocked; the REAL route handler, the REAL numbering and the REAL
// capture rules run.

const h = vi.hoisted(() => ({
  insertResponse: vi.fn(async (..._a: unknown[]) => ({ id: "resp-1" })),
  setResponseLead: vi.fn(async (..._a: unknown[]) => {}),
  countRecent: vi.fn(async (..._a: unknown[]) => 0 as number),
  insertLead: vi.fn(async (..._a: unknown[]) => ({
    id: "lead-new",
    channel: "sms",
    createdAt: "2026-01-01T00:00:10.000Z",
  })),
  findOpenLeadByAddress: vi.fn(async (..._a: unknown[]) => null as unknown),
  findEarlierOpenLead: vi.fn(async (..._a: unknown[]) => null as unknown),
  setLeadStage: vi.fn(async (..._a: unknown[]) => {}),
  stampLeadFunnelCapture: vi.fn(async (..._a: unknown[]) => true),
  contactLead: vi.fn(async (..._a: unknown[]) => {}),
  consumeBudget: vi.fn(async (..._a: unknown[]) => true),
  getActiveCampaignBySlug: vi.fn(async (..._a: unknown[]) => null as unknown),
  scoreAssessment: vi.fn((..._a: unknown[]) => ({ rawScore: 95, band: "high" as const })),
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
  isSystemEnabledForSend: vi.fn(async (..._a: unknown[]) => true),
  resolveMetaPixel: vi.fn(async (..._a: unknown[]) => ({
    enabled: false,
    pixelId: null as string | null,
    advancedMatching: false,
  })),
  sendAssessmentLeadEvent: vi.fn(async (..._a: unknown[]) => ({ sent: false, reason: "disabled" })),
}));

vi.mock("@/lib/smile-assessment/repository", () => ({
  insertResponse: h.insertResponse,
  setResponseLead: h.setResponseLead,
  countRecent: h.countRecent,
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  insertLead: h.insertLead,
  findOpenLeadByAddress: h.findOpenLeadByAddress,
  findEarlierOpenLead: h.findEarlierOpenLead,
  setLeadStage: h.setLeadStage,
  stampLeadFunnelCapture: h.stampLeadFunnelCapture,
  claimLeadForContact: vi.fn(async () => true),
  releaseLeadClaim: vi.fn(async () => {}),
}));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: h.contactLead }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/smile-assessment/campaign-repository", () => ({
  getActiveCampaignBySlug: h.getActiveCampaignBySlug,
}));
vi.mock("@/lib/smile-assessment/scoring", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreAssessment: h.scoreAssessment };
});
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledForSend: h.isSystemEnabledForSend,
}));
vi.mock("@/lib/assess/meta-pixel-repository", () => ({ resolveMetaPixel: h.resolveMetaPixel }));
vi.mock("@/lib/assess/meta-capi-send", () => ({ sendAssessmentLeadEvent: h.sendAssessmentLeadEvent }));

import { POST } from "./route";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { stepNumbering } from "@/lib/smile-assessment/step-numbering";

/** A real, publishable funnel — the one an owner starting from a template gets. */
const GRAPH = templateForGoal("invisalign").build();
const NUMBERING = stepNumbering(GRAPH);
const CAMPAIGN_VERSION = 3;

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    clientId: "client-vitality",
    siteId: "site-ng",
    slug: "spring-aligners",
    name: "Spring aligners",
    goal: "invisalign",
    goalNote: null,
    idealCustomer: null,
    targetBudget: "any",
    headline: null,
    intro: null,
    status: "active",
    flow: GRAPH,
    flowVersion: CAMPAIGN_VERSION,
    flowPublished: true,
    theme: null,
    followUpEnabled: false,
    followUpTrigger: null,
    followUpTemplate: null,
    createdBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

let ipCounter = 0;
function req(body: unknown): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/smile-assessment/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

const GOOD = {
  firstName: "Alex",
  phone: "07700 900123",
  channel: "sms",
  clientSlug: "vitality",
  campaignSlug: "spring-aligners",
  responses: { treatment_interest: "invisalign", timeline: "asap" },
};

async function submit(over: Record<string, unknown> = {}) {
  const res = await POST(req({ ...GOOD, ...over }));
  return (await res.json()) as { ok?: boolean; leadCreated?: boolean; funnelToken?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.countRecent.mockResolvedValue(0);
  h.findOpenLeadByAddress.mockResolvedValue(null);
  h.findEarlierOpenLead.mockResolvedValue(null);
  h.consumeBudget.mockResolvedValue(true);
  h.stampLeadFunnelCapture.mockResolvedValue(true);
  h.scoreAssessment.mockReturnValue({ rawScore: 95, band: "high" });
  h.getActiveCampaignBySlug.mockResolvedValue(campaign());
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test"); // trusted, so the lead-creating bridge is reachable
});

describe("the position is recorded from the campaign's own funnel", () => {
  it("stamps the contact screen and the funnel's length", async () => {
    await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).toHaveBeenCalledTimes(1);
    const arg = h.stampLeadFunnelCapture.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.leadId).toBe("lead-new");
    expect(arg.lastStep).toBe(NUMBERING.contactStep);
    expect(arg.totalSteps).toBe(NUMBERING.stepCount);
    expect(arg.flowVersion).toBe(CAMPAIGN_VERSION);
  });

  it("N AND M ARE SERVER-DERIVED: a caller cannot put its own numbers on the row", async () => {
    // MUTATION: read either number off the body "because the browser knows where it
    // is". A public caller would then choose what the practice's worklist says.
    await submit({
      flowVersion: CAMPAIGN_VERSION,
      lastStep: 0,
      step: 0,
      totalSteps: 99,
      funnelStep: 0,
      funnelTotalSteps: 99,
    });
    const arg = h.stampLeadFunnelCapture.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.lastStep).toBe(NUMBERING.contactStep);
    expect(arg.totalSteps).toBe(NUMBERING.stepCount);
  });

  it("hands the browser an opaque bearer it did not choose", async () => {
    const body = await submit({ flowVersion: CAMPAIGN_VERSION, token: "attacker-chosen-token" });
    const arg = h.stampLeadFunnelCapture.mock.calls[0][0] as Record<string, unknown>;
    expect(body.funnelToken).toBe(arg.nonce);
    expect(body.funnelToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.funnelToken).not.toBe("attacker-chosen-token");
  });

  it("mints a different bearer every time", async () => {
    const a = await submit({ flowVersion: CAMPAIGN_VERSION });
    const b = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(a.funnelToken).not.toBe(b.funnelToken);
  });
});

describe("nothing is recorded when the fraction would lie", () => {
  it("REFUSES A VERSION THAT IS NOT THE ONE WE STILL HOLD", async () => {
    // The owner republished while this patient was answering. Only the current
    // graph is stored, so the funnel they walked cannot be measured any more.
    const body = await submit({ flowVersion: CAMPAIGN_VERSION - 1 });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
    expect(body.funnelToken).toBeUndefined();
    expect(body.leadCreated).toBe(true);
  });

  it("records nothing for a session that sent no version at all", async () => {
    // The adaptive fallback, and every pre-0094 client. Its screens are the
    // model's, so there is no fixed ordinal to record.
    const body = await submit({});
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
    expect(body.funnelToken).toBeUndefined();
  });

  it("records nothing when the campaign's funnel is not published", async () => {
    h.getActiveCampaignBySlug.mockResolvedValue(campaign({ flowPublished: false }));
    await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
  });

  it("records nothing when the stored funnel no longer validates", async () => {
    // The same gate the public page applies before serving the deterministic
    // runtime: a broken graph means the patient ran the adaptive funnel.
    h.getActiveCampaignBySlug.mockResolvedValue(campaign({ flow: { nonsense: true } }));
    await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
  });

  it("records nothing for a campaign-less submission", async () => {
    h.getActiveCampaignBySlug.mockResolvedValue(null);
    const body = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
    expect(body.funnelToken).toBeUndefined();
  });
});

describe("it can never cost the practice an enquiry", () => {
  it("still creates and contacts the lead when the stamp throws (0094 not applied)", async () => {
    h.stampLeadFunnelCapture.mockRejectedValue(new Error("column funnel_last_step does not exist"));
    const body = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(body.leadCreated).toBe(true);
    expect(h.contactLead).toHaveBeenCalledTimes(1);
    expect(body.funnelToken).toBeUndefined();
  });

  it("returns NO bearer when the row does not actually hold one", async () => {
    // MUTATION: return the token regardless of the update's result. The browser
    // would spend its whole session posting progress that is dropped every time.
    h.stampLeadFunnelCapture.mockResolvedValue(false);
    const body = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(body.leadCreated).toBe(true);
    expect(body.funnelToken).toBeUndefined();
  });

  it("stamps nothing onto a lead this submission did not create", async () => {
    // The dedup path: this person already had an open enquiry (a website form, a
    // missed call). Writing this funnel's screens onto it would put a sentence on
    // the worklist about a journey that lead did not take.
    h.findOpenLeadByAddress.mockResolvedValue({ id: "lead-existing", channel: "sms" });
    const body = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
    expect(body.funnelToken).toBeUndefined();
  });

  it("stamps nothing onto the winner when this insert loses the double-submit race", async () => {
    h.findEarlierOpenLead.mockResolvedValue({ id: "lead-earlier", channel: "sms" });
    const body = await submit({ flowVersion: CAMPAIGN_VERSION });
    expect(h.stampLeadFunnelCapture).not.toHaveBeenCalled();
    expect(body.funnelToken).toBeUndefined();
  });
});
