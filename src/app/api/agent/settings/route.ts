import { setAgentEnabled } from "@/lib/agent/repository";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// POST { siteId, enabled } -> toggle the booking agent on/off for a site.
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const siteId = body.siteId;
  const enabled = body.enabled;
  if (typeof siteId !== "string" || siteId === "") {
    return Response.json({ error: "siteId is required" }, { status: 400 });
  }
  if (typeof enabled !== "boolean") {
    return Response.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const denied = requireSiteAccess(auth, siteId);
  if (denied) return denied;
  await setAgentEnabled(siteId, enabled);
  return Response.json({ ok: true, siteId, enabled });
}
