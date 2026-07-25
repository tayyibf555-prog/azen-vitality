import { describe, it, expect, vi, beforeEach } from "vitest";

// CLUSTER C: abuse and spend gates on the PUBLIC landing-lead endpoint.
//
// This endpoint is unauthenticated and reachable by anyone. The properties asserted
// here are the ones that stop it costing the practice real money or texting a
// patient twice:
//   - a per-IP DURABLE budget (the shared api_budget guard) bounds one caller across
//     every landing page, not just per page and not just per serverless instance,
//   - no send ever happens in the request path (first contact is the SLA sweep's),
//   - a WhatsApp lead is recorded with sms consent too, so the nurture cadence can
//     still reach it instead of retiring it after one message,
//   - a double submit that loses the insert race is retired rather than left to be
//     texted alongside the winner.
//
// Every I/O seam is mocked; the REAL route handler runs.

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
    id: "lead-new",
    createdAt: "2026-01-01T00:00:10.000Z",
    ...input,
  })),
  findOpenLeadByAddress: vi.fn(async () => null),
  findEarlierOpenLead: vi.fn(async () => null),
  setLeadStage: vi.fn(async () => {}),
  countRecentByContact: vi.fn(async () => 0),
}));

import { POST } from "./route";
import { consumeBudget } from "@/lib/rate-budget";
import { getLivePageBySlug } from "@/lib/landing/repository";
import { insertFunnelEvents } from "@/lib/funnel/events";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { insertLead, findEarlierOpenLead, setLeadStage } from "@/lib/speed-to-lead/repository";

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

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://test/api/landing-lead", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    clientSlug: "vitality",
    landingSlug: "invisalign",
    variant: "a",
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
  vi.mocked(consumeBudget).mockResolvedValue(true);
  vi.mocked(findEarlierOpenLead).mockResolvedValue(null);
});

describe("landing lead — per-IP durable spend gate", () => {
  it("consumes a durable budget keyed on the caller IP, before the per-slug one", async () => {
    await post(validBody(), { "x-forwarded-for": "203.0.113.7, 70.41.3.18" });

    // First hop of x-forwarded-for is the caller.
    expect(vi.mocked(consumeBudget).mock.calls[0]![0]).toBe("landing-lead-ip:203.0.113.7");
    expect(vi.mocked(consumeBudget).mock.calls[1]![0]).toBe("landing-lead:vitality:invisalign");
  });

  it("rejects with 429 and records nothing once the per-IP budget is spent", async () => {
    vi.mocked(consumeBudget).mockImplementation(async (key: string) =>
      !key.startsWith("landing-lead-ip:"),
    );

    const res = await post(validBody(), { "x-forwarded-for": "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(vi.mocked(insertLead)).not.toHaveBeenCalled();
    expect(vi.mocked(insertFunnelEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(contactLead)).not.toHaveBeenCalled();
  });

  it("still applies the per-slug budget when the per-IP one passes", async () => {
    vi.mocked(consumeBudget).mockImplementation(async (key: string) =>
      key.startsWith("landing-lead-ip:"),
    );

    const res = await post(validBody());
    expect(res.status).toBe(429);
    expect(vi.mocked(insertLead)).not.toHaveBeenCalled();
  });
});

describe("landing lead — no send in the request path", () => {
  it("records the lead but never first-contacts it inside the request", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledTimes(1);
    // The SLA sweep does the send: the lead is left at its default stage 'new' with
    // no first response, which is exactly what listUncontacted selects.
    expect(vi.mocked(contactLead)).not.toHaveBeenCalled();
  });
});

describe("landing lead — WhatsApp consent", () => {
  it("records sms consent alongside whatsapp so the nurture cadence can still reach them", async () => {
    const res = await post(validBody({ channel: "whatsapp" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        consent: { marketing: true, whatsapp: true, sms: true },
      }),
    );
  });

  it("does not hand an SMS lead a whatsapp consent it never gave", async () => {
    await post(validBody({ channel: "sms" }));
    expect(vi.mocked(insertLead)).toHaveBeenCalledWith(
      expect.objectContaining({ consent: { marketing: true, sms: true } }),
    );
  });
});

describe("landing lead — double-submit race", () => {
  it("retires the losing lead and does not count it as a second conversion", async () => {
    vi.mocked(findEarlierOpenLead).mockResolvedValue({
      id: "lead-winner",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);

    const res = await post(validBody());
    expect(res.status).toBe(200);

    // The loser is retired, so the sweep can never first-contact it alongside the
    // winner: one enquiry, one text.
    expect(vi.mocked(setLeadStage)).toHaveBeenCalledWith("lead-new", "lost");
    // And the A/B funnel `lead` event is not emitted twice for one person.
    expect(vi.mocked(insertFunnelEvents)).not.toHaveBeenCalled();
  });

  it("keeps the lead and emits the funnel event when it wins the race", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(vi.mocked(setLeadStage)).not.toHaveBeenCalled();
    expect(vi.mocked(insertFunnelEvents)).toHaveBeenCalledTimes(1);
  });
});
