import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getConfig, saveConfig } from "@/lib/rota/repository";
import { normaliseConfig } from "@/lib/rota/config";

export const dynamic = "force-dynamic";

// Owner/manager-managed rota config. GET returns the saved config (or defaults);
// PUT normalises + upserts it. Both requireUser + requireClientAccess + requireApproverRole.
//
// WIDENED FROM requireOwnerRole TO requireApproverRole (campaign 6), and it is a
// decision on the record rather than a tidy-up. The practice manager is a
// `client_coordinator` in this platform and she is the rota's PRIMARY user, so the
// owner-only guard meant she could not make a single rota API call — the module
// locked out the person it was built for. Its two siblings (absence,
// staff-check-in) were widened to the approver list for exactly this reason and
// the rota was missed. `requireApproverRole` reads APPROVER_ROLES from
// `@/lib/absence/rules`, so the HTTP edge and the pure decision rules cannot
// drift, and the clinician and the staff role are still refused by it.
// nav.staff.test.ts names this widening and pins all four routes.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  const config = await getConfig(client.id);
  return Response.json({ ok: true, config });
}

export async function PUT(request: Request): Promise<Response> {
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

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  // Accept the config either nested under `config` or at the top level; normalise
  // fills any missing/invalid field from the defaults, so this can never store junk.
  const raw = body.config !== undefined ? body.config : body;
  const config = normaliseConfig(raw);
  await saveConfig(client.id, config);
  return Response.json({ ok: true, config });
}
