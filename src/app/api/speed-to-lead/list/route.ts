import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { toDashboardLead, firstResponseSeconds } from "@/lib/speed-to-lead/types";
import type { LeadStage } from "@/lib/types";

export const dynamic = "force-dynamic";

const STAGES: LeadStage[] = ["new", "contacted", "qualifying", "booked", "nurture_done", "lost"];

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Leads (enquiries, source, qualification) are acquisition data, outside CLINICIAN_SLUGS.
  const moduleDenied = requireModuleApiAccess(auth, "speed-to-lead");
  if (moduleDenied) return moduleDenied;

  const siteIds = await getViewSiteIds(client.id);
  const rows = await listLeads({ siteIds });

  const byStage: Record<LeadStage, number> = {
    new: 0,
    contacting: 0,
    contacted: 0,
    qualifying: 0,
    booked: 0,
    nurture_done: 0,
    lost: 0,
  };
  // 'contacting' is a transient in-flight claim; count it as 'new' so the stats
  // (built from STAGES, which omits 'contacting') stay correct and stable.
  for (const r of rows) byStage[r.stage === "contacting" ? "new" : r.stage] += 1;

  // Average first-response time across leads we actually contacted.
  const responses = rows
    .map((r) => firstResponseSeconds(r))
    .filter((s): s is number => s !== null);
  const avgFirstResponseSeconds = responses.length
    ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length)
    : null;

  return Response.json({
    leads: rows.map(toDashboardLead),
    stats: {
      total: rows.length,
      byStage: STAGES.map((stage) => ({ stage, count: byStage[stage] })),
      avgFirstResponseSeconds,
    },
  });
}
