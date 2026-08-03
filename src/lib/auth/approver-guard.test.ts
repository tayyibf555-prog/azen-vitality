// `requireApproverRole` is a NEW, additive guard. Two claims matter and both are
// pinned here: it admits the practice manager (a client_coordinator, the person who
// actually approves holiday), and it refuses the clinician. The third claim is that
// `requireOwnerRole` is unchanged, so the same cases are asserted against it too:
// if a later edit "simplifies" the two into one function, this file fails.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The guard module only needs the AuthedUser TYPE from ./session, but importing it
// for real pulls in the Supabase auth server. Stub it: nothing here calls it.
vi.mock("./session", () => ({
  canAccessClient: () => true,
  getSessionUser: async () => null,
}));

import { requireApproverRole, requireOwnerRole } from "./guard";
import { APPROVER_ROLES } from "@/lib/absence/rules";
import type { AuthedUser } from "./session";
import type { Role } from "@/lib/types";

function user(role: Role): AuthedUser {
  return { id: `user-${role}`, name: "Test", email: "t@example.com", role, clientId: "vitality", siteIds: ["site-cc"] };
}

describe("requireApproverRole", () => {
  it("admits the agency admin, the owner and the coordinator", () => {
    expect(requireApproverRole(user("agency_admin"))).toBe(null);
    expect(requireApproverRole(user("client_owner"))).toBe(null);
    expect(requireApproverRole(user("client_coordinator"))).toBe(null);
  });

  it("refuses the clinician with a 403", async () => {
    const denied = requireApproverRole(user("client_clinician"));
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("is a no-op when auth enforcement is off (null user), like every other guard", () => {
    expect(requireApproverRole(null)).toBe(null);
  });

  it("uses the same role list the pure decision rules use", () => {
    for (const role of APPROVER_ROLES) expect(requireApproverRole(user(role))).toBe(null);
  });
});

describe("requireOwnerRole is untouched by the absence work", () => {
  it("still admits only the owner and the agency admin", () => {
    expect(requireOwnerRole(user("agency_admin"))).toBe(null);
    expect(requireOwnerRole(user("client_owner"))).toBe(null);
  });

  it("still refuses the coordinator with a 403 (the whole reason a second guard exists)", () => {
    const denied = requireOwnerRole(user("client_coordinator"));
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
  });

  it("still refuses the clinician", () => {
    expect(requireOwnerRole(user("client_clinician"))?.status).toBe(403);
  });
});
