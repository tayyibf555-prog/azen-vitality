import { getPatientDetail } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients/[id]?siteId=
// Returns one patient's appointment history + treatment plans for the record drawer.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const siteId = new URL(request.url).searchParams.get("siteId") ?? "";
  try {
    const detail = await getPatientDetail(id, siteId);
    return Response.json({ ok: true, ...detail });
  } catch {
    return Response.json({ ok: false, appointments: [], plans: [] }, { status: 500 });
  }
}
