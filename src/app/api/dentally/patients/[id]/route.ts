import { getPatientRecord, getPatientRecordInScope } from "@/lib/patient/record";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import { numberHealthFor, type NumberHealth } from "@/lib/messaging/number-health";
import { getOverride } from "@/lib/patient-status/repository";
import { getSite } from "@/lib/mock/clients";
import type { PatientAdminStatus } from "@/lib/patient-status/types";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients/[id]?siteId=
//
// The whole patient record for the QUICK VIEW: the patient, the detail read, the
// derived figures and the read-health flags, plus the number-health verdict
// (read-only, from phone_lookup) so a record opened from search or a filter, beyond
// the list's batched slice, still shows an accurate chip. The number is resolved
// server-side from the patient id, so no phone ever rides the URL.
//
// It reads through getPatientRecord, which is the SAME function the full record page
// server-renders, behind the same single cache entry. That is the point: the two
// surfaces must never disagree about a figure, so neither of them computes one.
// Everything numeric on either surface comes off `derived`.
//
// IT ALSO RETURNS THE STATUS OVERRIDE AND THE SITE NAME, which it did not. The quick
// overview is now the ONLY surface the diary, the dashboard debtors list, the task
// queue and the command palette open, and without the override it showed a patient
// the practice had marked do_not_contact as an ordinary record with a phone number
// and no marker of any kind. The old drawer carried that red pill in its header. The
// read's own success is reported separately (overrideUnavailable) so a database blip
// cannot present as "no marker set".
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
    // requireSiteAccess only proves the CALLER may reach the site they named. It does
    // NOT prove the requested PATIENT belongs to that site, and the per-patient reads
    // are keyed on patient id alone, so without this a caller holding site A could read
    // a patient from site B by pairing site A with a foreign patient id (cross-site
    // now, cross-tenant once a second practice exists).
    //
    // getPatientRecordInScope resolves the patient by id FIRST and checks their real
    // site BEFORE running any of the appointment / notes / invoice reads, so a foreign
    // patient's record is never even fetched, let alone returned. Only when enforcement
    // is on (auth non-null), mirroring requireSiteAccess. Fail closed: an unresolved or
    // wrong-site patient returns the SAME 404 and never reveals which it was.
    // (Calibration note: relies on the Dentally patient object carrying site_id, which
    // the mock mirrors; confirm against the live sandbox when the real key lands.)
    const record = auth
      ? await getPatientRecordInScope(id, [siteId])
      : await getPatientRecord(id, siteId);
    if (!record) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }

    // Only when enforcement is on; when off, the quick view simply shows no chip.
    // numberHealthFor short-circuits (no query) for a patient with no usable number.
    let overrideStatus: PatientAdminStatus | null = null;
    let overrideUnavailable = false;
    const [numberHealth] = await Promise.all([
      auth ? numberHealthFor(record.patient.phone) : Promise.resolve(null as NumberHealth | null),
      getOverride(record.patient.siteId, record.patient.id)
        .then((o) => {
          overrideStatus = o?.status ?? null;
        })
        .catch(() => {
          overrideUnavailable = true;
        }),
    ]);

    return Response.json({
      ok: true,
      patient: record.patient,
      detail: record.detail,
      derived: record.derived,
      reads: record.reads,
      numberHealth,
      overrideStatus,
      overrideUnavailable,
      siteName: getSite(record.patient.siteId)?.name ?? record.patient.siteId,
    });
  } catch {
    return Response.json({ ok: false, error: "could not load record" }, { status: 500 });
  }
}
