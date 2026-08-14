import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  INVITABLE_ROLES,
  ROLE_BLURBS,
  ROLE_LABELS,
  buildSetPasswordLink,
  inviteDeliveryMode,
  validateInvite,
} from "@/lib/provisioning/rules";
import {
  createPersonRow,
  findPersonByEmail,
  generateInviteToken,
  generateRecoveryToken,
  inviteByEmail,
  provisioningAvailable,
  readAuthDirectory,
  readPeople,
  sendRecoveryEmail,
} from "@/lib/provisioning/repository";

export const dynamic = "force-dynamic";

// ===========================================================================
// PEOPLE & LOGINS — the practice's own user administration.
//
//   GET  /api/people?client=<slug>   the joined view: profiles + Auth state + rota link
//   POST /api/people                 invite one person
//
// BOTH ARE requireUser -> requireClientAccess -> requireOwnerRole. This is the
// screen that hands out access to a live patient database, so it is owner-only in
// v1 with no exceptions: not the practice manager, not the clinician. The API guard
// is the real one — the page guard never runs on these routes.
//
// NO PASSWORD IS EVER SET HERE. There is no `createUser` call anywhere in this
// feature. An invite creates an Auth account with no password and mints a one-time
// token; the invitee sets their own password in their own browser at /set-password.
// The token is returned to the owner AT MOST ONCE, is never written to a log, a row
// or a telemetry event, and is not returned at all when Supabase sends the email.
// ===========================================================================

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** The one honest sentence for an environment that simply cannot do this. */
const UNAVAILABLE =
  "User provisioning is not switched on in this environment: it needs the Supabase service-role key.";

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const roles = INVITABLE_ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    blurb: ROLE_BLURBS[role],
  }));

  if (!provisioningAvailable()) {
    // LOUD, not empty. A blank people table here would read as "this practice has
    // no logins", which is the opposite of the truth.
    return Response.json({ ok: true, available: false, reason: UNAVAILABLE, roles, people: [], staff: [] });
  }

  try {
    const view = await readPeople(client.id, Date.now());
    return Response.json({
      ok: true,
      available: true,
      roles,
      delivery: inviteDeliveryMode(),
      people: view.people,
      staff: view.staff,
      authReadable: view.authReadable,
      authError: view.authError,
      staffReadable: view.staffReadable,
      activeOwnerCount: view.activeOwnerCount,
      /** The signed-in owner, so the screen can grey out their own row's controls. */
      selfId: auth?.id ?? null,
    });
  } catch (e) {
    console.error("[people] GET failed", e);
    return bad("Could not load this practice's logins.", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
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

  // FAIL CLOSED. Unreachable while `provisioningAvailable()` and `authEnforced()`
  // are both keyed on the service-role key, and kept anyway: handing out a login is
  // the last action in this platform that should ever run without a named actor.
  if (!auth && provisioningAvailable()) return bad("Sign in as an owner to invite somebody.", 403);
  if (!provisioningAvailable()) return bad(UNAVAILABLE, 503);

  const validated = validateInvite({ email: body.email, name: body.name, role: body.role });
  if (!validated.ok) return bad(validated.error);
  const { email, name, role } = validated.value;

  try {
    const existing = await findPersonByEmail(email);
    if (existing) {
      return bad(
        existing.client_id === client.id
          ? "That email is already on this practice's list. Use Resend invite instead."
          : "That email address is already in use on this platform.",
        409,
      );
    }

    // The Auth account may already exist without a profile (a seeded login, or an
    // invite that half-failed before). `type:"invite"` refuses an existing user, so
    // that case needs a recovery link instead — checked BEFORE anything is written.
    const directory = await readAuthDirectory();
    if (!directory.readable) {
      return bad(directory.error ?? "The login directory could not be read. Try again in a moment.", 502);
    }
    const alreadyHasLogin = directory.byEmail.has(email);

    const base = process.env.PUBLIC_BASE_URL;
    const redirectTo = `${base && base.startsWith("http") ? base.replace(/\/$/, "") : ""}/set-password`;
    const delivery = inviteDeliveryMode();

    // PROFILE FIRST, INVITE SECOND, and that order is the point. If the invite fails
    // the practice is left with a visible row marked "no login yet" and a Resend
    // button; the other order leaves an Auth account nobody can see, which signs in
    // successfully and lands on "you are not linked to a practice".
    const row = await createPersonRow({ email, name, role, clientId: client.id });

    let link: string | null = null;
    try {
      if (alreadyHasLogin) {
        // `type:"invite"` is refused for a user that already exists, so somebody
        // with an Auth account but no profile (a seeded login, or an invite that
        // half-failed earlier) gets a RECOVERY link instead. Same page, same result.
        if (delivery === "email") {
          await sendRecoveryEmail(email, redirectTo);
        } else {
          const recovery = await generateRecoveryToken(email, redirectTo);
          link = buildSetPasswordLink(recovery.tokenHash, recovery.type);
        }
      } else if (delivery === "email") {
        await inviteByEmail(email, name, redirectTo);
      } else {
        const invited = await generateInviteToken(email, name, redirectTo);
        link = invited.tokenHash ? buildSetPasswordLink(invited.tokenHash, "invite") : null;
      }
    } catch (e) {
      // Deliberately NOT logging `e` verbatim beyond its message: a GoTrue error can
      // echo the request, and the request carried a token.
      console.error("[people] invite issued but delivery failed", e instanceof Error ? e.message : "unknown");
      return Response.json(
        {
          ok: false,
          error:
            "The person was added, but the invite could not be issued. Use Resend invite on their row to try again.",
          personId: row.id,
        },
        { status: 502 },
      );
    }

    return Response.json(
      {
        ok: true,
        person: {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          clientId: row.client_id,
          authStatus: "invited",
          lastSignInAt: null,
          invitedAt: new Date().toISOString(),
          linkedStaff: null,
        },
        delivery: link ? "link" : "email",
        link,
      },
      { status: 201 },
    );
  } catch (e) {
    console.error("[people] POST failed", e);
    return bad("Could not add that person. Please try again.", 500);
  }
}
