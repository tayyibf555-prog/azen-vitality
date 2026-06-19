import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { patientsForSite, MOCK_PATIENTS, type MockPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

function serialise(p: MockPatient) {
  return {
    id: p.id, first_name: p.first_name, last_name: p.last_name,
    email_address: p.email_address, mobile_phone: p.mobile_phone,
    use_sms: p.use_sms, use_email: p.use_email, marketing: p.marketing, active: p.active,
    archived: p.archived ?? false, archived_reason: p.archived_reason ?? null,
    dentist_recall_date: p.dentist_recall_date ?? null,
    hygienist_recall_date: p.hygienist_recall_date ?? null,
    updated_at: "2026-06-17T00:00:00Z",
  };
}

// GET /api/mock-dentally/v1/patients?site_id=&page=&per_page=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const all = siteId ? patientsForSite(siteId) : MOCK_PATIENTS;
  return Response.json({ patients: all.map(serialise) });
}
