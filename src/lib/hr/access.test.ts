import { describe, it, expect } from "vitest";
import { PAY_ACCESS_ROLES } from "./access";
import type { Role } from "@/lib/types";

const ALL_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
];

// ===========================================================================
// The three helpers this file used to test — `canSeePay`, `roleCanSeePay` and
// `requirePayAccess` — are gone. The rule they carried is now the `hr.view-pay`
// capability, and a role check kept alongside it would be actively wrong: a
// per-person grant to a named coordinator is invisible to a role list.
//
// What survives is the DEFAULT ROSTER, and it is load-bearing: `hr.view-pay`
// takes its default holders from this constant, so a widened list here quietly
// widens the capability. That is the claim worth pinning.
// ===========================================================================

describe("who may see pay, by default", () => {
  it("exactly two of the five roles hold it (a widened list fails here)", () => {
    expect(ALL_ROLES.filter((r) => PAY_ACCESS_ROLES.includes(r))).toEqual([
      "agency_admin",
      "client_owner",
    ]);
    expect(PAY_ACCESS_ROLES).toHaveLength(2);
  });

  it("EXCLUDES the practice manager, which is the whole point of the permission", () => {
    // Blerta's stated requirement: she runs the rota, the holiday and the month's
    // hours, and must not see what individuals are paid.
    expect(PAY_ACCESS_ROLES).not.toContain("client_coordinator");
    expect(PAY_ACCESS_ROLES).not.toContain("client_clinician");
    expect(PAY_ACCESS_ROLES).not.toContain("client_staff");
  });

  // That this roster IS what `hr.view-pay` defaults to is pinned where the
  // derivation lives — capabilities/non-widening.test.ts:435 — rather than
  // restated here, which would be a second copy of the same claim.
});
