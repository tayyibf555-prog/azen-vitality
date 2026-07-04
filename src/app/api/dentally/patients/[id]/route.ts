import { getPatientDetail, getPatientById } from "@/lib/dentally/read";
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

  // requireSiteAccess only proves the CALLER may reach the site they named. It does
  // NOT prove the requested PATIENT belongs to that site — and getPatientDetail's
  // appointment/notes/invoice reads are keyed on patient id alone, so without this a
  // caller holding site A could read a patient from site B by pairing site A with a
  // foreign patient id (cross-site now, cross-tenant once a second practice exists).
  // Resolve the patient and require their real site to match. Only when enforcement
  // is on (auth non-null), mirroring requireSiteAccess. Fail closed: an unresolved or
  // wrong-site patient returns 404 and never reveals the patient exists.
  // (Calibration note: relies on the Dentally patient object carrying site_id, which
  // the mock now mirrors; confirm against the live sandbox when the real key lands.)
  if (auth) {
    const patient = await getPatientById(id);
    if (!patient || patient.siteId !== siteId) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
  }

  try {
    const detail = await getPatientDetail(id, siteId);
    return Response.json({ ok: true, ...detail });
  } catch {
    return Response.json({ ok: false, appointments: [], plans: [] }, { status: 500 });
  }
}
