import { describe, it, expect, vi, beforeEach } from "vitest";

// CLUSTER C: abuse and spend gates on the PUBLIC Smile Assessment submit endpoint.
//
// It is unauthenticated, it can draft a first contact with Claude and send a real
// SMS, so the properties asserted here are the ones that keep it from costing the
// practice money it never agreed to spend:
//   - a DURABLE budget ceiling (the shared api_budget guard) per caller IP and per
//     client + campaign, consumed BEFORE any scoring, DB write or model call,
//   - the Speed-to-lead kill switch holds on the bridge, so an assessment cannot
//     contact a patient while the owner has Speed-to-lead switched off,
//   - a double submit that loses the insert race is retired rather than texted
//     alongside the winner.
//
// Every I/O seam is mocked; the REAL route handler runs.

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
  contactLead: vi.fn(async (..._a: unknown[]) => {}),
  consumeBudget: vi.fn(async (..._a: unknown[]) => true),
  getActiveCampaignBySlug: vi.fn(async (..._a: unknown[]) => null as unknown),
  // Force a HIGH band so the bridge path (the expensive one) is always exercised.
  scoreAssessment: vi.fn((..._a: unknown[]) => ({ rawScore: 95, band: "high" as const })),
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
  isSystemEnabledForSend: vi.fn(async (..._a: unknown[]) => true),
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

import { POST } from "./route";

let ipCounter = 0;
function req(body: unknown, headers: Record<string, string> = {}): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/smile-assessment/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Unique IP per call so the in-process per-IP cap never interferes.
      "x-forwarded-for": `198.51.100.${ipCounter}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD = {
  firstName: "Alex",
  phone: "07700 900123",
  channel: "sms",
  clientSlug: "vitality",
  responses: { treatment_interest: "implants", timeline: "asap" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.countRecent.mockResolvedValue(0);
  h.findOpenLeadByAddress.mockResolvedValue(null);
  h.findEarlierOpenLead.mockResolvedValue(null);
  h.consumeBudget.mockResolvedValue(true);
  h.scoreAssessment.mockReturnValue({ rawScore: 95, band: "high" });
  h.isSystemEnabled.mockImplementation(async () => true);
  h.isSystemEnabledForSend.mockImplementation(async () => true);
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test"); // trusted, so the bridge is reachable
});

describe("smile assessment submit, durable spend ceiling", () => {
  it("consumes the shared budget per IP and per client + campaign", async () => {
    await POST(
      req({ ...GOOD, campaignSlug: "spring-implants" }, { "x-forwarded-for": "203.0.113.9" }),
    );

    const keys = h.consumeBudget.mock.calls.map((c) => c[0]);
    expect(keys).toContain("smile-submit-ip:203.0.113.9");
    expect(keys).toContain("smile-submit:vitality:spring-implants");
  });

  it("blocks with 429 BEFORE recording or contacting once the budget is spent", async () => {
    h.consumeBudget.mockResolvedValue(false);

    const res = await POST(req(GOOD));
    expect(res.status).toBe(429);
    expect(h.insertResponse).not.toHaveBeenCalled();
    expect(h.insertLead).not.toHaveBeenCalled();
    expect(h.contactLead).not.toHaveBeenCalled();
  });

  it("spends the budget before the score is even calculated", async () => {
    h.consumeBudget.mockResolvedValue(false);
    await POST(req(GOOD));
    expect(h.scoreAssessment).not.toHaveBeenCalled();
  });
});

describe("smile assessment submit, Speed-to-lead kill switch", () => {
  it("records the response but never bridges when speed-to-lead is off", async () => {
    h.isSystemEnabledForSend.mockImplementation(async (..._a: unknown[]) => _a[1] !== "speed-to-lead");

    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    const j = (await res.json()) as { ok: boolean; leadCreated: boolean };
    expect(j.ok).toBe(true);
    expect(h.insertResponse).toHaveBeenCalledTimes(1); // still recorded for staff
    // No lead at all, so nothing is left at stage 'new' for the SLA sweep to text
    // later either: the switch is a full stop, not a delay.
    expect(h.insertLead).not.toHaveBeenCalled();
    expect(h.contactLead).not.toHaveBeenCalled();
    expect(j.leadCreated).toBe(false);
  });

  it("still bridges when both smile-assessment and speed-to-lead are on", async () => {
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expect(h.insertLead).toHaveBeenCalledTimes(1);
    expect(h.contactLead).toHaveBeenCalledTimes(1);
  });
});

describe("smile assessment submit, double-submit race", () => {
  it("retires the losing lead, links the response to the winner and sends nothing", async () => {
    h.findEarlierOpenLead.mockResolvedValue({ id: "lead-winner" });

    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);

    expect(h.setLeadStage).toHaveBeenCalledWith("lead-new", "lost");
    expect(h.setResponseLead).toHaveBeenCalledWith("resp-1", "lead-winner");
    expect(h.contactLead).not.toHaveBeenCalled();
  });

  it("contacts normally when the lead wins the race", async () => {
    await POST(req(GOOD));
    expect(h.setLeadStage).not.toHaveBeenCalled();
    expect(h.setResponseLead).toHaveBeenCalledWith("resp-1", "lead-new");
    expect(h.contactLead).toHaveBeenCalledTimes(1);
  });
});
