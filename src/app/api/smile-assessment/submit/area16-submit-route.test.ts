// AREA 16: public Smile Assessment submit /api/smile-assessment/submit.
//
// UNAUTHENTICATED and a high score can trigger a real outbound SMS via the
// Speed-to-lead bridge. We assert the abuse posture holds:
//   - an UNTRUSTED submit (no intake key) in production is recorded but NEVER
//     auto-contacts (no lead insert, no contactLead) — fail-closed SMS relay guard,
//   - a TRUSTED submit (key matches) with a high score DOES bridge,
//   - malformed input (no firstName, no valid answers, non-JSON) is a clean 4xx,
//   - a free-floating siteId that is not one of the resolved client's sites is not
//     honoured (cross-tenant attribution guard),
//   - the durable per-contact rate limit blocks the (N+1)th submit.
//
// Every I/O seam is mocked; the REAL route handler runs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  insertResponse: vi.fn(async (..._a: unknown[]) => ({ id: "resp-1" })),
  setResponseLead: vi.fn(async (..._a: unknown[]) => {}),
  countRecent: vi.fn(async (..._a: unknown[]) => 0 as number),
  insertLead: vi.fn(async (..._a: unknown[]) => ({ id: "lead-1", channel: "sms" })),
  findOpenLeadByAddress: vi.fn(async (..._a: unknown[]) => null as unknown),
  findEarlierOpenLead: vi.fn(async (..._a: unknown[]) => null as unknown),
  contactLead: vi.fn(async (..._a: unknown[]) => {}),
  getActiveCampaignBySlug: vi.fn(async (..._a: unknown[]) => null as unknown),
  // Force a HIGH band so the bridge path is exercised whenever trust allows.
  scoreAssessment: vi.fn((..._a: unknown[]) => ({ rawScore: 95, band: "high" as const })),
  // Default: every system on (matches the real fail-open default in tests).
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
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
  setLeadStage: vi.fn(async () => {}),
  claimLeadForContact: vi.fn(async () => true),
  releaseLeadClaim: vi.fn(async () => {}),
}));
// The durable spend guard: open by default here, exercised in public-gates.test.ts.
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: h.contactLead }));
vi.mock("@/lib/smile-assessment/campaign-repository", () => ({
  getActiveCampaignBySlug: h.getActiveCampaignBySlug,
}));
vi.mock("@/lib/smile-assessment/scoring", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreAssessment: h.scoreAssessment };
});
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: h.isSystemEnabled, isSystemEnabledForSend: h.isSystemEnabled }));

// META CONVERSIONS API (0083). Mocked at the seam for the same reason every other
// I/O seam here is: the repository is server-only and the sender talks to Graph.
// Default OFF, which is what every practice has, so the whole block is a no-op
// unless a test switches it on.
vi.mock("@/lib/assess/meta-pixel-repository", () => ({
  resolveMetaPixel: h.resolveMetaPixel,
}));
vi.mock("@/lib/assess/meta-capi-send", () => ({
  sendAssessmentLeadEvent: h.sendAssessmentLeadEvent,
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

const ORIG_ENV = process.env.NODE_ENV;
const ORIG_KEY = process.env.SMILE_ASSESSMENT_SUBMIT_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  h.countRecent.mockResolvedValue(0);
  h.findOpenLeadByAddress.mockResolvedValue(null);
  h.findEarlierOpenLead.mockResolvedValue(null);
  h.scoreAssessment.mockReturnValue({ rawScore: 95, band: "high" });
  h.isSystemEnabled.mockImplementation(async () => true);
  vi.unstubAllEnvs();
  if (ORIG_KEY === undefined) delete process.env.SMILE_ASSESSMENT_SUBMIT_KEY;
  else process.env.SMILE_ASSESSMENT_SUBMIT_KEY = ORIG_KEY;
});

describe("submit — SMS-relay fail-closed on untrusted public traffic", () => {
  it("records but does NOT auto-contact an untrusted high scorer in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SMILE_ASSESSMENT_SUBMIT_KEY; // unset -> fails closed in prod
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    const j = (await res.json()) as { ok: boolean; leadCreated: boolean };
    expect(j.ok).toBe(true);
    expect(h.insertResponse).toHaveBeenCalledTimes(1); // always recorded
    expect(h.insertLead).not.toHaveBeenCalled(); // never bridged
    expect(h.contactLead).not.toHaveBeenCalled(); // never a real send
    expect(j.leadCreated).toBe(false);
  });

  it("requires the exact intake key when one is configured (wrong key -> no bridge)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SMILE_ASSESSMENT_SUBMIT_KEY = "s3cret";
    const res = await POST(req(GOOD, { "x-intake-key": "wrong" }));
    expect(res.status).toBe(202);
    expect(h.insertLead).not.toHaveBeenCalled();
    expect(h.contactLead).not.toHaveBeenCalled();
  });

  it("DOES bridge + contact when the configured key matches (trusted)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SMILE_ASSESSMENT_SUBMIT_KEY = "s3cret";
    const res = await POST(req(GOOD, { "x-intake-key": "s3cret" }));
    const j = (await res.json()) as { leadCreated: boolean };
    expect(j.leadCreated).toBe(true);
    expect(h.insertLead).toHaveBeenCalledTimes(1);
    expect(h.contactLead).toHaveBeenCalledTimes(1);
  });

  it("DOES bridge + contact with a valid page token (the public funnel / website embed path)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SMILE_ASSESSMENT_SUBMIT_KEY = "s3cret";
    const { mintSubmitToken } = await import("@/lib/smile-assessment/embed-token");
    const pageToken = mintSubmitToken(GOOD.clientSlug, new Date(), "s3cret");
    const res = await POST(req({ ...GOOD, pageToken }));
    const j = (await res.json()) as { leadCreated: boolean };
    expect(j.leadCreated).toBe(true);
    expect(h.contactLead).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged/stale page token (records, never bridges)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SMILE_ASSESSMENT_SUBMIT_KEY = "s3cret";
    const res = await POST(req({ ...GOOD, pageToken: "f".repeat(64) }));
    expect(res.status).toBe(202);
    expect(h.insertResponse).toHaveBeenCalledTimes(1);
    expect(h.insertLead).not.toHaveBeenCalled();
    expect(h.contactLead).not.toHaveBeenCalled();
  });

  it("a page token minted for ANOTHER client does not trust this one", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SMILE_ASSESSMENT_SUBMIT_KEY = "s3cret";
    const { mintSubmitToken } = await import("@/lib/smile-assessment/embed-token");
    const pageToken = mintSubmitToken("some-other-practice", new Date(), "s3cret");
    await POST(req({ ...GOOD, pageToken }));
    expect(h.insertLead).not.toHaveBeenCalled();
  });
});

describe("submit — first-contact channel (demo: SMS)", () => {
  it("coerces a WhatsApp preference to SMS while the WhatsApp sender is not connected", async () => {
    vi.stubEnv("NODE_ENV", "test"); // trusted
    await POST(req({ ...GOOD, channel: "whatsapp" }));
    expect(h.insertLead).toHaveBeenCalledTimes(1);
    const arg = h.insertLead.mock.calls[0]![0] as { channel: string };
    expect(arg.channel).toBe("sms");
  });
});

describe("submit — online-booking link-up", () => {
  it("includes bookingUrl on success when online booking is on, omits it when off", async () => {
    vi.stubEnv("NODE_ENV", "test"); // trusted
    // ON (default mock): the success payload carries the public booking URL.
    const on = await POST(req(GOOD));
    expect(on.status).toBe(202);
    const jOn = (await on.json()) as { bookingUrl?: string };
    expect(jOn.bookingUrl).toBe("/book/vitality?site=site-cc");
    // OFF for online-booking only (smile-assessment stays on): omitted entirely.
    h.isSystemEnabled.mockImplementation(async (..._a: unknown[]) => _a[1] !== "online-booking");
    const off = await POST(req(GOOD));
    expect(off.status).toBe(202);
    const jOff = (await off.json()) as { bookingUrl?: string };
    expect(jOff.bookingUrl).toBeUndefined();
  });
});

describe("submit — input validation", () => {
  it("rejects a non-JSON body", async () => {
    const res = await POST(req("nope{", {}));
    expect(res.status).toBe(400);
  });

  it("requires firstName", async () => {
    const res = await POST(req({ ...GOOD, firstName: "   " }));
    expect(res.status).toBe(400);
    expect(h.insertResponse).not.toHaveBeenCalled();
  });

  it("requires at least one valid quiz answer (junk keys are dropped)", async () => {
    const res = await POST(req({ ...GOOD, responses: { not_a_question: "x", evil: { a: 1 } } }));
    expect(res.status).toBe(400);
    expect(h.insertResponse).not.toHaveBeenCalled();
  });

  it("rejects when no client/site can be resolved", async () => {
    const res = await POST(req({ ...GOOD, clientSlug: "does-not-exist" }));
    expect(res.status).toBe(400);
  });
});

describe("submit — cross-tenant + rate-limit guards", () => {
  it("ignores a free-floating siteId that is not one of the resolved client's sites", async () => {
    vi.stubEnv("NODE_ENV", "test"); // trusted, so we can inspect the recorded siteId
    await POST(req({ ...GOOD, siteId: "site-of-another-tenant" }));
    expect(h.insertResponse).toHaveBeenCalledTimes(1);
    const arg = h.insertResponse.mock.calls[0]![0] as { siteId: string };
    // Falls back to the client's own first site, never the attacker-supplied one.
    expect(arg.siteId).not.toBe("site-of-another-tenant");
    expect(["site-cc", "site-rv", "site-ng"]).toContain(arg.siteId);
  });

  it("blocks a submit once the durable per-contact cap is reached", async () => {
    h.countRecent.mockResolvedValueOnce(5); // at the limit
    const res = await POST(req(GOOD));
    expect(res.status).toBe(429);
    expect(h.insertResponse).not.toHaveBeenCalled();
  });

  it("never throws to the client even if recording fails", async () => {
    h.insertResponse.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req(GOOD));
    expect(res.status).toBe(500);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });
});

describe("submit — the Meta conversion event can never reach the patient", () => {
  const ON = { enabled: true, pixelId: "123456789012345", advancedMatching: false };

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test"); // trusted, so the whole happy path runs
  });

  it("sends nothing at all for a practice that has not switched tracking on", async () => {
    // The default. `enabled: false` is what every practice has, and it must cost
    // this endpoint nothing beyond one cheap read.
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expect(h.sendAssessmentLeadEvent).not.toHaveBeenCalled();
  });

  it("sends the event, with the visitor's own answer, when tracking is on", async () => {
    h.resolveMetaPixel.mockResolvedValueOnce(ON);
    const res = await POST(
      req({ ...GOOD, metaConsent: true, metaEventId: "abcdefgh1234", campaignSlug: undefined }),
    );
    expect(res.status).toBe(202);
    expect(h.sendAssessmentLeadEvent).toHaveBeenCalledTimes(1);
    const arg = h.sendAssessmentLeadEvent.mock.calls[0]![0] as {
      clientId: string;
      consented: boolean;
      eventId: string;
      sourceUrl: string;
      config: unknown;
    };
    expect(arg.consented).toBe(true);
    expect(arg.eventId).toBe("abcdefgh1234");
    expect(arg.clientId).toBe("vitality");
    // The page URL is built from the SERVER's resolved slug, not the body's.
    expect(arg.sourceUrl).toBe("http://localhost/assess/vitality");
    // The practice's stored config is what decides advanced matching -- the
    // caller never gets to pass it.
    expect(arg.config).toEqual(ON);
  });

  // MUTATION: read the consent flag with a truthiness check, or default it to
  // true. A submission from an older cached page (no field at all) would then
  // unlock hashed contact details that nobody agreed to.
  it.each([
    ["absent", {}],
    ["the string 'true'", { metaConsent: "true" }],
    ["1", { metaConsent: 1 }],
    ["explicitly false", { metaConsent: false }],
  ])("treats consent %s as NOT consented", async (_label, extra) => {
    h.resolveMetaPixel.mockResolvedValueOnce(ON);
    await POST(req({ ...GOOD, ...extra }));
    const arg = h.sendAssessmentLeadEvent.mock.calls[0]![0] as { consented: boolean };
    expect(arg.consented).toBe(false);
  });

  // MUTATION: put the send outside the kill-switch branch. Switching a system off
  // has to shut every door, and a call to Facebook about a patient is an outbound
  // act like any other.
  it("sends nothing when the smile-assessment system is switched off", async () => {
    h.resolveMetaPixel.mockResolvedValue(ON);
    h.isSystemEnabled.mockImplementation(async () => false);
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202); // the response is still recorded
    expect(h.insertResponse).toHaveBeenCalledTimes(1);
    expect(h.sendAssessmentLeadEvent).not.toHaveBeenCalled();
    h.resolveMetaPixel.mockResolvedValue({ enabled: false, pixelId: null, advancedMatching: false });
  });

  // ==========================================================================
  // THE HEADLINE. The submit handler sits inside one big try whose catch answers
  // 500 "could not record your assessment" -- a sentence that would be a LIE
  // here, because the assessment is already recorded by this point. Both of the
  // following would have taken that path without the block's own try/catch.
  // ==========================================================================
  it("still succeeds when the sender throws", async () => {
    h.resolveMetaPixel.mockResolvedValueOnce(ON);
    h.sendAssessmentLeadEvent.mockRejectedValueOnce(new Error("graph.facebook.com is unreachable"));
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    const j = (await res.json()) as { ok: boolean; band: string };
    expect(j.ok).toBe(true);
    expect(j.band).toBe("high");
    expect(h.insertResponse).toHaveBeenCalledTimes(1);
    // ...and the bridge that follows it still ran, so a thrown tracking call
    // cannot swallow the patient's actual follow-up either.
    expect(h.insertLead).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the config read throws", async () => {
    h.resolveMetaPixel.mockRejectedValueOnce(new Error("client_meta_pixel is missing"));
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expect(h.insertResponse).toHaveBeenCalledTimes(1);
    expect(h.insertLead).toHaveBeenCalledTimes(1);
  });

  it("reports an unsent event as a normal outcome, not an error", async () => {
    h.resolveMetaPixel.mockResolvedValueOnce(ON);
    h.sendAssessmentLeadEvent.mockResolvedValueOnce({ sent: false, reason: "no-token" });
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
  });
});
