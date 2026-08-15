import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// POST /api/hr/policy/[id]/sign — THE ROUTE THAT PRODUCES THE EVIDENCE.
//
// It is the only write in the HR lane whose output is an evidential record, and
// it deliberately carries NO module gate (it is recorded as a `self-service`
// exemption in both platform-wide guard sweeps). Everything those two exemptions
// rest on was checked by READING THE FILE AS TEXT — `expect(src).not.toMatch(
// /body\.staffId/)`, `expect(src).toContain("authEnforced()")`. Those are
// spelling checks. A route that read `body.signerId` instead would pass every
// one of them.
//
// This file drives the handler. Two claims, and then every refusal:
//
//   1. THE SIGNER IS THE SESSION'S. `recordSignature` receives the staff id
//      `findStaffByAppUser` resolved, whatever the body says, under any spelling.
//   2. THE VERSION IS THE POLICY ROW'S, not the caller's.
//
// Every failure path asserts `recordSignature` was called ZERO times, because a
// signature recorded on a refused request is worse than no signature: it looks
// like evidence and is none.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(),
  authEnforced: vi.fn(),
  consumeBudget: vi.fn(),
  isSystemEnabled: vi.fn(),
  findStaffByAppUser: vi.fn(),
  getPolicy: vi.fn(),
  recordSignature: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
  authEnforced: h.authEnforced,
}));

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: h.isSystemEnabled }));
vi.mock("@/lib/clock/repository", () => ({ findStaffByAppUser: h.findStaffByAppUser }));
vi.mock("@/lib/hr/policy-repository", () => ({
  getPolicy: h.getPolicy,
  recordSignature: h.recordSignature,
}));

import { POST } from "./route";
import { ESIGN_COPY } from "@/lib/hr/esign";

const NURSE = {
  id: "u-nurse",
  email: "n@x",
  role: "client_staff",
  clientId: "vitality",
  siteIds: ["site-n15"],
};

const MY_STAFF_ID = "00000000-0000-0000-0000-0000000000f1";
const SOMEBODY_ELSE = "00000000-0000-0000-0000-0000000000f2";
const POLICY_ID = "pol-1";

function policy(over: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    clientId: "vitality",
    slug: "infection-control",
    title: "Infection control",
    version: 4,
    storagePath: "staff-docs/vitality/policies/tok/ic.pdf",
    mime: "application/pdf",
    sizeBytes: 2048,
    effectiveFrom: "2026-01-01",
    retiredAt: null,
    createdBy: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...over,
  };
}

function sign(body: Record<string, unknown> = {}) {
  return POST(
    new Request(`http://localhost/api/hr/policy/${POLICY_ID}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Test/1.0",
        "x-forwarded-for": "203.0.113.7",
      },
      body: JSON.stringify({ clientSlug: "vitality", method: "typed", value: "Amina Rahman", ...body }),
    }),
    { params: Promise.resolve({ id: POLICY_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeBudget.mockResolvedValue(true);
  h.requireUser.mockResolvedValue(NURSE);
  h.requireClientAccess.mockReturnValue(null);
  h.authEnforced.mockReturnValue(true);
  h.isSystemEnabled.mockResolvedValue(true);
  h.findStaffByAppUser.mockResolvedValue({ id: MY_STAFF_ID, name: "Amina", role: "nurse" });
  h.getPolicy.mockResolvedValue(policy());
  h.recordSignature.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: "sig-1",
    signature: { method: "typed", value: "Amina Rahman" },
  }));
});

describe("the happy path, and what it binds the signature to", () => {
  it("records the SESSION's staff id and the POLICY ROW's version", async () => {
    const res = await sign();
    expect(res.status).toBe(200);

    expect(h.findStaffByAppUser).toHaveBeenCalledWith("vitality", "u-nurse");
    expect(h.recordSignature).toHaveBeenCalledTimes(1);
    const input = h.recordSignature.mock.calls[0][0];
    expect(input.staffId).toBe(MY_STAFF_ID);
    expect(input.policyId).toBe(POLICY_ID);
    expect(input.policyVersion).toBe(4);
    // The time is the SERVER's: a time the signer chose is half the claim gone.
    expect(Number.isNaN(Date.parse(input.signedAt))).toBe(false);
    // The address is HASHED, never retained. The raw one must appear nowhere in
    // what is written.
    expect(input.ipHash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(JSON.stringify(input)).not.toContain("203.0.113.7");
    expect(input.userAgent).toBe("Test/1.0");
  });

  it("answers with the method and the time, and NEVER the signature value back", async () => {
    const body = await (await sign()).json();
    expect(body).toEqual({
      ok: true,
      signedAt: expect.any(String),
      policyId: POLICY_ID,
      policyVersion: 4,
      method: "typed",
    });
    expect(JSON.stringify(body)).not.toContain("Amina Rahman");
  });
});

describe("A BODY-SUPPLIED SIGNER IS IGNORED, whatever it is called", () => {
  // The grep sweeps assert the strings "body.staffId", "searchParams staffId" and
  // "form.get staffId" are absent. This asserts the PROPERTY those greps stand in
  // for, so a route that read `body.signerId` would fail here.
  it.each(["staffId", "staff_id", "signerId", "userId", "appUserId", "personId"])(
    "signs as the session's staff record even when the body carries %s",
    async (field) => {
      await sign({ [field]: SOMEBODY_ELSE });
      expect(h.recordSignature.mock.calls[0][0].staffId).toBe(MY_STAFF_ID);
    },
  );

  it("takes the VERSION from the policy row, not from a body that claims another", async () => {
    await sign({ policyVersion: 99 });
    expect(h.recordSignature.mock.calls[0][0].policyVersion).toBe(4);
  });

  it("takes the TIME from the server, not from a body that supplies one", async () => {
    await sign({ signedAt: "1999-01-01T00:00:00.000Z" });
    expect(h.recordSignature.mock.calls[0][0].signedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});

describe("every refusal records NOTHING", () => {
  async function expectRefusal(status: number, run: () => Promise<Response>) {
    const res = await run();
    expect(res.status).toBe(status);
    expect((await res.json()).ok).toBe(false);
    expect(h.recordSignature).not.toHaveBeenCalled();
  }

  it("429 when the shared budget is spent", async () => {
    h.consumeBudget.mockResolvedValue(false);
    await expectRefusal(429, () => sign());
  });

  it("404 for a practice this platform does not know", async () => {
    await expectRefusal(404, () => sign({ clientSlug: "not-a-practice" }));
  });

  it("403 for a login that belongs to another practice", async () => {
    h.requireClientAccess.mockReturnValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );
    await expectRefusal(403, () => sign());
  });

  // FAIL CLOSED. Recording an attestation with no identity behind it would look
  // like evidence and be none — which is worse than recording nothing at all.
  it("503 when sign-in is not configured on this environment", async () => {
    h.authEnforced.mockReturnValue(false);
    await expectRefusal(503, () => sign());
    expect(h.findStaffByAppUser).not.toHaveBeenCalled();
  });

  it("503 when there is no session at all, even with enforcement on", async () => {
    h.requireUser.mockResolvedValue(null);
    await expectRefusal(503, () => sign());
  });

  it("503 while the e-sign kill switch is off", async () => {
    h.isSystemEnabled.mockResolvedValue(false);
    const res = await sign();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(ESIGN_COPY.switchedOff);
    expect(h.recordSignature).not.toHaveBeenCalled();
  });

  it("409, in the practice's own words, when the login is not linked to a staff record", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await sign();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(ESIGN_COPY.noStaffRecord);
    expect(h.recordSignature).not.toHaveBeenCalled();
  });

  it("404 for a policy that is not this practice's", async () => {
    h.getPolicy.mockResolvedValue(null);
    await expectRefusal(404, () => sign());
  });

  it("400 for a version that has been WITHDRAWN", async () => {
    h.getPolicy.mockResolvedValue(policy({ retiredAt: "2026-01-02T00:00:00.000Z" }));
    const res = await sign();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/withdrawn/i);
    expect(h.recordSignature).not.toHaveBeenCalled();
  });

  // ...but a retirement DATED IN THE FUTURE is not a withdrawal yet. Publishing v5
  // effective next month retires v4 next month; refusing here would mean nobody
  // could sign the only version the signatures tab is showing them.
  it("ACCEPTS a version whose retirement has not arrived", async () => {
    const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
    h.getPolicy.mockResolvedValue(policy({ retiredAt: nextYear }));
    const res = await sign();
    expect(res.status).toBe(200);
    expect(h.recordSignature).toHaveBeenCalledTimes(1);
  });

  it("400 for a signature the rules refuse", async () => {
    await expectRefusal(400, () => sign({ value: "" }));
  });

  it("400 for a body that is not JSON at all", async () => {
    const res = await POST(
      new Request(`http://localhost/api/hr/policy/${POLICY_ID}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      { params: Promise.resolve({ id: POLICY_ID }) },
    );
    expect(res.status).toBe(400);
    expect(h.recordSignature).not.toHaveBeenCalled();
  });

  it("500 — and NOT a cheerful ok — when the write itself fails", async () => {
    h.recordSignature.mockRejectedValue(new Error("relation does not exist"));
    const res = await sign();
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
