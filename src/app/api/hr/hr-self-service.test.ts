import { describe, it, expect, vi, beforeEach } from "vitest";
import { canRoleAccessModule, STAFF_SLUGS } from "@/lib/nav";
import { linkMissingCopy } from "@/lib/my-work/rules";

// ===========================================================================
// THE HR LANE'S `mine=1` BRANCHES — My work's three read-only tabs.
//
// Before this, three of My work's four tabs answered 403 for the only two roles
// they exist for: every HR read was `requireModuleApiAccess("staff-hr")` plus
// `requireApproverRole`, and "staff-hr" is in neither CLINICIAN_SLUGS nor
// STAFF_SLUGS. The feature existed in the nav, the page, the role and the
// migration, and did not exist for its audience.
//
// What is under test is the pair of claims the branch makes:
//
//   1. A NURSE GETS HER OWN. The manager gates are skipped, so she gets an
//      answer at all — and the answer is narrowed at the query to the staff row
//      her SESSION resolves to, never a `staffId` she can send.
//   2. SHE GETS NOBODY ELSE'S. Most sharply on the signed-URL route, where a
//      colleague's path passes the practice-wide tenancy guard and must still be
//      refused: `isWithinOwnDocPrefix` is one segment stricter.
//
// The role predicates are the REAL ones (`canRoleAccessModule`), so if
// "staff-hr" were ever added to an allow-list, the manager-path assertions here
// stop meaning what they say and fail rather than quietly passing.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  findStaffByAppUser: vi.fn(),
  listStaffDocuments: vi.fn(),
  signStaffDocUrl: vi.fn(),
  listPolicies: vi.fn(),
  listSignatures: vi.fn(),
  listSignaturesForStaff: vi.fn(),
  isSystemEnabled: vi.fn(),
  listStaff: vi.fn(),
  getStaff: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  const { canRoleAccessModule: can } = await import("@/lib/nav");
  const { APPROVER_ROLES } = await import("@/lib/absence/rules");
  const forbidden = () => Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    // The REAL predicate behind the stand-in guard, so "staff-hr refuses these two
    // roles" is derived here exactly as it is in production.
    requireModuleApiAccess: (user: { role: string } | null, slug: string) =>
      user && !can(user.role as never, slug) ? forbidden() : null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(APPROVER_ROLES as readonly string[]).includes(user.role) ? forbidden() : null,
    requireOwnerRole: (user: { role: string } | null) =>
      user && !["agency_admin", "client_owner"].includes(user.role) ? forbidden() : null,
    authEnforced: () => true,
  };
});

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: async () => true,
}));

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: h.isSystemEnabled }));
vi.mock("@/lib/rota/repository", () => ({ listStaff: h.listStaff, getStaff: h.getStaff }));
vi.mock("@/lib/clock/repository", () => ({ findStaffByAppUser: h.findStaffByAppUser }));

vi.mock("@/lib/hr/document-repository", () => ({
  listStaffDocuments: h.listStaffDocuments,
  signStaffDocUrl: h.signStaffDocUrl,
  createStaffDocument: vi.fn(),
  newPathToken: () => "tok",
  putStaffDocObject: vi.fn(),
  removeStaffDocObject: vi.fn(),
}));

vi.mock("@/lib/hr/policy-repository", () => ({
  listPolicies: h.listPolicies,
  listSignatures: h.listSignatures,
  listSignaturesForStaff: h.listSignaturesForStaff,
  createPolicy: vi.fn(),
  retireEarlierVersions: vi.fn(),
}));

import { GET as documentGet } from "./document/route";
import { GET as documentUrlGet } from "./document/url/route";
import { GET as policyGet } from "./policy/route";

const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };
const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };

const MINE = "00000000-0000-0000-0000-0000000000f1";
const THEIRS = "00000000-0000-0000-0000-0000000000f2";
const MY_STAFF = { id: MINE, name: "Amina", role: "nurse", siteId: "site-n15" };

const MY_PATH = `staff-docs/vitality/${MINE}/tok/dbs.pdf`;
const THEIR_PATH = `staff-docs/vitality/${THEIRS}/tok/dbs.pdf`;

function doc(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    clientId: "vitality",
    staffId: MINE,
    kind: "dbs",
    label: "DBS certificate",
    storagePath: MY_PATH,
    mime: "application/pdf",
    sizeBytes: 1024,
    expiresOn: null,
    retainUntil: null,
    uploadedBy: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...over,
  };
}

function policy(over: Record<string, unknown> = {}) {
  return {
    id: "pol-1",
    clientId: "vitality",
    slug: "health-and-safety",
    title: "Health and safety",
    version: 2,
    storagePath: "staff-docs/vitality/policies/tok/hs.pdf",
    mime: "application/pdf",
    sizeBytes: 2048,
    effectiveFrom: "2026-01-01",
    retiredAt: null,
    createdBy: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...over,
  };
}

function signature(staffId: string) {
  return {
    id: `sig-${staffId}`,
    clientId: "vitality",
    staffId,
    policyId: "pol-1",
    policyVersion: 2,
    signature: { method: "typed", value: "Amina" },
    signedAt: "2026-02-01T09:00:00.000Z",
    ipHash: "hash",
    userAgent: "ua",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(NURSE);
  h.requireCapability.mockResolvedValue(null);
  h.findStaffByAppUser.mockResolvedValue(MY_STAFF);
  h.listStaffDocuments.mockResolvedValue({ ready: true, documents: [doc()] });
  h.signStaffDocUrl.mockResolvedValue("https://storage.example/signed");
  h.listPolicies.mockResolvedValue({ ready: true, policies: [policy()] });
  h.listSignatures.mockResolvedValue({ ready: true, signatures: [signature(MINE), signature(THEIRS)] });
  h.listSignaturesForStaff.mockResolvedValue({ ready: true, signatures: [signature(MINE)] });
  h.isSystemEnabled.mockResolvedValue(true);
  h.listStaff.mockResolvedValue([{ id: MINE, name: "Amina", role: "nurse" }]);
});

describe("the premise: staff-hr refuses the two roles My work is for", () => {
  it("is derived from the real predicate, not asserted", () => {
    expect(canRoleAccessModule("client_staff", "staff-hr")).toBe(false);
    expect(canRoleAccessModule("client_clinician", "staff-hr")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "staff-hr")).toBe(true);
    // ...while the surface these branches serve is one both roles hold, which is
    // why a gate naming it would have been no gate at all.
    expect(STAFF_SLUGS.has("my-work")).toBe(true);
  });
});

describe("GET /api/hr/document?mine=1 — my own vault", () => {
  const url = (q: string) => documentGet(new Request(`http://localhost/api/hr/document?${q}`));

  it("reads the vault of the staff row the SESSION resolves to", async () => {
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(200);
    expect(h.listStaffDocuments).toHaveBeenCalledWith("vitality", MINE);
    expect((await res.json()).documents).toHaveLength(1);
  });

  it("IGNORES a staffId in the query", async () => {
    await url(`client=vitality&mine=1&staffId=${THEIRS}`);
    expect(h.listStaffDocuments).toHaveBeenCalledWith("vitality", MINE);
    expect(h.listStaffDocuments).not.toHaveBeenCalledWith("vitality", THEIRS);
  });

  it("does not ask for the manager's capability, which a nurse does not hold", async () => {
    await url("client=vitality&mine=1");
    expect(h.requireCapability).not.toHaveBeenCalled();
  });

  it("answers 409 with the link copy when the login is not linked", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(linkMissingCopy("there are no documents to show"));
    expect(h.listStaffDocuments).not.toHaveBeenCalled();
  });

  it("'not set up yet' is reported as such, never as an empty vault", async () => {
    h.listStaffDocuments.mockResolvedValue({ ready: false, documents: [] });
    const body = await (await url("client=vitality&mine=1")).json();
    expect(body.ready).toBe(false);
    expect(body.note).toBeTruthy();
  });

  it("a read error is a loud failure, not an empty file", async () => {
    h.listStaffDocuments.mockRejectedValue(new Error("connection reset"));
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("read-failed");
  });

  it("WITHOUT mine=1 the nurse is still refused, so the branch is the only way in", async () => {
    const res = await url(`client=vitality&staffId=${THEIRS}`);
    expect(res.status).toBe(403);
    expect(h.listStaffDocuments).not.toHaveBeenCalled();
  });

  it("the manager's named-person read is unchanged", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const res = await url(`client=vitality&staffId=${THEIRS}`);
    expect(res.status).toBe(200);
    expect(h.listStaffDocuments).toHaveBeenCalledWith("vitality", THEIRS);
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "hr.view-documents");
  });
});

describe("GET /api/hr/document/url?mine=1 — a link to MY document and no other", () => {
  const url = (q: string) => documentUrlGet(new Request(`http://localhost/api/hr/document/url?${q}`));

  it("signs my own document", async () => {
    const res = await url(`client=vitality&mine=1&path=${encodeURIComponent(MY_PATH)}`);
    expect(res.status).toBe(200);
    expect(h.signStaffDocUrl).toHaveBeenCalledWith(MY_PATH, 120);
  });

  it("REFUSES A COLLEAGUE'S PATH, which the practice-wide tenancy guard would admit", async () => {
    // The sharpest test in this file. `isWithinStaffDocPrefix` says yes to this
    // path — it IS this practice's — and a self-service branch that used only that
    // guard would mint a signed URL for somebody else's passport.
    const res = await url(`client=vitality&mine=1&path=${encodeURIComponent(THEIR_PATH)}`);
    expect(res.status).toBe(403);
    expect(h.signStaffDocUrl).not.toHaveBeenCalled();
  });

  it("refuses a traversal and the patient-document bucket", async () => {
    for (const path of [
      `staff-docs/vitality/${MINE}/../${THEIRS}/dbs.pdf`,
      `onboarding/vitality/${MINE}/passport.pdf`,
      "staff-docs/vitality/policies/tok/handbook.pdf",
    ]) {
      const res = await url(`client=vitality&mine=1&path=${encodeURIComponent(path)}`);
      expect(res.status, `${path} must be refused`).toBe(403);
    }
    expect(h.signStaffDocUrl).not.toHaveBeenCalled();
  });

  it("answers 409 when the login is not linked, and signs nothing", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await url(`client=vitality&mine=1&path=${encodeURIComponent(MY_PATH)}`);
    expect(res.status).toBe(409);
    expect(h.signStaffDocUrl).not.toHaveBeenCalled();
  });

  it("a missing object is a 404, not a broken link handed to the browser", async () => {
    h.signStaffDocUrl.mockResolvedValue(null);
    const res = await url(`client=vitality&mine=1&path=${encodeURIComponent(MY_PATH)}`);
    expect(res.status).toBe(404);
  });

  it("the manager may still open anybody's, and a nurse without mine=1 may open nothing", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await url(`client=vitality&path=${encodeURIComponent(THEIR_PATH)}`)).status).toBe(200);

    h.requireUser.mockResolvedValue(NURSE);
    expect((await url(`client=vitality&path=${encodeURIComponent(MY_PATH)}`)).status).toBe(403);
  });
});

describe("GET /api/hr/policy?mine=1 — the policies I owe, and MY signatures only", () => {
  const url = (q: string) => policyGet(new Request(`http://localhost/api/hr/policy?${q}`));

  it("narrows the signatures at the query, not after reading everybody's", async () => {
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(200);
    expect(h.listSignaturesForStaff).toHaveBeenCalledWith("vitality", MINE);
    // The practice-wide read is never made: it would pull every signature in the
    // building into this process to answer a question about one person.
    expect(h.listSignatures).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.signatures.map((s: { staffId: string }) => s.staffId)).toEqual([MINE]);
  });

  it("makes the sign route reachable at last: the nurse can LIST what she owes", async () => {
    // POST /api/hr/policy/[id]/sign was always self-service; without this branch
    // there was no way to see the policy in order to reach it.
    const body = await (await url("client=vitality&mine=1")).json();
    expect(body.policies).toHaveLength(1);
    expect(body.mine).toBe(true);
  });

  it("returns no staff list and never offers publishing", async () => {
    const body = await (await url("client=vitality&mine=1")).json();
    expect(body.staff).toBeUndefined();
    expect(body.canPublish).toBe(false);
  });

  it("returns SUMMARIES, never the stored signature value back", async () => {
    const body = await (await url("client=vitality&mine=1")).json();
    // The typed name IS the signature value here, so its absence from the whole
    // payload is the assertion: not even the person who signed gets it served back.
    expect(JSON.stringify(body)).not.toContain("Amina");
    expect(body.signatures[0].signature.method).toBe("typed");
    expect(Object.keys(body.signatures[0].signature)).not.toContain("value");
  });

  it("carries the kill-switch and not-ready states through honestly", async () => {
    h.isSystemEnabled.mockResolvedValue(false);
    expect((await (await url("client=vitality&mine=1")).json()).enabled).toBe(false);

    h.listPolicies.mockResolvedValue({ ready: false, policies: [] });
    const body = await (await url("client=vitality&mine=1")).json();
    expect(body.ready).toBe(false);
    expect(body.note).toBeTruthy();
  });

  it("answers 409 when the login is not linked, and reads no policies", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(linkMissingCopy("there is nothing here to sign"));
    expect(h.listPolicies).not.toHaveBeenCalled();
  });

  it("a read error is loud, never an empty library", async () => {
    h.listPolicies.mockRejectedValue(new Error("connection reset"));
    const res = await url("client=vitality&mine=1");
    expect(res.status).toBe(500);
  });

  it("the clinician reaches it through the same branch", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    expect((await url("client=vitality&mine=1")).status).toBe(200);
  });

  it("WITHOUT mine=1 both roles are still refused the compliance view", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await url("client=vitality")).status, `${user.role}`).toBe(403);
    }
    expect(h.listPolicies).not.toHaveBeenCalled();
  });

  it("the manager's compliance view is unchanged: everybody's signatures and the team", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const body = await (await url("client=vitality")).json();
    expect(h.listSignatures).toHaveBeenCalledWith("vitality");
    expect(h.listSignaturesForStaff).not.toHaveBeenCalled();
    expect(body.staff).toHaveLength(1);
    expect(body.signatures).toHaveLength(2);
  });
});
