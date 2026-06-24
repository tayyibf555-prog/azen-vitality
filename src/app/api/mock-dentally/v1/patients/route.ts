import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  patientsForSite,
  MOCK_PATIENTS,
  appointmentsForPatient,
  addPatient,
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

function randomPatientId(): string {
  return `pat-${Math.random().toString(36).slice(2, 10)}`;
}

// POST /api/mock-dentally/v1/patients — register (onboard) a new patient.
// Reads the real Dentally shape { "patient": {...} }, stores it, and returns it.
export async function POST(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { type: "invalid_request_error", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const p =
    payload.patient && typeof payload.patient === "object"
      ? (payload.patient as Record<string, unknown>)
      : {};
  const str = (k: string): string | undefined => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const bool = (k: string, dflt: boolean): boolean => (typeof p[k] === "boolean" ? (p[k] as boolean) : dflt);

  const created: MockPatient = {
    id: randomPatientId(),
    first_name: str("first_name") ?? "New",
    last_name: str("last_name") ?? "Patient",
    email_address: str("email_address") ?? str("email") ?? "",
    mobile_phone: str("mobile_phone") ?? str("phone") ?? "",
    use_sms: bool("use_sms", true),
    use_email: bool("use_email", true),
    marketing: typeof p.marketing === "number" ? (p.marketing as number) : 1,
    active: true,
    site_id: str("site_id") ?? "site-cc",
  };
  addPatient(created);
  return Response.json({ patient: serialise(created) }, { status: 201 });
}
