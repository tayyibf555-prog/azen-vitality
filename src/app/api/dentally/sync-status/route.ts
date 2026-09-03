import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { assembleSyncStatus } from "@/lib/dentally/sync-status";

export const dynamic = "force-dynamic";

// GET /api/dentally/sync-status?client=<slug>
//
// What this platform writes back to Dentally, what it cannot, and every write
// intent it has recorded. READ ONLY — there is no write method here and none may
// be added: this route is the RECORD of the writes, and a route that could edit
// the record would be the one thing a record must not have.
//
// OWNER + AGENCY ONLY, the same lock the System controls page and /api/systems
// carry, and for the same reason. The rows name Dentally patient ids and the
// systems that acted on them, and "what is this platform doing to our patient
// records" is an owner's question. requireOwnerRole admits agency_admin and
// client_owner and refuses the coordinator, the clinician and the staff role.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  // A caller-supplied page size is clamped inside assembleSyncStatus (and again
  // in the repository), so a hand-typed ?limit=100000 cannot turn an owner's
  // page into a scan of the practice's whole write history.
  const raw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;

  try {
    const payload = await assembleSyncStatus(client.id, limit);
    return Response.json({ ok: true, ...payload });
  } catch (e) {
    // assembleSyncStatus already absorbs a ledger failure and reports it in
    // words; reaching here means something else broke entirely.
    console.error("[dentally/sync-status] GET failed", e);
    return bad("could not load the Dentally sync status", 500);
  }
}
