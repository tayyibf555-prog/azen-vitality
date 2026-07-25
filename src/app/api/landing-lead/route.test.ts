import { describe, it, expect, vi, beforeEach } from "vitest";

// The public landing lead endpoint. A valid enquiry for a LIVE page must record a
// Speed-to-lead lead AND emit the funnel `lead` event (with the right meta) that
// feeds the A/B Leads column. It must NOT send anything in the request path: first
// contact is the SLA sweep's job (see public-gates.test.ts). Invalid enquiries and
// non-live / unknown pages must be rejected WITHOUT recording a lead.
// getClient / phone normalisation are left real (pure); all I/O is mocked.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));
vi.mock("@/lib/landing/repository", () => ({ getLivePageBySlug: vi.fn(async () => null) }));
vi.mock("@/lib/funnel/events", () => ({
  insertFunnelEvents: vi.fn(async () => {}),
  isValidSessionId: (v: unknown) => typeof v === "string" && v.trim().length > 0,
}));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: vi.fn(async () => {}) }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  insertLead: vi.fn(async (input: Record<string, unknown>) => ({
    id: "lead-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input,
  })),
  findOpenLeadByAddress: vi.fn(async () => null),
  findEarlierOpenLead: vi.fn(async () => null),
  setLeadStage: vi.fn(async () => {}),
  countRecentByContact: vi.fn(async () => 0),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledForSend: vi.fn(async () => true) }));

import { POST } from "./route";
import { getLivePageBySlug } from "@/lib/landing/repository";
import { insertFunnelEvents } from "@/lib/funnel/events";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { insertLead } from "@/lib/speed-to-lead/repository";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

const LIVE_PAGE = {
  page: {
    id: "page-1",
    clientId: "vitality",
    siteId: "site-cc",
    slug: "invisalign",
    treatment: "invisalign",
    campaignRef: null,
    status: "live" as const,
    winnerVariant: null,
    autoPromote: true,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  variants: [],
};

// A second live bespoke page (composite bonding), to prove the endpoint derives the
// treatment interest + source from the resolved page rather than hardcoding.
const BONDING_PAGE = {
  page: {
    ...LIVE_PAGE.page,
    id: "page-2",
    slug: "bonding",
    treatment: "bonding",
  },
  variants: [],
};

// A third live bespoke page (hygiene), proving the same derivation for the hygiene
// treatment key ("Hygiene visit") and the "landing:hygiene" source.
const HYGIENE_PAGE = {
  page: {
    ...LIVE_PAGE.page,
    id: "page-3",
    slug: "hygiene",
    treatment: "hygiene",
  },
  variants: [],
};

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://test/api/landing-lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    clientSlug: "vitality",
    landingSlug: "invisalign",
    variant: "b",
    name: "Jo Bloggs",
    phone: "07700900123",
    channel: "sms",
    consent: true,
    sessionId: "sess-1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLivePageBySlug).mockResolvedValue(LIVE_PAGE);
  vi.mocked(isSystemEnabledForSend).mockResolvedValue(true);
});

describe("landing lead endpoint — happy path", () => {
  it("records a lead and emits the funnel lead event with the right meta", async () => {
    const res = await post(validBody());
    const body = (await res.json()) as { success?: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    expect(vi.mocked(insertLead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site-cc",
        name: "Jo Bloggs",
        phone: "+447700900123", // normalised to E.164
        email: null,
        channel: "sms",
        treatmentInterest: "Invisalign", // derived from the live page's treatment key
        source: "landing:invisalign", // derived from the live page's slug
        consent: { sms: true, marketing: true },
      }),
    );

    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledWith([
      {
        clientId: "vitality",
        surface: "landing",
        sessionId: "sess-1",
        step: "lead",
        meta: { variant: "b", landingSlug: "invisalign" },
      },
    ]);

    // UPDATED (public-endpoint abuse fix): this used to assert the route
    // first-contacted the lead inside the request. That assertion encoded the defect:
    // an unauthenticated HTTP request could itself cause a real outbound message, so
    // anyone could burn Twilio and model spend at will. The send now belongs to the
    // SLA sweep, so the request path must send nothing.
    expect(vi.mocked(contactLead)).not.toHaveBeenCalled();
  });

  it("records the lead + funnel event and never contacts in the request path", async () => {
    // The kill switch no longer decides anything here (the sweep checks it at the
    // moment of the send): ON or OFF, this route records and sends nothing.
    vi.mocked(isSystemEnabledForSend).mockResolvedValue(false);

    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(contactLead)).not.toHaveBeenCalled();
  });

  it("derives treatment interest + source from the resolved live page (bonding)", async () => {
    vi.mocked(getLivePageBySlug).mockResolvedValue(BONDING_PAGE);

    const res = await post(validBody({ landingSlug: "bonding" }));
    expect(res.status).toBe(200);

    // The catalogue treatment NAME for key "bonding" is "Composite bonding"; the
    // source is "landing:" + the page slug. Neither is hardcoded to Invisalign.
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({
        treatmentInterest: "Composite bonding",
        source: "landing:bonding",
      }),
    );

    // The funnel `lead` event carries the bonding slug too.
    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledWith([
      expect.objectContaining({ step: "lead", meta: { variant: "b", landingSlug: "bonding" } }),
    ]);
  });

  it("derives treatment interest + source from the resolved live page (hygiene)", async () => {
    vi.mocked(getLivePageBySlug).mockResolvedValue(HYGIENE_PAGE);

    const res = await post(validBody({ landingSlug: "hygiene" }));
    expect(res.status).toBe(200);

    // The catalogue treatment NAME for key "hygiene" is "Hygiene visit"; the source
    // is "landing:" + the page slug. Neither is hardcoded to Invisalign.
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({
        treatmentInterest: "Hygiene visit",
        source: "landing:hygiene",
      }),
    );

    // The funnel `lead` event carries the hygiene slug too.
    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledWith([
      expect.objectContaining({ step: "lead", meta: { variant: "b", landingSlug: "hygiene" } }),
    ]);
  });

  // The four remaining bespoke pages derive their treatment interest + source the same
  // way (from the resolved live page, never hardcoded). One compact case per new slug.
  it.each([
    { slug: "whitening", treatment: "whitening", interest: "Teeth whitening" },
    { slug: "veneers", treatment: "veneers", interest: "Veneers" },
    { slug: "implant", treatment: "implant", interest: "Dental implant" },
    { slug: "checkup", treatment: "checkup", interest: "Checkup" },
  ])(
    "derives treatment interest + source from the resolved live page ($slug)",
    async ({ slug, treatment, interest }) => {
      vi.mocked(getLivePageBySlug).mockResolvedValue({
        page: { ...LIVE_PAGE.page, id: `page-${slug}`, slug, treatment },
        variants: [],
      });

      const res = await post(validBody({ landingSlug: slug }));
      expect(res.status).toBe(200);

      expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
        expect.objectContaining({ treatmentInterest: interest, source: `landing:${slug}` }),
      );
      expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledWith([
        expect.objectContaining({ step: "lead", meta: { variant: "b", landingSlug: slug } }),
      ]);
    },
  );

  it("accepts an email-only enquiry on the email channel", async () => {
    const res = await post(
      validBody({ phone: undefined, email: "Jo@Example.com", channel: "email" }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: null,
        email: "jo@example.com", // normalised
        channel: "email",
        consent: { email: true, marketing: true },
      }),
    );
  });
});

// The multi-site override: ONE published page (e.g. LIVE_PAGE, configured for
// site-cc) can be linked from several practice sites' campaigns via a siteId in
// the POST body (sent by the /go page's ?site= override, or the ConsultationForm
// hint). Valid, foreign, and absent values must each resolve exactly as
// resolveEffectiveSite (src/lib/landing/site.ts) specifies.
describe("landing lead endpoint — site override", () => {
  it("honours a siteId override that belongs to the resolved client", async () => {
    const res = await post(validBody({ siteId: "site-rv" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-rv" }),
    );
  });

  it("falls back to the page's own site when siteId is foreign/unknown", async () => {
    const res = await post(validBody({ siteId: "not-a-real-site" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc" }), // LIVE_PAGE's own configured site
    );
  });

  it("falls back to the page's own site when siteId is absent (unchanged default)", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc" }),
    );
  });
});

describe("landing lead endpoint — rejections (no lead recorded)", () => {
  async function expectRejected(body: unknown, status: number) {
    const res = await post(body);
    expect(res.status).toBe(status);
    const parsed = (await res.json()) as { success?: boolean };
    expect(parsed.success).toBe(false);
    expect(vi.mocked(insertLead)).not.toHaveBeenCalled();
    expect(vi.mocked(insertFunnelEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(contactLead)).not.toHaveBeenCalled();
  }

  it("rejects a missing name", async () => {
    await expectRejected(validBody({ name: "" }), 400);
  });

  it("rejects when neither phone nor email is provided", async () => {
    await expectRejected(validBody({ phone: undefined, email: undefined }), 400);
  });

  it("rejects an invalid channel", async () => {
    await expectRejected(validBody({ channel: "carrier-pigeon" }), 400);
  });

  it("rejects when consent is not given", async () => {
    await expectRejected(validBody({ consent: false }), 400);
  });

  it("rejects an unknown client (404)", async () => {
    await expectRejected(validBody({ clientSlug: "not-a-client" }), 404);
  });

  it("rejects when the page is not live (404)", async () => {
    vi.mocked(getLivePageBySlug).mockResolvedValue(null);
    await expectRejected(validBody(), 404);
  });
});
