import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { signFileUrl } from "@/lib/onboarding/repository";

export const dynamic = "force-dynamic";

// Internal: mint a short-lived signed URL for one onboarding document so staff can
// view/download it. Auth-gated (requireUser + requireClientAccess). The key guard is
// tenancy: the requested path MUST live under onboarding/<clientSlug>/ for the client
// the staff member may access, so a path from another client (or a traversal attempt)
// is refused with 403 — no IDOR across tenants.

const SIGNED_URL_TTL_SECONDS = 120; // short-lived: a view, not a shareable link

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const path = url.searchParams.get("path") ?? "";

  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // Tenancy + traversal guard: the path must be exactly under this client's prefix.
  const prefix = `onboarding/${client.slug}/`;
  if (!path.startsWith(prefix) || path.includes("..")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const signedUrl = await signFileUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signedUrl) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ url: signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
}
