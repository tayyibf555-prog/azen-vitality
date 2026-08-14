import { DentallyError } from "@/lib/dentally/client";
import {
  isDentallyWriteEnabled,
  dentallyAgentClient,
  buildManualBookingPayload,
} from "@/lib/dentally/write";
import {
  getTarget,
  getCadenceByTarget,
  updateCadence,
  setTargetStatus,
  addWaitlistEntry,
} from "@/lib/noshow/repository";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";
import type { FreedSlot } from "@/lib/noshow/types";
import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
/**
 * The honest 503 for a write action while the Dentally write gate is shut. Same
 * shape and wording as the recall / reactivation / coordinator book actions, so
 * every manual write path tells the practice the same thing.
 */
function writesOff(): Response {
  return Response.json(
    { error: "Booking into Dentally is not switched on yet. Ask your administrator to enable it." },
    { status: 503 },
  );
}
/** Site guard against the entity's real site; no-op when enforcement is off (auth null). */
function siteDenied(auth: AuthedUser | null, siteId: string): Response | null {
  return auth ? requireSiteAccess(auth, siteId) : null;
}
/** Owner kill switch for the no-show defence system, scoped to the resource's site. */
async function systemOff(siteId: string): Promise<Response | null> {
  const _clientId = getSite(siteId)?.clientId;
  if (_clientId && !(await isSystemEnabled(_clientId, "no-show-defence"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }
  return null;
}

async function handleConfirm(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });
  const denied = siteDenied(auth, target.siteId);
  if (denied) return denied;
  const off = await systemOff(target.siteId);
  if (off) return off;

  await setTargetStatus(targetId, "confirmed");
  const cadence = await getCadenceByTarget(targetId);
  if (cadence) await updateCadence(cadence.id, { status: "confirmed", endedAt: new Date().toISOString() });
  return Response.json({ ok: true });
}

async function handleCancel(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });
  const denied = siteDenied(auth, target.siteId);
  if (denied) return denied;
  // THE PER-PERSON GATE. Until now this route asked only "may you reach no-show
  // defence", so anybody who could open the module could cancel any appointment
  // in it. Cancelling is irreversible from this side (the slot is then offered to
  // the waitlist), which is exactly the kind of act the practice wanted to be able
  // to withhold from an individual. Checked before the kill switch so a caller who
  // cannot act causes no reads on their behalf.
  const capabilityDenied = await requireCapability(auth, "diary.appointment.cancel");
  if (capabilityDenied) return capabilityDenied;
  const off = await systemOff(target.siteId);
  if (off) return off;

  // Cancelling an appointment is a REAL WRITE to the practice diary, so it goes
  // through the same gate as every other write: the dedicated write client, only
  // when the write path is deliberately enabled. It must never be attempted with
  // the read key or outside the gate.
  let dentallyCancelled = false;
  if (isDentallyWriteEnabled()) {
    try {
      await dentallyAgentClient().cancelAppointment(target.appointmentId);
      dentallyCancelled = true;
    } catch (err) {
      console.error(
        `[noshow] cancel: Dentally cancelAppointment(${target.appointmentId}) failed; ` +
          "our side is marked cancelled but the slot is NOT offered to the waitlist",
        err,
      );
    }
  }

  // Stop the reminders either way: staff have told us this patient is not coming.
  await setTargetStatus(targetId, "cancelled");
  const cadence = await getCadenceByTarget(targetId);
  if (cadence) await updateCadence(cadence.id, { status: "cancelled", endedAt: new Date().toISOString() });

  // Only offer the slot when Dentally ACTUALLY released it. Offering a slot the
  // diary still holds (writes disabled, wrong key, transient error) promises a
  // waitlist patient a chair that is still taken, and they turn up to a clash.
  // The inbound reply path already works this way; this mirrors it.
  let offeredTo: string | null = null;
  if (dentallyCancelled) {
    const slot: FreedSlot = {
      appointmentId: target.appointmentId,
      siteId: target.siteId,
      startAt: target.appointmentStartAt,
      durationMin: target.durationMin || 30,
      practitioner: target.practitioner,
    };
    const offered = await offerSlotToNextCandidate(slot);
    offeredTo = offered?.waitlistId ?? null;
  }
  return Response.json({ ok: true, dentallyCancelled, offeredTo });
}

/** start + duration as an ISO finish time, for a caller that only sends a start. */
function finishTimeFrom(startIso: string, durationMin: number): string | null {
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) return null;
  return new Date(startMs + durationMin * 60_000).toISOString();
}

async function handleBook(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  // Rebooking is keyed on OUR target, never on a caller-supplied site or patient:
  // the target is what carries the authorized site and the real Dentally patient id.
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });
  const denied = siteDenied(auth, target.siteId);
  if (denied) return denied;
  const off = await systemOff(target.siteId);
  if (off) return off;

  const start =
    (typeof body.start_time === "string" && body.start_time) || (typeof body.start === "string" && body.start) || "";
  if (start === "") return badRequest("start is required");

  // Manual bookings go through the SAME gate as the agent's writes: no real
  // appointment can be created until the write path is deliberately enabled.
  if (!isDentallyWriteEnabled()) return writesOff();

  // Whitelisted payload, exactly like the recall / reactivation / coordinator book
  // actions: patient_id comes from OUR target record and nothing is forwarded from
  // the raw request body. A caller that sends only a start gets the finish derived
  // from the appointment's own duration, since Dentally rejects a booking with no
  // end time.
  const duration = typeof body.duration === "number" && body.duration > 0 ? body.duration : target.durationMin || 30;
  const finish =
    typeof body.finish_time === "string" && body.finish_time ? body.finish_time : finishTimeFrom(start, duration);
  if (!finish) return badRequest("start must be a valid ISO time");
  const built = buildManualBookingPayload(
    {
      start_time: start,
      finish_time: finish,
      practitioner_id: body.practitioner_id,
      reason: body.reason,
      notes: typeof body.notes === "string" && body.notes ? body.notes : "Rebooked after a missed or cancelled visit",
    },
    target.dentallyPatientId,
  );
  if ("error" in built) return badRequest(built.error);

  try {
    const { appointment } = await dentallyAgentClient().createAppointment(built.payload);
    // The old appointment is settled: stop its confirmations so the patient is not
    // reminded about a time they have just moved away from.
    await setTargetStatus(targetId, "confirmed");
    const cadence = await getCadenceByTarget(targetId);
    if (cadence) await updateCadence(cadence.id, { status: "confirmed", endedAt: new Date().toISOString() });
    return Response.json({ ok: true, appointment });
  } catch (err) {
    const message =
      err instanceof DentallyError ? err.message : err instanceof Error ? err.message : "Dentally booking failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

async function handleAddWaitlist(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  const siteId = body.siteId;
  const dentallyPatientId = body.dentallyPatientId;
  const patientName = body.patientName;
  if (typeof siteId !== "string" || siteId === "") return badRequest("siteId is required");
  const denied = siteDenied(auth, siteId);
  if (denied) return denied;
  if (typeof dentallyPatientId !== "string" || dentallyPatientId === "") return badRequest("dentallyPatientId is required");
  if (typeof patientName !== "string" || patientName === "") return badRequest("patientName is required");
  // Consent must be explicit: we will message this patient when a slot frees.
  if (body.consentSms !== true) return badRequest("consentSms must be true to add to the waitlist");

  const entry = await addWaitlistEntry({
    siteId,
    dentallyPatientId,
    patientName,
    treatment: typeof body.treatment === "string" ? body.treatment : null,
    practitionerPref: typeof body.practitionerPref === "string" ? body.practitionerPref : null,
    earliestAt: typeof body.earliestAt === "string" ? body.earliestAt : null,
    latestAt: typeof body.latestAt === "string" ? body.latestAt : null,
    durationMin: typeof body.durationMin === "number" ? body.durationMin : 30,
    consent: {
      sms: true,
      email: body.consentEmail === true,
      marketing: body.consentMarketing === true,
    },
  });
  return Response.json({ ok: true, entry });
}

async function handlePauseResume(
  body: Record<string, unknown>,
  auth: AuthedUser | null,
  resume: boolean,
): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const cadence = await getCadenceByTarget(targetId);
  if (!cadence) return Response.json({ error: "No cadence for target" }, { status: 404 });
  const denied = siteDenied(auth, cadence.siteId);
  if (denied) return denied;
  const off = await systemOff(cadence.siteId);
  if (off) return off;
  await updateCadence(cadence.id, { status: resume ? "active" : "paused" });
  return Response.json({ ok: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  // Authenticate once; each handler authorizes against its entity's real site.
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  // No-show defence is outside CLINICIAN_SLUGS. Checked once here rather than in each
  // handler, because every branch below reaches patient contact or the waitlist.
  const moduleDenied = requireModuleApiAccess(auth, "no-show-defence");
  if (moduleDenied) return moduleDenied;

  switch (action) {
    case "confirm":
      return handleConfirm(body, auth);
    case "cancel":
      return handleCancel(body, auth);
    case "book":
      return handleBook(body, auth);
    case "add-waitlist":
      return handleAddWaitlist(body, auth);
    case "pause":
      return handlePauseResume(body, auth, false);
    case "resume":
      return handlePauseResume(body, auth, true);
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
