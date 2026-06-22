import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  patientsForSite,
  MOCK_PATIENTS,
  appointmentsForPatient,
  dobForPatient,
  type MockPatient,
} from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

/** Digits-only, so "+447700900001" and "07700900001" compare on suffix. */
function digits(s: string): string {
  return s.replace(/\D/g, "");
}
function phoneMatches(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  return da === db || da.endsWith(db) || db.endsWith(da);
}

/** Most recent past completed appointment = the patient's last visit. */
function lastVisitAt(patientId: string): string | null {
  const past = appointmentsForPatient(patientId)
    .filter((a) => a.state === "completed")
    .sort((x, y) => (x.start_time < y.start_time ? 1 : -1));
  return past[0]?.start_time ?? null;
}

function serialise(p: MockPatient) {
  return {
    id: p.id, first_name: p.first_name, last_name: p.last_name,
    email_address: p.email_address, mobile_phone: p.mobile_phone, site_id: p.site_id,
    use_sms: p.use_sms, use_email: p.use_email, marketing: p.marketing, active: p.active,
    archived: p.archived ?? false, archived_reason: p.archived_reason ?? null,
    dentist_recall_date: p.dentist_recall_date ?? null,
    hygienist_recall_date: p.hygienist_recall_date ?? null,
    date_of_birth: dobForPatient(p.id),
    last_visit_at: lastVisitAt(p.id),
    updated_at: "2026-06-17T00:00:00Z",
  };
}

// GET /api/mock-dentally/v1/patients?site_id=&mobile_phone=&page=&per_page=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const phone = url.searchParams.get("mobile_phone");
  let all = siteId ? patientsForSite(siteId) : MOCK_PATIENTS;
  if (phone) all = all.filter((p) => phoneMatches(p.mobile_phone, phone));
  return Response.json({ patients: all.map(serialise) });
}
