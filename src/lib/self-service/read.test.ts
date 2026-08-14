import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ findStaffByAppUser: vi.fn() }));
vi.mock("@/lib/clock/repository", () => ({ findStaffByAppUser: h.findStaffByAppUser }));

import { selfServiceRequested, resolveSelfStaff } from "./read";
import { linkMissingCopy } from "@/lib/my-work/rules";
import type { AuthedUser } from "@/lib/auth/session";

// ===========================================================================
// The self-service seam. Four routes rest on these two functions, and between
// them they hand a member of staff their rota, their documents and the policies
// they are asked to sign — with none of the manager guards in the way, because
// every one of those guards refuses the role the surface is for.
//
// So what is actually under test is the pair of properties that stand in for
// those guards: the branch is entered ONLY on the exact opt-in, and the staff
// row can only ever be the session's.
// ===========================================================================

const NURSE: AuthedUser = {
  id: "u-nurse",
  name: "Amina",
  email: "a@example.com",
  role: "client_staff",
  clientId: "vitality",
  siteIds: ["site-n15"],
};

const MY_STAFF = { id: "staff-1", name: "Amina", role: "nurse", siteId: "site-n15" };

function url(query: string): URL {
  return new URL(`http://localhost/api/whatever${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findStaffByAppUser.mockResolvedValue(MY_STAFF);
});

describe("selfServiceRequested: exactly mine=1, and nothing that merely looks like it", () => {
  it("is true for the contract's own value", () => {
    expect(selfServiceRequested(url("?client=vitality&mine=1"))).toBe(true);
  });

  it.each(["", "?client=vitality", "?mine=", "?mine=0", "?mine=true", "?mine=yes", "?mine=2", "?Mine=1"])(
    "is false for '%s'",
    (query) => {
      // A route that guessed here would be deciding, on a caller's typo, whether to
      // run the manager's guards or skip them. Both wrong answers are bad: one
      // refuses a nurse her own rota, the other drops the approver check on a
      // manager's read.
      expect(selfServiceRequested(url(query))).toBe(false);
    },
  );
});

describe("resolveSelfStaff: the staff row comes from the session and can come from nowhere else", () => {
  it("asks the repository with the CLIENT and the SESSION's user id, and nothing else", async () => {
    const result = await resolveSelfStaff("vitality", NURSE, "there is nothing to show");
    expect(h.findStaffByAppUser).toHaveBeenCalledWith("vitality", "u-nurse");
    expect(result.ok).toBe(true);
    expect(result.ok && result.staff.id).toBe("staff-1");
  });

  it("takes no staff id at all: its signature is (clientId, auth, consequence)", () => {
    // Stated as an assertion rather than left to review. A fourth parameter that
    // was a staff id would make every caller a potential IDOR, and this is the one
    // place it could be introduced for all four routes at once.
    expect(resolveSelfStaff.length).toBe(3);
  });

  it("answers 409 with the practice's own wording when the login is not linked", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const result = await resolveSelfStaff("vitality", NURSE, "there are no shifts to show");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(409);
    const body = (await result.response.json()) as { error: string };
    // The SAME sentence the clocking route and My work already use, imported
    // rather than retyped, so a person who meets this twice meets it twice the same.
    expect(body.error).toBe(linkMissingCopy("there are no shifts to show"));
  });

  it("resolves to NOBODY when there is no session, rather than to everybody", async () => {
    // On an environment with no sign-in configured `requireUser()` yields null and
    // every role guard in this codebase no-ops. This branch has no role guard to
    // no-op, so it must fail closed by itself.
    const result = await resolveSelfStaff("vitality", null, "there is nothing to show");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.response.status).toBe(409);
    expect(h.findStaffByAppUser).not.toHaveBeenCalled();
  });

  it("a failed lookup is a 503 failure, never 'you are not linked' and never an empty list", async () => {
    h.findStaffByAppUser.mockRejectedValue(new Error("connection reset"));
    const result = await resolveSelfStaff("vitality", NURSE, "there is nothing to show");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain("Nothing is shown");
    // ...and it does not repeat the link copy, which would send somebody to their
    // practice manager to fix a database outage.
    expect(body.error).not.toContain("not linked to a staff record");
  });
});
