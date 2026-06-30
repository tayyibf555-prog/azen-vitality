import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listAppointments, listPatients } from "@/lib/dentally/read";
import { isSuppressed } from "@/lib/messaging/suppression";
import type { TouchChannel } from "@/lib/reactivation/types";
import { reviewSendAt, reviewScheduleFromEnv } from "@/lib/reviews/schedule";
import { createScheduled, getByAppointment, markStatus } from "@/lib/reviews/repository";

export const dynamic = "force-dynamic";

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// SMS is the default review-request channel (highest open rate); email is used
// only when SMS consent is absent but email consent is present.
function pickChannel(smsConsent: boolean, emailConsent: boolean): TouchChannel | null {
  if (smsConsent) return "sms";
  if (emailConsent) return "email";
  return null;
}

// POST /api/reviews/attend
// Body: { clientSlug, appointmentId, attended: boolean }
// attended true  -> schedule a single review request (idempotent on appointment id),
//                   honouring consent + suppression at scheduling time.
// attended false -> record nothing; the patient is simply not asked.
export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId : "";
  const attended = body.attended === true;
  if (clientSlug === "") return badRequest("clientSlug is required");
  if (appointmentId === "") return badRequest("appointmentId is required");

  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // Not attended: there is nothing to schedule. Surface any existing request so the
  // caller sees the unchanged state (a prior attend is not undone here).
  if (!attended) {
    const existing = await getByAppointment(appointmentId);
    return Response.json({ ok: true, attended: false, request: existing });
  }

  // Already scheduled/sent for this appointment: idempotent, return as-is.
  const existing = await getByAppointment(appointmentId);
  if (existing) {
    return Response.json({ ok: true, attended: true, request: existing, status: existing.status });
  }

  const siteIds = getSites(client.id).map((s) => s.id);

  // Resolve the appointment from the client's sites. There is no by-id Dentally
  // read, so we look across recent appointments (mock + real both expose this).
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const appts = await listAppointments(siteIds, { from, to });
  const appt = appts.find((a) => a.id === appointmentId);
  if (!appt) return Response.json({ ok: false, error: "Appointment not found" }, { status: 404 });

  // Authorize against the appointment's real site, not just the client.
  if (auth && !auth.siteIds.includes(appt.siteId)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Patient + consent. Without a deliverable, consented channel we record a
  // 'skipped' marker (still one row per appointment) rather than scheduling a send.
  const patients = await listPatients([appt.siteId]);
  const patient = patients.find((p) => p.id === appt.patientId) ?? null;
  if (!patient) return Response.json({ ok: false, error: "Patient not found" }, { status: 404 });

  const channel = pickChannel(patient.smsConsent, patient.emailConsent);
  if (!channel) {
    const req = await createScheduled({
      siteId: appt.siteId,
      dentallyAppointmentId: appointmentId,
      dentallyPatientId: appt.patientId,
      patientName: appt.patientName,
      channel: "sms",
      attendedAt: new Date().toISOString(),
      sendAt: new Date().toISOString(),
    });
    await markStatus(req.id, "skipped");
    return Response.json({ ok: true, attended: true, status: "skipped", reason: "no consent" });
  }

  // Already opted out on this channel: do not schedule, record 'suppressed'.
  const patientRef = `patient:${appt.patientId}`;
  if (await isSuppressed(appt.siteId, channel, patientRef)) {
    const req = await createScheduled({
      siteId: appt.siteId,
      dentallyAppointmentId: appointmentId,
      dentallyPatientId: appt.patientId,
      patientName: appt.patientName,
      channel,
      attendedAt: new Date().toISOString(),
      sendAt: new Date().toISOString(),
    });
    await markStatus(req.id, "suppressed");
    return Response.json({ ok: true, attended: true, status: "suppressed" });
  }

  const attendedAt = new Date();
  const sendAt = reviewSendAt(attendedAt, reviewScheduleFromEnv());
  const req = await createScheduled({
    siteId: appt.siteId,
    dentallyAppointmentId: appointmentId,
    dentallyPatientId: appt.patientId,
    patientName: appt.patientName,
    channel,
    attendedAt: attendedAt.toISOString(),
    sendAt,
  });
  return Response.json({ ok: true, attended: true, status: req.status, request: req });
}
