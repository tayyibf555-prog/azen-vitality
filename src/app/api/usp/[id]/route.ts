import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { updateUsp, deleteUsp, InvalidUspError } from "@/lib/usp/repository";
import { USP_CATEGORIES, type UspCategory } from "@/lib/usp/types";
import type { UpdateUspInput } from "@/lib/usp/repository";

export const dynamic = "force-dynamic";

// PATCH/DELETE a single USP. Both guarded (requireUser + requireClientAccess) and
// scoped to the caller's client, so a USP can only be edited within its own client.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function category(v: unknown): UspCategory | null {
  return typeof v === "string" && (USP_CATEGORIES as string[]).includes(v) ? (v as UspCategory) : null;
}

function priority(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
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

  // Only carry the fields the caller actually supplied.
  const fields: UpdateUspInput = {};
  if (body.text !== undefined) {
    const text = str(body.text, 280);
    if (!text) return bad("text is required");
    fields.text = text;
  }
  if (body.category !== undefined) fields.category = category(body.category);
  if (body.priority !== undefined) {
    const p = priority(body.priority);
    if (p === undefined) return bad("priority must be a number");
    fields.priority = p;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return bad("active must be a boolean");
    fields.active = body.active;
  }

  try {
    await updateUsp(id, client.id, fields);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof InvalidUspError) return bad(e.message);
    return bad("could not update the selling point", 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;

  // clientSlug may arrive in a body (preferred) or via ?client= for a bare DELETE.
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

  await deleteUsp(id, client.id);
  return Response.json({ ok: true });
}
