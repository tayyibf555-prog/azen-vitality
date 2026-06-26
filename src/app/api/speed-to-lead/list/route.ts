import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { toDashboardLead, firstResponseSeconds } from "@/lib/speed-to-lead/types";
import type { LeadStage } from "@/lib/types";

export const dynamic = "force-dynamic";

const STAGES: LeadStage[] = ["new", "contacted", "qualifying", "booked", "lost"];

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const siteIds = getSites(client.id).map((s) => s.id);
  const rows = await listLeads({ siteIds });

  const byStage: Record<LeadStage, number> = {
    new: 0,
    contacted: 0,
    qualifying: 0,
    booked: 0,
    lost: 0,
  };
  for (const r of rows) byStage[r.stage] += 1;

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
