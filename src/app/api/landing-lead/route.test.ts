import { describe, it, expect, vi, beforeEach } from "vitest";

// The public landing lead endpoint. A valid enquiry for a LIVE page must record a
// Speed-to-lead lead AND emit the funnel `lead` event (with the right meta) that
// feeds the A/B Leads column, then best-effort first-contact the lead. Invalid
// enquiries and non-live / unknown pages must be rejected WITHOUT recording a lead.
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
  insertLead: vi.fn(async (input: Record<string, unknown>) => ({ id: "lead-1", ...input })),
  findOpenLeadByAddress: vi.fn(async () => null),
  claimLeadForContact: vi.fn(async () => true),
  releaseLeadClaim: vi.fn(async () => {}),
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

    // Best-effort first contact fired (system enabled).
    expect(vi.mocked(contactLead)).toHaveBeenCalledTimes(1);
  });

  it("records the lead + funnel event but does NOT contact when speed-to-lead is off", async () => {
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
