import { DentallyClient, DentallyError } from "@/lib/dentally/client";
import {
  getTarget,
  getCadenceByTarget,
  updateCadence,
  setTargetStatus,
  addWaitlistEntry,
} from "@/lib/noshow/repository";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";
import type { FreedSlot } from "@/lib/noshow/types";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
function dentallyClient(): DentallyClient | null {
  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return null;
  return new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });
}
/** Site guard against the entity's real site; no-op when enforcement is off (auth null). */
function siteDenied(auth: AuthedUser | null, siteId: string): Response | null {
  return auth ? requireSiteAccess(auth, siteId) : null;
}

async function handleConfirm(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });
  const denied = siteDenied(auth, target.siteId);
  if (denied) return denied;

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

  // Free the slot in Dentally where we can, then mark our side and offer the waitlist.
  const client = dentallyClient();
  if (client) {
    try {
      await client.cancelAppointment(target.appointmentId);
    } catch {
      /* best effort: still record our cancellation so the slot can be reused */
    }
  }
  await setTargetStatus(targetId, "cancelled");
  const cadence = await getCadenceByTarget(targetId);
  if (cadence) await updateCadence(cadence.id, { status: "cancelled", endedAt: new Date().toISOString() });

  const slot: FreedSlot = {
    appointmentId: target.appointmentId,
    siteId: target.siteId,
    startAt: target.appointmentStartAt,
    durationMin: target.durationMin || 30,
    practitioner: target.practitioner,
  };
  const offered = await offerSlotToNextCandidate(slot);
  return Response.json({ ok: true, offeredTo: offered?.waitlistId ?? null });
}

async function handleBook(body: Record<string, unknown>, auth: AuthedUser | null): Promise<Response> {
  // The booking site must be explicit and authorized; never trust a pass-through.
  const siteId =
    typeof body.site_id === "string" && body.site_id !== ""
      ? body.site_id
      : typeof body.targetId === "string"
        ? body.targetId.split(":")[0]
        : "";
  if (!siteId) return badRequest("site_id is required");
  const denied = siteDenied(auth, siteId);
  if (denied) return denied;

  const patientId = body.patient_id;
  const start = (typeof body.start_time === "string" && body.start_time) || (typeof body.start === "string" && body.start) || "";
  if (typeof patientId !== "string" || patientId === "") return badRequest("patient_id is required");
  if (start === "") return badRequest("start is required");

  const client = dentallyClient();
  if (!client) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // Allowlist the fields sent to Dentally; the site is the authorized one.
  const payload: Record<string, unknown> = {
    site_id: siteId,
    patient_id: patientId,
    start_time: start,
    duration: typeof body.duration === "number" ? body.duration : 30,
    ...(typeof body.practitioner === "string" ? { practitioner: body.practitioner } : {}),
    booked_via_api: true,
  };
  try {
    const { appointment } = await client.createAppointment(payload);
    if (typeof body.targetId === "string" && body.targetId !== "") {
      await setTargetStatus(body.targetId, "confirmed");
    }
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
