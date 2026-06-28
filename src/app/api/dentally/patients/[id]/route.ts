import { getPatientDetail } from "@/lib/dentally/read";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients/[id]?siteId=
// Returns one patient's appointment history + treatment plans for the record drawer.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const siteId = new URL(request.url).searchParams.get("siteId") ?? "";
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  // siteId is MANDATORY and the site guard ALWAYS runs. Previously the guard was
  // skipped when siteId was omitted, so any caller could read any patient's full
  // record by id with no tenant check (IDOR). Fail closed instead.
  if (!siteId) return Response.json({ ok: false, error: "siteId is required" }, { status: 400 });
  const denied = requireSiteAccess(auth, siteId);
  if (denied) return denied;
  try {
    const detail = await getPatientDetail(id, siteId);
    return Response.json({ ok: true, ...detail });
  } catch {
    return Response.json({ ok: false, appointments: [], plans: [] }, { status: 500 });
  }
}
