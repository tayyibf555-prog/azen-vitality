import { getPatientDetail, getPatientById } from "@/lib/dentally/read";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import { numberHealthFor, type NumberHealth } from "@/lib/messaging/number-health";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients/[id]?siteId=
// Returns one patient's appointment history + treatment plans for the record drawer,
// plus the number-health verdict (read-only, from phone_lookup) so a record opened from
// search/filter - beyond the list's batched slice - still shows an accurate chip. The
// number is resolved server-side from the patient id, so no phone ever rides the URL.
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
  // The number-health verdict, derived from the patient resolved for the site check
  // above. Only when enforcement is on (auth non-null); when off, the drawer falls back
  // to the batched list verdict. numberHealthFor short-circuits (no query) for a patient
  // with no usable number, so the by-id reads below are the only ones for such records.
  let numberHealth: NumberHealth | null = null;
  if (auth) {
    const patient = await getPatientById(id);
    if (!patient || patient.siteId !== siteId) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    numberHealth = await numberHealthFor(patient.phone);
  }

  try {
    const detail = await getPatientDetail(id, siteId);
    return Response.json({ ok: true, numberHealth, ...detail });
  } catch {
    return Response.json({ ok: false, appointments: [], plans: [] }, { status: 500 });
  }
}
