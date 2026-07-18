import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { findPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/patients/[id]
// Mirrors the real Dentally patient object: top-level id / first_name /
// last_name / email_address / mobile_phone, plus consent fields use_sms /
// use_email (boolean) and marketing (integer 0/1), and active (boolean).
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const patient = findPatient(id);

  if (!patient) {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: `No patient with id '${id}'.`,
        },
      },
      { status: 404 },
    );
  }

  return Response.json({
    patient: {
      id: patient.id,
      first_name: patient.first_name,
      last_name: patient.last_name,
      email_address: patient.email_address,
      mobile_phone: patient.mobile_phone,
      // site_id anchors the patient to a practice site, mirroring the real Dentally
      // patient object. The patient-detail route relies on it to verify the requested
      // patient actually belongs to the caller's authorised site (site-scope guard).
      site_id: patient.site_id,
      use_sms: patient.use_sms,
      use_email: patient.use_email,
      marketing: patient.marketing,
      active: patient.active,
    },
  });
}

// PUT /api/mock-dentally/v1/patients/[id]
// Mirrors the real "Edit a patient" endpoint: accepts a wrapped { patient: {...} } body
// (partial update) and echoes the merged patient back. Deliberately does NOT mutate the
// shared in-memory fixtures (which would leak between requests/tests) - it reflects the
// requested change in the RESPONSE only, which is all the write path needs to confirm a
// 200. Real Dentally documents `active` as an editable boolean here.
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const patient = findPatient(id);
  if (!patient) {
    return Response.json(
      { error: { type: "invalid_request_error", message: `No patient with id '${id}'.` } },
      { status: 404 },
    );
  }

  let body: { patient?: Record<string, unknown> } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // Tolerate an empty/invalid body: echo the unchanged patient (mirrors a no-op edit).
  }
  const patch = body.patient ?? {};

  return Response.json({
    patient: {
      id: patient.id,
      first_name: patient.first_name,
      last_name: patient.last_name,
      email_address: patient.email_address,
      mobile_phone: patient.mobile_phone,
      site_id: patient.site_id,
      use_sms: patient.use_sms,
      use_email: patient.use_email,
      marketing: patient.marketing,
      active: typeof patch.active === "boolean" ? patch.active : patient.active,
    },
  });
}
