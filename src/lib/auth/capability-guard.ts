import "server-only";
import { authEnforced } from "./guard";
import type { AuthedUser } from "./session";
import { isDestructive, type Capability } from "@/lib/capabilities/keys";
import { getCapabilities } from "@/lib/capabilities/repository";

// ===========================================================================
// requireCapability — "may you do this thing".
//
// A SEPARATE FILE FROM guard.ts, on purpose. Every guard in guard.ts is
// SYNCHRONOUS and no-ops on a null user; this one is ASYNC and does not, and
// mixing the two postures in one file is how a reviewer stops noticing the
// difference. (The shape difference also has teeth: a forgotten `await` yields a
// truthy Promise that the route returns as a Response, so
// `destructive-route-capability-coverage.test.ts` pins the `await`.)
//
// IT COMPOSES WITH requireModuleApiAccess, IT NEVER REPLACES IT.
//   module access = may you see this area
//   capability    = may you do this thing
// A route needs both. The order is:
//   requireUser -> requireClientAccess/requireSiteAccess -> requireModuleApiAccess
//   -> requireCapability
// so an unauthorised caller learns nothing about which capabilities exist.
// ===========================================================================

/** The 403 body every other guard in this codebase answers with. */
function forbidden(): Response {
  return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
}

/**
 * The 503 a destructive act answers with when sign-in is not configured.
 *
 * Deliberately NOT "forbidden". Nobody is being refused — the environment cannot
 * tell who is asking, so it cannot let anyone do something irreversible. The
 * sentence says that in the practice's own words.
 */
function unavailable(): Response {
  return Response.json(
    {
      ok: false,
      error: "This action is unavailable because sign-in is not configured on this environment.",
    },
    { status: 503 },
  );
}

/**
 * 403 if this user does not hold the capability; 503 if the act is destructive
 * and auth is not enforced; null when the caller may proceed.
 *
 * ---------------------------------------------------------------------------
 * THE FAIL-CLOSED BRANCH IS THE WHOLE REASON THIS FUNCTION IS NOT ONE LINE.
 * ---------------------------------------------------------------------------
 * `authEnforced()` is `Boolean(SUPABASE_SERVICE_ROLE_KEY)`. When it is false,
 * `requireUser` returns null and EVERY guard downstream of it no-ops. That is
 * deliberate and right for the un-enforced pilot, and it means a naive
 * capability check enforces exactly nothing on any environment missing the key.
 *
 * A permission screen that silently enforces nothing is worse than no screen:
 * the owner ticks the boxes and believes them.
 *
 * So a DESTRUCTIVE capability refuses outright when auth is not enforced —
 * following `move-service.ts`, which already departs from the platform default
 * for exactly this reason rather than inventing a second posture. A NON-destructive
 * one passes through like every other guard, because refusing a read on an
 * environment with no sign-in would break the pilot demo to no benefit.
 *
 * Which of the two a key is comes from the CATALOG (`destructive: true`), so it
 * is data reviewed once, not a judgement each route makes and one route forgets.
 * An unrecognised key counts as destructive.
 *
 * A NULL USER WHILE ENFORCEMENT IS ON IS A THIRD CASE, AND IT IS A REFUSAL. It
 * cannot happen today (`requireUser` answers 401 first on every route that calls
 * this) and that is the argument FOR refusing rather than against bothering: an
 * unreachable branch is where a permissive default hides until something moves.
 * The un-enforced passthrough is a deliberate pilot concession, so it is spelled
 * out as one — conditional on `!authEnforced()`, never inherited by accident.
 */
export async function requireCapability(
  user: AuthedUser | null,
  capability: Capability,
): Promise<Response | null> {
  if (!user) {
    // ENFORCEMENT ON AND NOBODY THERE: REFUSE. `requireUser` answers 401 before
    // this is reached on every route today, so this branch is unreachable — which
    // is exactly why it must not be the permissive one. The day a caller reaches a
    // capability check with enforcement on and no session, the honest answer is
    // "no", not "yes because nothing else stopped you". A guard whose default is
    // allow is one refactor away from being the hole.
    if (authEnforced()) return forbidden();
    // Un-enforced pilot from here down: there is no session to check anywhere on
    // this environment, so a destructive act is refused outright (an owner
    // ticking boxes that enforce nothing is worse than no screen) and a harmless
    // read passes through, exactly like requireClientAccess.
    if (isDestructive(capability)) return unavailable();
    return null;
  }
  const held = await getCapabilities(user);
  if (!held.has(capability)) return forbidden();
  return null;
}

/**
 * The same question without the Response — for a page or a service that wants to
 * branch rather than return an HTTP answer.
 *
 * A PROJECTION OF THE GUARD, not a second copy of it. Every branch above maps
 * cleanly: 403 -> false, 503 -> false, null -> true. Written this way the
 * fail-closed policy (destructive keys refuse on an un-enforced environment, a
 * null user with enforcement on is a refusal) exists in exactly ONE function and
 * cannot desynchronise, so the screen and the route can never disagree about who
 * may do what — structurally, rather than because two comments say they must.
 */
export async function hasCapability(
  user: AuthedUser | null,
  capability: Capability,
): Promise<boolean> {
  return (await requireCapability(user, capability)) === null;
}
