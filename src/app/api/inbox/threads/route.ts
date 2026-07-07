import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { listThreads } from "@/lib/inbox/repository";

export const dynamic = "force-dynamic";

// GET /api/inbox/threads?client=<slug>
// Every patient conversation across SMS, WhatsApp, after-hours and the lifecycle
// agents, grouped per contact and scoped strictly to the caller's sites.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("client");
  const client = slug ? getClient(slug) : null;

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // Site scope is derived from the verified user when enforced, never trusted
  // from input; falls back to the client's sites in unenforced (local) mode.
  const clientSiteIds = await getViewSiteIds(client.id);
  const siteIds = auth ? clientSiteIds.filter((id) => auth.siteIds.includes(id)) : clientSiteIds;

  try {
    const threads = await listThreads(siteIds);
    return Response.json({ ok: true, threads });
  } catch {
    return Response.json({ ok: false, error: "inbox unavailable" }, { status: 500 });
  }
}
