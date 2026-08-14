import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  buildSetPasswordLink,
  canChangeRole,
  canDeactivate,
  canLinkStaff,
  canReactivate,
  friendlyLinkError,
  inviteDeliveryMode,
  isInvitableRole,
  type Decision,
} from "@/lib/provisioning/rules";
import {
  clearStaffLinkForPerson,
  findAuthUserId,
  generateInviteToken,
  generateRecoveryToken,
  inviteByEmail,
  provisioningAvailable,
  readPeople,
  sendRecoveryEmail,
  setAuthBanned,
  setStaffLink,
  updatePersonRole,
} from "@/lib/provisioning/repository";
import type { Person } from "@/lib/provisioning/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// PATCH /api/people/[id] — the four things an owner can do to somebody's access.
//
//   { action: "role",          role }      change their access level
//   { action: "deactivate" }               ban the login (fully reversible)
//   { action: "reactivate" }               lift the ban
//   { action: "link-staff",    staffId }   point a rota_staff row at this login,
//                                          or clear it with staffId: null
//   { action: "resend-invite" }            a fresh one-time set-password link
//
// requireUser -> requireClientAccess -> requireOwnerRole on every one of them.
//
// EVERY DECISION IS MADE BY A PURE FUNCTION IN `@/lib/provisioning/rules`, not here.
// This file resolves the actor and the target from storage, hands them to the rule,
// and returns the rule's own sentence on refusal. The two that matter — you cannot
// deactivate or demote YOURSELF, and the last active owner cannot be deactivated or
// demoted — are what stop a practice locking itself out of its own platform, and
// they are under mutation test in rules.test.ts rather than asserted by this comment.
//
// LINKING IS THE MISSING WRITER. `rota_staff.app_user_id` has been read since 0068
// (`findStaffByAppUser`, the whole basis of self-service clocking) and written by
// NOTHING. It is written here, scoped by client on both sides, and never by the
// rota's own routes — `PATCH /api/rota/staff/[id]` belongs to another builder and is
// not touched by this change.
// ===========================================================================

type Action = "role" | "deactivate" | "reactivate" | "link-staff" | "resend-invite";

const ACTIONS: readonly Action[] = ["role", "deactivate", "reactivate", "link-staff", "resend-invite"];

const UNAVAILABLE =
  "User provisioning is not switched on in this environment: it needs the Supabase service-role key.";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** A rule refusal is a 400 with the rule's own words — never a bare "forbidden". */
function refuse(decision: Decision): Response | null {
  return decision.ok ? null : bad(decision.error);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug =
    (typeof body.client === "string" ? body.client : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  if (!provisioningAvailable()) return bad(UNAVAILABLE, 503);
  // FAIL CLOSED: changing somebody's access without a named actor would make the
  // self-deactivation rule vacuous, and that rule is the lockout guard.
  if (!auth) return bad("Sign in as an owner to change somebody's access.", 403);

  const action = typeof body.action === "string" ? (body.action as Action) : ("" as Action);
  if (!ACTIONS.includes(action)) return bad("Unknown action");

  let view;
  try {
    view = await readPeople(client.id, Date.now());
  } catch (e) {
    console.error("[people] PATCH read failed", e);
    return bad("Could not read this practice's logins, so nothing was changed.", 500);
  }

  const target: Person | undefined = view.people.find((p) => p.id === id);
  if (!target) return bad("That person was not found in this practice.", 404);

  const actor = { id: auth.id, role: auth.role };
  const ctx = { actor, target: { id: target.id, role: target.role, authStatus: target.authStatus }, activeOwnerCount: view.activeOwnerCount };

  try {
    if (action === "role") {
      const nextRole = typeof body.role === "string" ? body.role : "";
      const refusal = refuse(canChangeRole({ ...ctx, nextRole }));
      if (refusal) return refusal;
      if (!isInvitableRole(nextRole)) return bad("Choose one of the four access levels."); // narrows the type
      await updatePersonRole(client.id, target.id, nextRole);
      return Response.json({ ok: true, id: target.id, role: nextRole });
    }

    if (action === "deactivate" || action === "reactivate") {
      const wantBanned = action === "deactivate";
      const refusal = refuse(wantBanned ? canDeactivate(ctx) : canReactivate({ target: ctx.target }));
      if (refusal) return refusal;
      const authUserId = await findAuthUserId(target.email);
      if (!authUserId) {
        // The rules already refuse "missing" and "unknown", so arriving here means
        // the directory changed under us. Say so; do not report a success.
        return bad("That login could not be found in the sign-in directory, so nothing was changed.", 409);
      }
      await setAuthBanned(authUserId, wantBanned);
      return Response.json({ ok: true, id: target.id, authStatus: wantBanned ? "deactivated" : "active" });
    }

    if (action === "link-staff") {
      if (!view.staffReadable) {
        return bad("Staff records are not available in this environment, so logins cannot be linked.", 503);
      }
      const staffId = typeof body.staffId === "string" && body.staffId ? body.staffId : null;

      if (staffId === null) {
        await clearStaffLinkForPerson(client.id, target.id);
        return Response.json({ ok: true, id: target.id, linkedStaff: null });
      }

      const staff = view.staff.find((s) => s.id === staffId) ?? null;
      const refusal = refuse(
        canLinkStaff({ personId: target.id, clientId: client.id, personClientId: target.clientId, staff }),
      );
      if (refusal) return refusal;

      // Clear the person's PREVIOUS row first: the partial unique index means a
      // second row for the same login is rejected outright, so moving somebody from
      // one staff record to another has to release the old one in the same action.
      await clearStaffLinkForPerson(client.id, target.id);
      const written = await setStaffLink({ clientId: client.id, staffId, appUserId: target.id });
      if (!written.ok) {
        const friendly = friendlyLinkError({ code: written.code });
        if (friendly) return bad(friendly, 409);
        if (written.code === "no-row") return bad("That staff record was not found in this practice.", 404);
        console.error("[people] link-staff failed", written.code);
        return bad("Could not link that login to the staff record.", 500);
      }
      return Response.json({
        ok: true,
        id: target.id,
        linkedStaff: staff ? { id: staff.id, name: staff.name, role: staff.role, siteId: staff.siteId } : null,
      });
    }

    // resend-invite
    if (target.authStatus === "unknown") {
      return bad("The login directory could not be read, so no invite was sent. Try again in a moment.", 502);
    }
    const base = process.env.PUBLIC_BASE_URL;
    const redirectTo = `${base && base.startsWith("http") ? base.replace(/\/$/, "") : ""}/set-password`;
    const byEmail = inviteDeliveryMode() === "email";

    // "missing" means the profile exists and the Auth account does not — the visible
    // half-failed invite. That needs an INVITE (the only type that creates the user);
    // everybody else already has an account, for whom invite is refused and RECOVERY
    // is the equivalent. Both land on the same /set-password page.
    if (target.authStatus === "missing") {
      if (byEmail) {
        await inviteByEmail(target.email, target.name, redirectTo);
        return Response.json({ ok: true, id: target.id, delivery: "email", link: null });
      }
      const invited = await generateInviteToken(target.email, target.name, redirectTo);
      return Response.json({
        ok: true,
        id: target.id,
        delivery: "link",
        link: invited.tokenHash ? buildSetPasswordLink(invited.tokenHash, "invite") : null,
      });
    }

    if (byEmail) {
      await sendRecoveryEmail(target.email, redirectTo);
      return Response.json({ ok: true, id: target.id, delivery: "email", link: null });
    }
    const recovery = await generateRecoveryToken(target.email, redirectTo);
    return Response.json({
      ok: true,
      id: target.id,
      delivery: "link",
      link: buildSetPasswordLink(recovery.tokenHash, recovery.type),
    });
  } catch (e) {
    // The message only. A GoTrue failure can echo the request, and the request for
    // an invite carries a one-time token that must never reach a log.
    console.error(`[people] PATCH ${action} failed`, e instanceof Error ? e.message : "unknown");
    return bad("That change could not be completed. Nothing else was altered.", 500);
  }
}
