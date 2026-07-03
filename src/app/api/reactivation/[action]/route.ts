import { DentallyClient, DentallyError } from "@/lib/dentally/client";
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
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";

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

async function handleEnrol(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

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

  const cadence = await getCadenceByTarget(targetId);
  const stepNumber = (cadence?.currentStep ?? 0) + 1;
  const step = stepDef(stepNumber) ?? stepDef(1)!;

  const { body: draftBody, rationale } = await draftReactivation(target, channel, step);
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

  const consented = channelConsented(target, channel);
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
        await incrementPriorAttempts(target.id);
        const adv = advanceAfter(step.step, new Date());
        await updateCadence(cadence.id, {
          currentStep: adv.currentStep,
          status: adv.status,
          nextDueAt: adv.nextDueAt,
          endedAt: adv.endedAt,
        });
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

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  const client = new DentallyClient({
    apiKey,
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });

  const { targetId: _omit, ...rest } = body;
  void _omit;
  const payload: Record<string, unknown> = { ...rest, booked_via_api: true };

  try {
    const { appointment } = await client.createAppointment(payload);
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
    const denied = requireSiteAccess(auth, body.targetId.split(":")[0]);
    if (denied) return denied;
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
