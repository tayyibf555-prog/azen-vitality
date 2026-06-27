import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { insertUsp, listUsps, InvalidUspError } from "@/lib/usp/repository";
import { USP_CATEGORIES, type UspCategory } from "@/lib/usp/types";

export const dynamic = "force-dynamic";

// Internal CRUD for owner-managed practice USPs. Both methods are
// requireUser + requireClientAccess. The active texts are read separately by the
// AI agents (listActiveUspTexts) and never exposed to patients here.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** A supplied category must be one of the known keys; anything else is dropped to null. */
function category(v: unknown): UspCategory | null {
  return typeof v === "string" && (USP_CATEGORIES as string[]).includes(v) ? (v as UspCategory) : null;
}

/** Coerce a priority to a finite integer, else undefined (repository defaults to 0). */
function priority(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
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

  const usps = await listUsps(client.id);
  return Response.json({ ok: true, usps });
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

  const text = str(body.text, 280);
  if (!text) return bad("text is required");

  try {
    const usp = await insertUsp({
      clientId: client.id,
      text,
      category: category(body.category),
      priority: priority(body.priority),
      createdBy: auth?.email ?? auth?.id ?? null,
    });
    return Response.json({ ok: true, usp }, { status: 201 });
  } catch (e) {
    if (e instanceof InvalidUspError) return bad(e.message);
    return bad("could not create the selling point", 500);
  }
}
