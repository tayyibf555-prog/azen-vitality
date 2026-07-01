import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listStaff, createStaff } from "@/lib/rota/repository";
import type { Availability } from "@/lib/rota/types";

export const dynamic = "force-dynamic";

// Owner/manager-managed rota staff. Both methods are requireUser +
// requireClientAccess + requireOwnerRole. Staff are employees, not patients.

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** Keep only known weekday keys with explicit booleans. */
function availability(v: unknown): Availability {
  const out: Availability = {};
  if (v && typeof v === "object") {
    const raw = v as Record<string, unknown>;
    for (const day of DAYS) if (typeof raw[day] === "boolean") out[day] = raw[day] as boolean;
  }
  return out;
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
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const staff = await listStaff(client.id);
  return Response.json({ ok: true, staff });
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

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const name = str(body.name, 120);
  if (!name) return bad("name is required");
  const role = str(body.role, 60);
  if (!role) return bad("role is required");

  const active = typeof body.active === "boolean" ? body.active : true;

  const staff = await createStaff({
    clientId: client.id,
    siteId: str(body.siteId, 60) ?? null,
    name,
    role,
    phone: str(body.phone, 40) ?? null,
    email: str(body.email, 200) ?? null,
    active,
    availability: availability(body.availability),
  });
  return Response.json({ ok: true, staff }, { status: 201 });
}
