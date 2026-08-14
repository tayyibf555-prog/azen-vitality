import "server-only";
import { findStaffByAppUser } from "@/lib/clock/repository";
import { linkMissingCopy } from "@/lib/my-work/rules";
import type { AuthedUser } from "@/lib/auth/session";
import type { ClockStaff } from "@/lib/clock/types";

// ===========================================================================
// THE SELF-SERVICE SEAM: `mine=1`, resolved from the session and nothing else.
//
// Four routes owned by three different lanes (the rota, the document vault, the
// policy library) each serve TWO callers: a manager reading somebody else's
// record, and a member of staff reading their own. My work's contract
// (src/components/client/my-work/shared.ts) states what the second one means,
// and this module is the one implementation of it, because four hand-rolled
// copies of "work out who is asking" is four chances to read the staff id from
// the wrong place.
//
// WHAT `mine=1` MEANS, and why this is a function rather than a convention:
//
//   * `resolveSelfStaff` TAKES NO STAFF ID. Not from the body, not from the
//     query, not as a parameter. Its signature is (clientId, auth) and the only
//     way to a staff row through it is `rota_staff.app_user_id` = the verified
//     session's user. A caller cannot ask it about anybody else, so there is
//     nothing to spoof and no branch to get wrong.
//   * the manager's guards (the module gate, the approver role, the manager
//     capability) are NOT applied on this branch, because every one of them
//     refuses `client_staff` — the role the surface exists for. That is the
//     whole reason the branch exists and is exactly what the API coverage
//     sweep's `kind: "self-service"` category records, with a structural check.
//   * an unlinked login gets a 409 that SAYS SO, in the wording the clocking
//     route already uses, never a cheerful empty list. "You have no documents"
//     and "we do not know who you are" are opposite statements.
//
// THE TENANCY LOCK IS STILL THE ROUTE'S: every caller runs
// requireUser -> requireClientAccess before it gets here, and this read is
// client-scoped on top of that.
// ===========================================================================

/**
 * Is this the self-service branch?
 *
 * EXACTLY `mine=1`. Not "mine is present", not "mine is truthy": a bare `?mine`
 * or `mine=0` is a caller who does not know the contract, and guessing on their
 * behalf is how a manager's read silently becomes somebody's own.
 */
export function selfServiceRequested(url: URL): boolean {
  return url.searchParams.get("mine") === "1";
}

/** The caller's own staff row, or the Response the route should return instead. */
export type SelfStaffResolution =
  | { ok: true; staff: ClockStaff }
  | { ok: false; response: Response };

/**
 * Resolve the SESSION's staff record for a self-service read.
 *
 * @param consequence a lower-case clause completing "…so <consequence>", so the
 *   409 reads as English on whichever surface asked ("there are no shifts to
 *   show", "there are no documents to show").
 */
export async function resolveSelfStaff(
  clientId: string,
  auth: AuthedUser | null,
  consequence: string,
): Promise<SelfStaffResolution> {
  const unlinked = (): SelfStaffResolution => ({
    ok: false,
    // 409, not 403: nothing is forbidden here. The person is allowed to ask about
    // themselves; we simply cannot work out which staff record is theirs, and the
    // remedy is a link the practice manager makes.
    response: Response.json({ ok: false, error: linkMissingCopy(consequence) }, { status: 409 }),
  });

  // No session at all (sign-in not configured on this environment) resolves to
  // nobody rather than to everybody. Fail-closed in the only direction that is
  // safe for a route with no role guard on this branch.
  if (!auth) return unlinked();

  let staff: ClockStaff | null;
  try {
    staff = await findStaffByAppUser(clientId, auth.id);
  } catch {
    // LOUD. A failed lookup is a failure to answer, never "you are not linked" and
    // certainly never an empty list of somebody's own documents.
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "We could not look up your staff record just now. Nothing is shown rather than a wrong list — try again in a moment." },
        { status: 503 },
      ),
    };
  }
  if (!staff) return unlinked();
  return { ok: true, staff };
}
