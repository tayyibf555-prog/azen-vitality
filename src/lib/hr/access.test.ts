import { describe, it, expect } from "vitest";
import { PAY_ACCESS_ROLES, canSeePay, requirePayAccess, roleCanSeePay } from "./access";
import type { AuthedUser } from "@/lib/auth/session";
import type { Role } from "@/lib/types";

const ALL_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
];

function user(role: Role): AuthedUser {
  return { id: "u1", name: "Test", email: "t@example.com", role, clientId: "vitality", siteIds: ["site-cc"] };
}

describe("pay access", () => {
  it("admits the owner and the agency admin", () => {
    expect(canSeePay(user("client_owner"))).toBe(true);
    expect(canSeePay(user("agency_admin"))).toBe(true);
  });

  it("REFUSES the practice manager, which is the whole point of the permission", () => {
    // Blerta's stated requirement: she runs the rota, the holiday and the month's
    // hours, and must not see what individuals are paid.
    expect(canSeePay(user("client_coordinator"))).toBe(false);
    expect(requirePayAccess(user("client_coordinator"))).toBeInstanceOf(Response);
  });

  it("refuses the clinician and the staff role too", () => {
    expect(canSeePay(user("client_clinician"))).toBe(false);
    expect(canSeePay(user("client_staff"))).toBe(false);
  });

  it("exactly two of the five roles hold it (a widened list fails here)", () => {
    expect(ALL_ROLES.filter(roleCanSeePay)).toEqual(["agency_admin", "client_owner"]);
    expect(PAY_ACCESS_ROLES).toHaveLength(2);
  });

  it("passes through when auth enforcement is off, like every other guard", () => {
    // A null user is the un-enforced pilot, not an anonymous caller: requireUser
    // has already returned 401 for that.
    expect(canSeePay(null)).toBe(true);
    expect(requirePayAccess(null)).toBeNull();
  });

  it("returns a 403 Response, not a throw, so a route can return it directly", async () => {
    const denied = requirePayAccess(user("client_coordinator"));
    expect(denied).toBeInstanceOf(Response);
    expect(denied!.status).toBe(403);
    await expect(denied!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns null (never a Response) for a holder, so the chain continues", () => {
    expect(requirePayAccess(user("client_owner"))).toBeNull();
    expect(requirePayAccess(user("agency_admin"))).toBeNull();
  });
});
