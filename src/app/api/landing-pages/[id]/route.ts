import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getPageById, setPageStatus, promoteWinner } from "@/lib/landing/repository";
import { mintPreviewToken } from "@/lib/landing/preview-token";
import { recordUsage } from "@/lib/telemetry";
import type { LandingPage } from "@/lib/landing/types";

export const dynamic = "force-dynamic";

// Detail + lifecycle for one landing page.
// GET   - page + variants + its public URL (requireUser + client access).
// PATCH - publish / archive / promote-winner (owner-only). One action per call.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function urls(origin: string, clientSlug: string, page: LandingPage) {
  const path = `/go/${clientSlug}/${page.slug}`;
  // A draft is only servable with a matching preview token, so hand the owner a
  // ready preview link. Null when no server key is configured (no preview then).
  const token = page.status === "draft" ? mintPreviewToken(page.id) : null;
  const previewPath = token ? `${path}?preview=${token}` : null;
  return {
    url: `${origin}${path}`,
    path,
    previewUrl: previewPath ? `${origin}${previewPath}` : null,
    previewPath,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;
  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Same split as the collection route: GET is owner + coordinator, PATCH is
  // owner-only. The clinician gets neither.
  const moduleDenied = requireModuleApiAccess(auth, "landing-pages");
  if (moduleDenied) return moduleDenied;

  const found = await getPageById(id, client.id);
  if (!found) return bad("Landing page not found", 404);

  const origin = new URL(request.url).origin;
  return Response.json({
    ok: true,
    page: { ...found.page, ...urls(origin, clientSlug, found.page) },
    variants: found.variants,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug =
    (typeof body.clientSlug === "string" ? body.clientSlug.trim() : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);
  const accessDenied = requireClientAccess(auth, client.id);
  if (accessDenied) return accessDenied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const found = await getPageById(id, client.id);
  if (!found) return bad("Landing page not found", 404);

  const action = typeof body.action === "string" ? body.action : "";
  switch (action) {
    case "publish":
      await setPageStatus(id, client.id, "live");
      void recordUsage("landing", "landing_publish", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
      return Response.json({ ok: true, status: "live" });
    case "archive":
      await setPageStatus(id, client.id, "archived");
      return Response.json({ ok: true, status: "archived" });
    case "promote-winner": {
      const variant = body.variant;
      if (variant !== "a" && variant !== "b") return bad("variant must be 'a' or 'b'");
      await promoteWinner(id, client.id, variant);
      return Response.json({ ok: true, winnerVariant: variant, status: "live" });
    }
    default:
      return bad("action must be 'publish', 'archive' or 'promote-winner'");
  }
}
