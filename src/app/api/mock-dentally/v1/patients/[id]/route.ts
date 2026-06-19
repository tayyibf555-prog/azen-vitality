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
      use_sms: patient.use_sms,
      use_email: patient.use_email,
      marketing: patient.marketing,
      active: patient.active,
    },
  });
}
