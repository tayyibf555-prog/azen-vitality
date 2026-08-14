import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { CAPABILITIES, isCapability, type Capability } from "@/lib/capabilities/keys";
import { ROLE_DEFAULTS } from "@/lib/capabilities/defaults";
import { capabilitySource } from "@/lib/capabilities/resolve";
import {
  canEditCapability,
  canResetCapability,
  PROTECTED_SUBJECT_ROLES,
  REFUSAL_MESSAGE,
  type AdminActor,
} from "@/lib/capabilities/admin-rules";
import {
  clearOverride,
  getCapabilities,
  getClientPerson,
  listClientPeople,
  listOverrides,
  setOverride,
} from "@/lib/capabilities/repository";

export const dynamic = "force-dynamic";

// ===========================================================================
// THE PERMISSIONS GRID's API. OWNER-ONLY, three methods.
//
//   GET    /api/permissions?client=<slug>   the whole grid: people × capabilities
//   POST   /api/permissions                 { client, appUserId, capability, granted }
//   DELETE /api/permissions                 { client, appUserId, capability } -> role default
//
// FOUR GATES ON EVERY WRITE, and each answers a different question:
//   requireUser            are you signed in
//   requireClientAccess    is this your practice
//   requireOwnerRole       is your ROLE allowed to administer permissions
//   requireCapability      are YOU allowed (the locked key — see keys.ts)
// and then the pure `admin-rules` decide whether this particular actor may make
// this particular change to this particular person.
//
// THE WRITE PATH 503s WHEN AUTH IS NOT ENFORCED, and that is correct rather than
// inconvenient: `security.capability.manage` is destructive, so requireCapability
// fails closed. An environment that cannot tell who is asking must not let anyone
// rewrite who can do what. The GET is not gated on it — the owner can still SEE
// the grid on such an environment, with the honest message the UI renders.
// ===========================================================================

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

interface Resolved {
  auth: AuthedUser | null;
  clientId: string;
}

/** requireUser -> requireClientAccess -> requireOwnerRole, or the Response that refused. */
async function resolveOwner(clientSlug: string): Promise<Resolved | Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  return { auth, clientId: client.id };
}

// ---------------------------------------------------------------------------
// GET — the grid.
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const gate = await resolveOwner(clientSlug);
  if (gate instanceof Response) return gate;

  try {
    // LOUD FAILURE, deliberately: both reads PROPAGATE their errors (the
    // repository's list* functions do not swallow), so an unreadable table
    // renders as a failure. "Nobody has any overrides" and "we could not read the
    // overrides" look identical in a grid and mean opposite things.
    const [people, overrides] = await Promise.all([
      listClientPeople(gate.clientId),
      listOverrides(gate.clientId),
    ]);

    const byUser = new Map<string, Array<{ capability: string; granted: boolean }>>();
    for (const o of overrides) {
      const list = byUser.get(o.appUserId) ?? [];
      list.push({ capability: o.capability, granted: o.granted });
      byUser.set(o.appUserId, list);
    }

    const rows = people.map((person) => {
      const rowOverrides = byUser.get(person.id) ?? [];
      const cells = CAPABILITIES.map((def) => {
        // Every entry in CAPABILITIES is by construction a Capability; the
        // uniform array type widens `key` to string, so it is narrowed once here
        // rather than at each of the three uses below.
        const key = def.key as Capability;
        const stored = rowOverrides.find((o) => o.capability === key);
        const held =
          stored && !def.locked ? stored.granted : ROLE_DEFAULTS[person.role].has(key);
        return {
          capability: key,
          held,
          // "role" / "granted" / "revoked" — computed by the SAME pure function the
          // server uses, so the dot in the UI cannot disagree with the enforcement.
          source: capabilitySource(person.role, key, rowOverrides),
        };
      });
      return { ...person, cells };
    });

    return Response.json({
      ok: true,
      people: rows,
      capabilities: CAPABILITIES.map((c) => ({
        key: c.key,
        group: c.group,
        label: c.label,
        description: c.description,
        destructive: c.destructive,
        locked: Boolean(c.locked),
      })),
      // The grid greys these rather than pretending they are editable. DERIVED
      // from the same constant `canEditCapability` refuses on, never retyped: two
      // copies of one rule drift, and the drift renders as an editable cell that
      // 403s when it is clicked.
      protectedRoles: [...PROTECTED_SUBJECT_ROLES],
      // Who is looking, so the UI can grey the actor's own row (no self-edit).
      actorId: gate.auth?.id ?? null,
    });
  } catch (err) {
    console.error(`[permissions] GET failed for ${gate.clientId}`, err);
    return bad(
      "We could not read the permissions for this practice, so nothing is shown rather than showing you a blank grid. Try again.",
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// The shared write preamble: gates 3 and 4, then the pure admin rules.
// ---------------------------------------------------------------------------

interface WriteIntent {
  auth: AuthedUser;
  clientId: string;
  appUserId: string;
  capability: string;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function authoriseWrite(
  request: Request,
  body: Record<string, unknown>,
  granted: boolean | null,
): Promise<WriteIntent | Response> {
  const url = new URL(request.url);
  const clientSlug = str(body.client) || (url.searchParams.get("client") ?? "");
  const gate = await resolveOwner(clientSlug);
  if (gate instanceof Response) return gate;

  // GATE 4. Locked and destructive, so this both narrows the owner ROLE to a named
  // owner LOGIN and refuses outright on an environment with no sign-in.
  const capabilityDenied = await requireCapability(gate.auth, "security.capability.manage");
  if (capabilityDenied) return capabilityDenied;
  if (!gate.auth) {
    // Unreachable in practice (the guard above answers 503 first) and kept as a
    // hard stop rather than a non-null assertion: a write with no known actor has
    // no audit trail, which is most of the point of this table.
    return bad("This action is unavailable because sign-in is not configured on this environment.", 503);
  }

  const appUserId = str(body.appUserId) || (url.searchParams.get("appUserId") ?? "");
  const capability = str(body.capability) || (url.searchParams.get("capability") ?? "");
  if (!appUserId || !capability) return bad("appUserId and capability are required");
  if (!isCapability(capability)) return bad(REFUSAL_MESSAGE["unknown-capability"]);

  // The SUBJECT is read from the database, scoped to this practice — never taken
  // from the body. A caller cannot claim somebody else's role to slip past the
  // protected-subject rule, and an id from another practice simply is not found.
  let person;
  try {
    person = await getClientPerson(gate.clientId, appUserId);
  } catch (err) {
    console.error(`[permissions] subject lookup failed for ${appUserId}`, err);
    return bad("We could not read that person's record, so nothing was changed.", 503);
  }
  if (!person) return bad("That person is not a login of this practice.", 404);

  const actor: AdminActor = {
    id: gate.auth.id,
    role: gate.auth.role,
    // The actor's OWN resolved set, for the no-amplification rule. Same cache()d
    // read the guard above already did, so this costs nothing extra.
    capabilities: await getCapabilities(gate.auth),
  };

  const decision =
    granted === null
      ? canResetCapability(actor, person, capability)
      : canEditCapability(actor, person, capability, granted);
  if (!decision.ok) {
    return Response.json(
      { ok: false, error: REFUSAL_MESSAGE[decision.refusal!], refusal: decision.refusal },
      { status: 403 },
    );
  }

  return { auth: gate.auth, clientId: gate.clientId, appUserId, capability };
}

// ---------------------------------------------------------------------------
// POST — set one cell.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (typeof body.granted !== "boolean") return bad("granted must be true or false");
  const intent = await authoriseWrite(request, body, body.granted);
  if (intent instanceof Response) return intent;

  try {
    await setOverride(
      intent.clientId,
      intent.appUserId,
      intent.capability,
      body.granted,
      intent.auth.id,
    );
    return Response.json({ ok: true, appUserId: intent.appUserId, capability: intent.capability, granted: body.granted });
  } catch (err) {
    console.error(`[permissions] POST failed for ${intent.appUserId}/${intent.capability}`, err);
    return bad("That permission could not be saved. Nothing has been changed.", 503);
  }
}

// ---------------------------------------------------------------------------
// DELETE — reset one cell to the role default.
//
// Reset is a DELETE of the row, because the absence of a row IS "ask the role".
// Storing a row that happens to agree with the role would leave the person
// pinned to today's default and silently out of step the day the role changes.
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  const body = await readBody(request);
  const intent = await authoriseWrite(request, body, null);
  if (intent instanceof Response) return intent;

  try {
    await clearOverride(intent.clientId, intent.appUserId, intent.capability);
    return Response.json({ ok: true, appUserId: intent.appUserId, capability: intent.capability, reset: true });
  } catch (err) {
    console.error(`[permissions] DELETE failed for ${intent.appUserId}/${intent.capability}`, err);
    return bad("That permission could not be reset. Nothing has been changed.", 503);
  }
}
