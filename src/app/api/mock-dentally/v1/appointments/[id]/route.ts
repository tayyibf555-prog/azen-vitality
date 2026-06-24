import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  findAppointmentById,
  updateAppointmentFields,
  findPatient,
  type MockAppointment,
} from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function serialise(a: MockAppointment) {
  const p = findPatient(a.patient_id);
  const name = a.patient_name ?? (p ? `${p.first_name} ${p.last_name}` : "Patient");
  const duration = a.duration ?? 30;
  const finish = new Date(new Date(a.start_time).getTime() + duration * 60_000).toISOString();
  return {
    id: a.id,
    patient_id: a.patient_id,
    patient_name: name,
    site_id: a.site_id,
    start_time: a.start_time,
    finish_time: finish,
    duration,
    state: a.state,
    reason: a.reason ?? null,
    practitioner: a.practitioner ?? null,
  };
}

function notFound(): Response {
  return Response.json(
    { error: { type: "not_found", message: "Appointment not found." } },
    { status: 404 },
  );
}

// PUT /api/mock-dentally/v1/appointments/[id] — edit / reschedule.
// Reads the real Dentally shape { "appointment": {...} } and updates start_time,
// state or reason in place.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;

  let payload: Record<string, unknown>;
  try {
    payload = asRecord(await request.json());
  } catch {
    return Response.json(
      { error: { type: "invalid_request_error", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const appt = asRecord(payload["appointment"]);
  const patch: Partial<MockAppointment> = {};
  if (typeof appt.start_time === "string") patch.start_time = appt.start_time;
  if (typeof appt.state === "string") patch.state = appt.state;
  if (typeof appt.reason === "string") patch.reason = appt.reason;

  const updated = updateAppointmentFields(id, patch);
  if (!updated) return notFound();
  return Response.json({ appointment: serialise(updated) });
}

// DELETE /api/mock-dentally/v1/appointments/[id] — cancel (soft: state -> cancelled).
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;

  if (!findAppointmentById(id)) return notFound();
  const updated = updateAppointmentFields(id, { state: "cancelled" });
  return Response.json({ appointment: serialise(updated!) });
}
