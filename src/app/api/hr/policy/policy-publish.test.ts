import { describe, it, expect, vi, beforeEach } from "vitest";
import { currentPolicies, type StaffPolicy } from "@/lib/hr/esign";

// ===========================================================================
// PUBLISHING A NEW VERSION RETIRES THE OLD ONE **WHEN THE NEW ONE TAKES EFFECT**.
//
// `currentPolicies` skips a retired version AND a not-yet-effective one. So
// retiring the predecessor at `now` while the successor is dated for next month
// leaves the slug with NOTHING in force for the gap: it disappears from the
// signatures tab, `outstandingPolicies` stops asking anybody to sign, and a
// person who owed a signature on v1 shows as owing nothing.
//
// The route is tested for the ARGUMENT it passes, and the pure rule is then
// exercised against the state that argument produces, so the two halves of the
// fix are pinned together rather than separately.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  isSystemEnabled: vi.fn(),
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  retireEarlierVersions: vi.fn(),
  putStaffDocObject: vi.fn(),
  removeStaffDocObject: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: () => null,
  requireModuleApiAccess: () => null,
  requireApproverRole: () => null,
  requireOwnerRole: () => null,
  authEnforced: () => true,
}));

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: async () => true,
}));

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: h.isSystemEnabled }));
vi.mock("@/lib/rota/repository", () => ({ listStaff: vi.fn(async () => []), getStaff: vi.fn() }));

vi.mock("@/lib/hr/document-repository", () => ({
  newPathToken: () => "tok",
  putStaffDocObject: h.putStaffDocObject,
  removeStaffDocObject: h.removeStaffDocObject,
}));

vi.mock("@/lib/hr/policy-repository", () => ({
  listPolicies: h.listPolicies,
  listSignatures: vi.fn(),
  listSignaturesForStaff: vi.fn(),
  createPolicy: h.createPolicy,
  retireEarlierVersions: h.retireEarlierVersions,
}));

import { POST } from "./route";

const OWNER = {
  id: "u-own",
  email: "o@x",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-n15"],
};

function policy(over: Partial<StaffPolicy> = {}): StaffPolicy {
  return {
    id: "pol-1",
    clientId: "vitality",
    slug: "health-and-safety",
    title: "Health and safety",
    version: 1,
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

/** A publish request for `slug` taking effect on `effectiveFrom`. */
function publish(effectiveFrom: string): Promise<Response> {
  const form = new FormData();
  form.set("clientSlug", "vitality");
  form.set("title", "Health and safety");
  form.set("slug", "health-and-safety");
  form.set("effectiveFrom", effectiveFrom);
  form.set(
    "file",
    new File([new Uint8Array([1, 2, 3])], "hs.pdf", { type: "application/pdf" }),
  );
  return POST(new Request("http://localhost/api/hr/policy", { method: "POST", body: form }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER);
  h.requireCapability.mockResolvedValue(null);
  h.isSystemEnabled.mockResolvedValue(true);
  h.listPolicies.mockResolvedValue({ ready: true, policies: [policy()] });
  h.putStaffDocObject.mockResolvedValue(false);
  h.createPolicy.mockImplementation(async (input: Record<string, unknown>) => policy(input));
  h.retireEarlierVersions.mockResolvedValue(true);
});

describe("POST /api/hr/policy — when the predecessor is retired", () => {
  it("retires it at the instant the NEW version takes effect, not at publication time", async () => {
    const res = await publish("2026-09-01");
    expect(res.status).toBe(200);

    expect(h.retireEarlierVersions).toHaveBeenCalledTimes(1);
    const [clientId, slug, belowVersion, atIso] = h.retireEarlierVersions.mock.calls[0];
    expect(clientId).toBe("vitality");
    expect(slug).toBe("health-and-safety");
    expect(belowVersion).toBe(2);
    // London midnight opening 1 September 2026, i.e. 23:00Z on 31 August (BST) —
    // NOT `new Date().toISOString()`, which is what the bug looked like.
    expect(atIso).toBe("2026-08-31T23:00:00.000Z");
  });

  it("retires it immediately when the new version takes effect today", async () => {
    await publish("2026-08-14");
    expect(h.retireEarlierVersions.mock.calls[0][3]).toBe("2026-08-13T23:00:00.000Z");
  });

  it("leaves the slug with a policy in force for every day of the gap", async () => {
    await publish("2026-09-01");
    const retiredAt = h.retireEarlierVersions.mock.calls[0][3] as string;

    // The state the route just wrote: v1 retiring on 1 Sep, v2 effective 1 Sep.
    const rows = [
      policy({ id: "v1", version: 1, retiredAt }),
      policy({ id: "v2", version: 2, effectiveFrom: "2026-09-01" }),
    ];

    for (const day of ["2026-08-14", "2026-08-31", "2026-09-01", "2026-09-02"]) {
      const inForce = currentPolicies(rows, day).map((p) => p.id);
      expect(inForce, `nothing in force on ${day}`).toHaveLength(1);
      expect(inForce[0]).toBe(day < "2026-09-01" ? "v1" : "v2");
    }
  });
});
