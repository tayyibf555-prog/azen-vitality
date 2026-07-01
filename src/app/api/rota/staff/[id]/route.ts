import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { updateStaff, deleteStaff, type UpdateStaffInput } from "@/lib/rota/repository";
import type { Availability } from "@/lib/rota/types";

export const dynamic = "force-dynamic";

// PATCH/DELETE a single rota staff member. Both guarded (requireUser +
// requireClientAccess + requireOwnerRole) and scoped to the caller's client.

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function availability(v: unknown): Availability {
  const out: Availability = {};
  if (v && typeof v === "object") {
    const raw = v as Record<string, unknown>;
    for (const day of DAYS) if (typeof raw[day] === "boolean") out[day] = raw[day] as boolean;
  }
  return out;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;

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

  const fields: UpdateStaffInput = {};
  if (body.siteId !== undefined) fields.siteId = str(body.siteId, 60) ?? null;
  if (body.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) return bad("name is required");
    fields.name = name;
  }
  if (body.role !== undefined) {
    const role = str(body.role, 60);
    if (!role) return bad("role is required");
    fields.role = role;
  }
  if (body.phone !== undefined) fields.phone = str(body.phone, 40) ?? null;
  if (body.email !== undefined) fields.email = str(body.email, 200) ?? null;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return bad("active must be a boolean");
    fields.active = body.active;
  }
  if (body.availability !== undefined) fields.availability = availability(body.availability);

  const updated = await updateStaff(id, client.id, fields);
  if (!updated) return bad("Staff member not found", 404);
  return Response.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // No/invalid body is fine for DELETE; fall back to the query param.
  }

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const removed = await deleteStaff(id, client.id);
  if (!removed) return bad("Staff member not found", 404);
  return Response.json({ ok: true });
}
