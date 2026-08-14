import type { AuthedUser } from "@/lib/auth/session";
import type { Role } from "@/lib/types";

// ===========================================================================
// WHO MAY SEE WHAT SOMEBODY IS PAID.
//
// This is the ONE permission in the HR lane that is narrower than the module.
// The practice manager runs the rota, the holiday, the attendance and the
// month's hours; she is a `client_coordinator`, and she must not see what
// individuals are paid. So "may open Staff HR" and "may see pay" are two
// different questions, and the second one is answered here.
//
// ---------------------------------------------------------------------------
// PURE ON PURPOSE. No `import "server-only"`, no env, no DB. `AuthedUser` and
// `Role` are TYPE-only imports, which TypeScript erases, so vitest (node env)
// can import this file directly and the rule is tested rather than believed.
// ---------------------------------------------------------------------------
//
// THE SWAP HAPPENED, AND THIS FILE IS NOW THE DEFAULT RATHER THAN THE GUARD.
//
// The granular permissions layer expresses this as the capability `hr.view-pay`
// (owner + agency by default, coordinator OFF, grantable per person), and in the
// integration phase the three routes moved onto it: /api/hr/profile/pay-rate calls
// `requireCapability(auth, "hr.view-pay")`, and /api/hr/profile and
// /api/hours/month decide whether to BUILD the pay fields with
// `hasCapability(auth, "hr.view-pay")`.
//
// The swap had to happen at the CALL SITES rather than inside `requirePayAccess`,
// which is what the original plan said. The reason is the line below this comment:
// this module is PURE, and `requireCapability` imports "server-only", the session
// and the override repository. Rewriting the helper here would have made the file
// unimportable by its own test — the rule would have stopped being tested on the
// day it started being enforced.
//
// SO WHAT IS LEFT HERE IS THE DEFAULT, AND IT IS LOAD-BEARING.
// `PAY_ACCESS_ROLES` is the roster `hr.view-pay` defaults to, and
// `capabilities/non-widening.test.ts` derives the capability's default holders
// from this constant rather than restating them. Change this list and the
// capability's defaults change with it, in one place, provably.
//
// `canSeePay` / `requirePayAccess` have no callers left in the app. They are kept,
// with their tests, as the pure statement of the rule the capability layer now
// carries — and as the answer for any surface that needs it without a session
// (there is none today). Nothing should call them again in preference to the
// capability: a per-person grant is invisible to a role list.
//
// ---------------------------------------------------------------------------
// THE RULE THIS FILE EXISTS TO ENFORCE: OMIT, DO NOT HIDE.
// ---------------------------------------------------------------------------
// A pay column hidden with CSS, or dropped by a React component, is still in the
// JSON that reached the browser. Every caller of this module omits the fields
// SERVER SIDE — `buildMonthReport({ includeCost: false })` does not set the keys
// at all, and the HR profile route never even reads the rate table without pay
// access. A route that fetched rates and then filtered them in the response
// would already have failed.
// ===========================================================================

/**
 * The roles that may see pay, today.
 *
 * The same two roles as `requireOwnerRole`, and deliberately a SEPARATE list:
 * they answer different questions and will diverge the moment `hr.view-pay` is
 * granted to one named coordinator. Keeping the list here means that grant
 * changes one file.
 */
export const PAY_ACCESS_ROLES: readonly Role[] = ["agency_admin", "client_owner"] as const;

/**
 * Whether this session may see pay.
 *
 * A NULL user means auth enforcement is off (no SUPABASE_SERVICE_ROLE_KEY, the
 * un-enforced pilot), and every other guard in this codebase passes through in
 * that state. This one does the same, so the demo keeps showing the whole
 * feature; the moment enforcement is on, a coordinator is refused.
 */
export function canSeePay(user: AuthedUser | null): boolean {
  if (!user) return true;
  return PAY_ACCESS_ROLES.includes(user.role);
}

/** Whether a bare role may see pay. The pure core `canSeePay` is built on. */
export function roleCanSeePay(role: Role): boolean {
  return PAY_ACCESS_ROLES.includes(role);
}

/**
 * 403 Response if this session may not see pay; else null.
 *
 * Same shape as every guard in `@/lib/auth/guard` (return the Response directly,
 * no-op on a null user) so it composes into the existing chain without a caller
 * having to think about it.
 *
 * NOTE FOR THE ROUTES: this helper is NOT one of the tokens the API coverage
 * sweeps recognise as authorisation, and it must never be a route's only guard.
 * Every route that calls it also carries `requireOwnerRole` /
 * `requireApproverRole`, which is both correct (pay access is narrower than the
 * module, not a substitute for it) and what keeps the sweeps honest.
 */
export function requirePayAccess(user: AuthedUser | null): Response | null {
  if (canSeePay(user)) return null;
  return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
}
