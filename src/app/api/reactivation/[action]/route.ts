import { DentallyError } from "@/lib/dentally/client";
import { isDentallyWriteEnabled, dentallyAgentClient, buildManualBookingPayload } from "@/lib/dentally/write";
import { fetchAvailabilityDays, findExactSlot, type BookingSlot } from "@/lib/booking/slots";
import { londonDayKey } from "@/lib/time/london";
import { draftReactivation } from "@/lib/reactivation/draft";
import { stepDef, advanceAfter } from "@/lib/reactivation/cadence";
import {
  getTarget,
  getCadenceByTarget,
  createCadence,
  updateCadence,
  insertTouch,
  listTouches,
  approveTouch,
  enqueueOutbox,
  incrementPriorAttempts,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import type { ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";
import { withinLapseWindow } from "@/lib/reactivation/normalise";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

const VALID_CHANNELS: readonly TouchChannel[] = ["sms", "email", "whatsapp"];
function isChannel(v: unknown): v is TouchChannel {
  return typeof v === "string" && VALID_CHANNELS.includes(v as TouchChannel);
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function autoSendThreshold(): number {
  return Number(process.env.REACTIVATION_AUTO_SEND_THRESHOLD ?? 250);
}
function channelConsented(t: ReactivationTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms;
}
function patientToRef(t: ReactivationTarget): string {
  return `patient:${t.dentallyPatientId}`;
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** YYYY-MM-DD shifted by whole days (UTC-safe). */
function shiftYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function handleEnrol(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  // Hard lapse ceiling (1 year): stored rows age while the sync only re-pulls
  // patients Dentally marks updated, so a stale worklist row can sit past the
  // window. Manual enrolment must not start a cadence for such a patient.
  if (!withinLapseWindow(target.lastVisitAt, new Date())) {
    return Response.json(
      { error: "This patient's last visit is outside the reactivation window (1 year maximum), so they can't be enrolled." },
      { status: 409 },
    );
  }

  let cadence = await getCadenceByTarget(targetId);
  if (!cadence) {
    cadence = await createCadence({
      targetId,
      siteId: target.siteId,
      nextDueAt: new Date().toISOString(),
    });
  }
  await setTargetStatus(targetId, "in_cadence");
  return Response.json({ ok: true, cadence });
}

async function handleDraft(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  const channel = body.channel;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (!isChannel(channel)) return badRequest("channel must be one of sms, email, whatsapp");

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  // Same hard ceiling as enrolment: this path can auto-queue a real message for a
  // dormant target without ever enrolling it, so it must re-check the window too.
  if (!withinLapseWindow(target.lastVisitAt, new Date())) {
    return Response.json(
      { error: "This patient's last visit is outside the reactivation window (1 year maximum), so a message can't be drafted." },
      { status: 409 },
    );
  }

  let cadence = await getCadenceByTarget(targetId);
  const stepNumber = (cadence?.currentStep ?? 0) + 1;
  const step = stepDef(stepNumber) ?? stepDef(1)!;

  const { body: draftBody, rationale } = await draftReactivation(target, channel, step);

  const consented = channelConsented(target, channel);

  // A manual draft that can actually be sent has to run ON a cadence. Without one
  // the touch sticks at step 1 for ever: nothing advances the position, so steps 2
  // and 3 never fire and the target is silently abandoned after a single message.
  // (This is also what keeps the sync's auto-enrolment from later starting the same
  // target at step 1 again.) Created only when the channel is consented, since an
  // unsendable draft starts nothing. Anchored now, exactly as the enrol action does.
  if (consented && !cadence) {
    cadence = await createCadence({
      targetId,
      siteId: target.siteId,
      nextDueAt: new Date().toISOString(),
    });
    await setTargetStatus(targetId, "in_cadence");
  }

  let touch = await insertTouch({
    targetId: target.id,
    cadenceId: cadence?.id ?? "",
    siteId: target.siteId,
    step: step.step,
    channel,
    body: draftBody,
    draftedBy: "claude",
    status: "draft",
  });

  const underThreshold = target.recoverableValue < autoSendThreshold();
  let autoQueued = false;
  if (underThreshold && consented) {
    // Fresh draft -> conditional approve transitions it (non-null); guard for the type.
    const approved = await approveTouch(touch.id, "auto");
    if (approved) {
      // Advance the cadence BEFORE enqueue when this target is enrolled, mirroring the
      // sweep. Without this the cadence stays on the same step and the next sweep
      // re-drafts and re-sends it (#17); advancing first also means a kill before
      // enqueue skips a step rather than double-sending.
      if (cadence) {
        const now = new Date();
        await incrementPriorAttempts(target.id);
        const adv = advanceAfter(step.step, now);
        await updateCadence(cadence.id, {
          currentStep: adv.currentStep,
          status: adv.status,
          nextDueAt: adv.nextDueAt,
          endedAt: adv.endedAt,
        });
        // Last step: settle the target here so an auto-queued final message does
        // not leave it sitting in_cadence against a finished cadence.
        if (adv.status === "exhausted") await setTargetStatus(target.id, "exhausted");
      }
      await enqueueOutbox({
        touchId: approved.id,
        siteId: target.siteId,
        channel,
        toRef: patientToRef(target),
        body: draftBody,
      });
      touch = { ...approved, status: "queued" };
      autoQueued = true;
    }
  }

  return Response.json({
    touch,
    rationale,
    step: step.step,
    autoQueued,
    consentBlocked: underThreshold && !consented,
  });
}

async function handleApprove(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const targetId = body.targetId;
  const channel = body.channel;
  const toRef = body.toRef;
  if (typeof touchId !== "string" || touchId === "") return badRequest("touchId is required");
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (!isChannel(channel)) return badRequest("channel must be one of sms, email, whatsapp");
  if (toRef !== undefined && typeof toRef !== "string") return badRequest("toRef must be a string");

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  // Hard lapse ceiling at APPROVE time too: a high-value draft is created while the
  // patient is in-window but can sit awaiting approval; if they cross the 1-year
  // boundary in the meantime, approving it must not text them. This was the one
  // path that could still enqueue for an over-window patient.
  if (!withinLapseWindow(target.lastVisitAt, new Date())) {
    return Response.json(
      { error: "This patient's last visit is now outside the reactivation window (1 year maximum), so this draft can't be sent." },
      { status: 409 },
    );
  }

  // Verify the touch belongs to THIS target before approving, so a stray/foreign
  // touchId can never be approved and enqueued to this target's patient.
  const touches = await listTouches(target.id);
  if (!touches.some((t) => t.id === touchId)) {
    return Response.json({ error: "touch not found for this target" }, { status: 404 });
  }

  // Conditional approve (draft -> approved). A double-clicked / retried approve returns
  // null (already transitioned): idempotent no-op, do NOT enqueue a second outbox row.
  const touch = await approveTouch(touchId, "coordinator");
  if (!touch) return Response.json({ ok: true, alreadyApproved: true });
  await enqueueOutbox({
    touchId: touch.id,
    siteId: target.siteId,
    channel,
    toRef: toRef ?? patientToRef(target),
    body: touch.body,
  });
  return Response.json({ ok: true });
}

async function handleSend(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const targetId = body.targetId;
  const step = body.step;
  if (typeof touchId !== "string" || touchId === "") return badRequest("touchId is required");
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (typeof step !== "number") return badRequest("step (number) is required");

  const now = new Date();
  // The approved touch was already enqueued by handleApprove; the shared drain
  // delivers it and writes to_address. Do NOT stub-send it here (that would orphan
  // replies). We only advance the cadence and attempt bookkeeping.
  void touchId;
  await incrementPriorAttempts(targetId);

  // Advance the cadence position past the step we just sent.
  const cadence = await getCadenceByTarget(targetId);
  if (cadence) {
    const adv = advanceAfter(step, now);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
    });
    if (adv.status === "exhausted") await setTargetStatus(targetId, "exhausted");
  }

  return Response.json({ ok: true });
}

async function handlePauseResume(body: Record<string, unknown>, resume: boolean): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const cadence = await getCadenceByTarget(targetId);
  if (!cadence) return Response.json({ error: "No cadence for target" }, { status: 404 });
  await updateCadence(cadence.id, {
    status: resume ? "active" : "paused",
    ...(resume ? { nextDueAt: new Date().toISOString() } : {}),
  });
  return Response.json({ ok: true });
}

async function handleBook(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  const start = body.start;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (typeof start !== "string" || start === "") return badRequest("start is required");

  // Manual bookings go through the SAME gate as the agent's writes: no real
  // appointment can be created until the write path is deliberately enabled.
  if (!isDentallyWriteEnabled()) {
    return Response.json(
      { error: "Booking into Dentally is not switched on yet. Ask your administrator to enable it." },
      { status: 503 },
    );
  }

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  // Whitelisted payload: patient_id comes from OUR target record, never the body.
  // Validated first so a body missing the end time or the clinician is refused
  // before we spend a Dentally availability read on it.
  const built = buildManualBookingPayload(body, target.dentallyPatientId);
  if ("error" in built) return badRequest(built.error);

  // Slot revalidation, live and uncached, exactly as the public create route does:
  // the coordinator's chosen slot must STILL be free in Dentally, and the write
  // then uses the live slot's own end time and clinician rather than the browser's
  // copy. The day is queried with a +1 day end so an exclusive end-date reading of
  // the availability filter can never hide that day's own evening slots.
  const dentally = dentallyAgentClient();
  const day = londonDayKey(new Date(start));
  let liveSlot: BookingSlot | null = null;
  try {
    const days = await fetchAvailabilityDays(dentally, target.siteId, day, shiftYmd(day, 1), new Date());
    liveSlot = findExactSlot(
      days,
      start,
      typeof body.finish_time === "string" ? body.finish_time : "",
      typeof body.practitioner_id === "string" ? body.practitioner_id : null,
    );
  } catch {
    return Response.json(
      { error: "We could not check the diary just now. Please try again shortly." },
      { status: 502 },
    );
  }
  if (!liveSlot) {
    return Response.json({ error: "That time has just been taken. Please pick another slot." }, { status: 409 });
  }
  const confirmed = buildManualBookingPayload(
    { ...body, start_time: liveSlot.start, finish_time: liveSlot.finish, practitioner_id: liveSlot.practitionerId ?? "" },
    target.dentallyPatientId,
  );
  if ("error" in confirmed) return badRequest(confirmed.error);

  try {
    const { appointment } = await dentally.createAppointment(confirmed.payload);
    const cadence = await getCadenceByTarget(targetId);
    if (cadence) {
      await updateCadence(cadence.id, { status: "converted", endedAt: new Date().toISOString() });
    }
    await setTargetStatus(targetId, "converted");
    await insertTouch({
      targetId: target.id,
      cadenceId: cadence?.id ?? "",
      siteId: target.siteId,
      step: 0,
      channel: "sms",
      body: "Booked re-engagement appointment",
      draftedBy: "human",
      status: "sent",
    });
    return Response.json({ ok: true, appointment });
  } catch (err) {
    const message =
      err instanceof DentallyError ? err.message : err instanceof Error ? err.message : "Dentally booking failed";
    return Response.json({ error: message }, { status: 502 });
  }
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

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  if (auth && typeof body.targetId === "string") {
    const siteId = body.targetId.split(":")[0];
    const denied = requireSiteAccess(auth, siteId);
    if (denied) return denied;
    const _clientId = getSite(siteId)?.clientId;
    if (_clientId && !(await isSystemEnabled(_clientId, "reactivation"))) {
      return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
    }
  }

  switch (action) {
    case "enrol":
      return handleEnrol(body);
    case "draft":
      return handleDraft(body);
    case "approve":
      return handleApprove(body);
    case "send":
      return handleSend(body);
    case "pause":
      return handlePauseResume(body, false);
    case "resume":
      return handlePauseResume(body, true);
    case "book":
      return handleBook(body);
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
