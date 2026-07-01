import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 10 (speed-to-lead): public intake route — cross-tenant + consent on first
// outbound. Exercises the real POST handler with the repository + contact mocked,
// so we assert exactly which siteId a lead is attributed to and which consent flags
// gate the first send.

const insertLead = vi.fn();
const countRecentByContact = vi.fn();
const findOpenLeadByAddress = vi.fn();
const contactLead = vi.fn();

// Two tenants, each with a site, so we can prove a body siteId cannot attribute a
// lead to a foreign tenant's site.
const SITES: Record<string, { id: string; clientId: string }> = {
  "site-vitality": { id: "site-vitality", clientId: "vitality" },
  "site-rival": { id: "site-rival", clientId: "rival" },
};
const CLIENTS: Record<string, { id: string; slug: string }> = {
  vitality: { id: "vitality", slug: "vitality" },
  rival: { id: "rival", slug: "rival" },
};

vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (slug: string) => CLIENTS[slug],
}));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: (...a: unknown[]) => contactLead(...a) }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  insertLead: (...a: unknown[]) => insertLead(...a),
  countRecentByContact: (...a: unknown[]) => countRecentByContact(...a),
  findOpenLeadByAddress: (...a: unknown[]) => findOpenLeadByAddress(...a),
}));

import { POST } from "@/app/api/speed-to-lead/intake/route";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/api/speed-to-lead/intake", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SPEED_TO_LEAD_INTAKE_KEY;
  vi.stubEnv("NODE_ENV", "test");
  countRecentByContact.mockResolvedValue(0);
  findOpenLeadByAddress.mockResolvedValue(null);
  insertLead.mockImplementation(async (input: { siteId: string }) => ({
    id: "lead-new",
    ...input,
    stage: "new",
    firstResponseAt: null,
    conversationId: null,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-07-01T09:00:00Z",
  }));
  contactLead.mockResolvedValue(undefined);
});

describe("intake consent on first outbound", () => {
  it("sms enquiry defaults sms consent true so the first outbound is allowed", async () => {
    const res = await POST(req({ name: "Sam", channel: "sms", phone: "07700900123", clientSlug: "vitality" }));
    expect(res.status).toBe(202);
    const arg = insertLead.mock.calls[0][0];
    expect(arg.consent.sms).toBe(true);
    // Never marketing unless explicitly opted in.
    expect(arg.consent.marketing).toBe(false);
    expect(contactLead).toHaveBeenCalledTimes(1);
  });

  it("email enquiry defaults email consent true, sms false (no cross-channel consent)", async () => {
    await POST(req({ name: "Sam", channel: "email", email: "sam@example.com", clientSlug: "vitality" }));
    const arg = insertLead.mock.calls[0][0];
    expect(arg.consent.email).toBe(true);
    expect(arg.consent.sms).toBe(false);
  });

  it("marketing consent is only set when explicitly opted in", async () => {
    await POST(
      req({ name: "Sam", channel: "sms", phone: "07700900123", clientSlug: "vitality", consentMarketing: true }),
    );
    expect(insertLead.mock.calls[0][0].consent.marketing).toBe(true);
  });
});

describe("intake cross-tenant attribution", () => {
  it("resolves the site from the client's own sites when clientSlug given", async () => {
    await POST(req({ name: "Sam", channel: "sms", phone: "07700900123", clientSlug: "vitality" }));
    expect(insertLead.mock.calls[0][0].siteId).toBe("site-vitality");
  });

  it("VULN CHECK: a body siteId belonging to another tenant must not be honoured", async () => {
    // Caller claims to be 'vitality' (their intake key/domain) but passes a rival
    // tenant's siteId. A correct handler attributes the lead+SMS to a vitality site,
    // NOT to site-rival. If this fails, the intake route trusts an unscoped siteId.
    await POST(
      req({
        name: "Sam",
        channel: "sms",
        phone: "07700900123",
        clientSlug: "vitality",
        siteId: "site-rival",
      }),
    );
    expect(insertLead).toHaveBeenCalled();
    const attributed = insertLead.mock.calls[0][0].siteId;
    expect(attributed).toBe("site-vitality");
  });
});

describe("intake validation guards (no send on bad input)", () => {
  it("rejects an sms channel with an unparseable phone", async () => {
    const res = await POST(req({ name: "Sam", channel: "sms", phone: "abc", clientSlug: "vitality" }));
    expect(res.status).toBe(400);
    expect(insertLead).not.toHaveBeenCalled();
    expect(contactLead).not.toHaveBeenCalled();
  });

  it("dedups an existing open lead instead of a second first-contact", async () => {
    findOpenLeadByAddress.mockResolvedValue({ id: "lead-existing" });
    const res = await POST(req({ name: "Sam", channel: "sms", phone: "07700900123", clientSlug: "vitality" }));
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, leadId: "lead-existing", deduped: true });
    expect(insertLead).not.toHaveBeenCalled();
    expect(contactLead).not.toHaveBeenCalled();
  });

  it("enforces the per-contact rate limit (429, no lead, no send)", async () => {
    countRecentByContact.mockResolvedValue(5);
    const res = await POST(req({ name: "Sam", channel: "sms", phone: "07700900123", clientSlug: "vitality" }));
    expect(res.status).toBe(429);
    expect(insertLead).not.toHaveBeenCalled();
    expect(contactLead).not.toHaveBeenCalled();
  });
});
