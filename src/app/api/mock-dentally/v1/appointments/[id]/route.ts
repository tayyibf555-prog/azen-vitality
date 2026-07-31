import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  findAppointmentById,
  updateAppointmentFields,
  findPatient,
  type MockAppointment,
} from "@/app/api/mock-dentally/_fixtures";
import {
  findGeneratedAppointment,
  updateGeneratedAppointment,
} from "@/app/api/mock-dentally/_dashboard-fixtures";

export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// The single-appointment serialiser used to omit practitioner_id and notes while
// the LIST route included both. A read-back that confirms a move by comparing
// fields would therefore have reported every clinician reassignment as failed,
// even once the PUT below was taught to accept one. Both are emitted here now.
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
    practitioner_id: a.practitioner_id ?? null,
    notes: a.notes ?? null,
  };
}

function notFound(): Response {
  return Response.json(
    { error: { type: "not_found", message: "Appointment not found." } },
    { status: 404 },
  );
}

/**
 * Apply a patch to whichever store owns this id.
 *
 * Every row the diary actually renders comes from generatedAppointments(), not
 * from the hand-written MOCK_APPOINTMENTS, so a PUT against anything visible in
 * the diary used to 404 and the whole move path was untestable. Hand-written
 * rows are tried first because they are the ones the booking flow creates.
 */
function applyPatch(id: string, patch: Partial<MockAppointment>): MockAppointment | undefined {
  if (findAppointmentById(id)) return updateAppointmentFields(id, patch);
  if (findGeneratedAppointment(id)) return updateGeneratedAppointment(id, patch);
  return undefined;
}

function exists(id: string): boolean {
  return Boolean(findAppointmentById(id) ?? findGeneratedAppointment(id));
}

// PUT /api/mock-dentally/v1/appointments/[id]: edit, reschedule, reassign.
//
// Reads the real Dentally shape { "appointment": {...} }. It used to accept only
// start_time, state and reason, silently DROPPING finish_time, duration and
// practitioner_id, so a resize or a clinician reassign returned HTTP 200 with the
// old values: a write that reports success and changes nothing is the exact
// failure a read-back confirmation exists to catch, and the mock was manufacturing
// it. All three are honoured now.
//
// finish_time is translated into `duration`, which is what MockAppointment stores
// and what the serialiser derives finish_time back from, so the two can never
// disagree.
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
  if (typeof appt.practitioner_id === "string") patch.practitioner_id = appt.practitioner_id;
  if (typeof appt.practitioner === "string") patch.practitioner = appt.practitioner;

  if (typeof appt.duration === "number" && Number.isFinite(appt.duration) && appt.duration > 0) {
    patch.duration = Math.round(appt.duration);
  }
  if (typeof appt.finish_time === "string") {
    const current = findAppointmentById(id) ?? findGeneratedAppointment(id);
    const startIso = patch.start_time ?? current?.start_time;
    const startMs = startIso ? Date.parse(startIso) : NaN;
    const finishMs = Date.parse(appt.finish_time);
    if (!Number.isNaN(startMs) && !Number.isNaN(finishMs) && finishMs > startMs) {
      patch.duration = Math.round((finishMs - startMs) / 60_000);
    }
  }

  const updated = applyPatch(id, patch);
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

  if (!exists(id)) return notFound();
  const updated = applyPatch(id, { state: "cancelled" });
  if (!updated) return notFound();
  return Response.json({ appointment: serialise(updated) });
}
