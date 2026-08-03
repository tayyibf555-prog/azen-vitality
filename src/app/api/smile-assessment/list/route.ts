import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listResponses } from "@/lib/smile-assessment/repository";
import type { AssessmentBand } from "@/lib/smile-assessment/types";

export const dynamic = "force-dynamic";

const BANDS: AssessmentBand[] = ["high", "medium", "low"];

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and the
  // enquiry scores behind them. (The patient-facing next/submit/token routes are
  // separate and deliberately unauthenticated.)
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  const siteIds = await getViewSiteIds(client.id);
  const responses = await listResponses({ siteIds });

  const byBand: Record<AssessmentBand, number> = { high: 0, medium: 0, low: 0 };
  for (const r of responses) byBand[r.band] += 1;
  const contacted = responses.filter((r) => r.band === "high" && r.leadId !== null).length;

  return Response.json({
    responses,
    stats: {
      total: responses.length,
      byBand: BANDS.map((band) => ({ band, count: byBand[band] })),
      highContacted: contacted,
    },
  });
}
