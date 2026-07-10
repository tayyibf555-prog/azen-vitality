import { DentallyError } from "@/lib/dentally/client";
import { isDentallyWriteEnabled, dentallyAgentClient, buildManualBookingPayload } from "@/lib/dentally/write";
import { draftRecall } from "@/lib/recall/draft";
import { stepDef, advanceAfter, RECALL_CADENCE } from "@/lib/recall/cadence";
import { shouldGraduate } from "@/lib/recall/normalise";
import {
  getTarget,
  getCadenceByTarget,
  createCadence,
  updateCadence,
  incrementPriorAttempts,
  setTargetStatus,
  markGraduated,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  listTouches,
  hasPendingOutboxForTouch,
} from "@/lib/recall/repository";
import type { RecallTarget } from "@/lib/recall/types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const VALID_CHANNELS: readonly TouchChannel[] = ["sms", "email", "whatsapp"];
function isChannel(v: unknown): v is TouchChannel {
  return typeof v === "string" && VALID_CHANNELS.includes(v as TouchChannel);
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function leadWindowDays(): number {
  return Number(process.env.RECALL_LEAD_WINDOW_DAYS ?? 14);
}
function graceDays(): number {
  return Number(process.env.RECALL_GRACE_DAYS ?? 60);
}
function channelConsented(t: RecallTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}
function patientToRef(t: RecallTarget): string {
  return `patient:${t.dentallyPatientId}`;
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * True when the target already has an outbound touch in flight (drafted, approved
 * or queued but not yet sent/failed). Mirrors the SWEEP path's `hasPending`
 * predicate exactly so a manual draft/approve+enqueue is idempotent: a double-
 * click, retry, or concurrent coordinator action must not enqueue a second
 * patient message for the same target+step.
 */
async function hasPendingTouch(targetId: string): Promise<boolean> {
  const touches = await listTouches(targetId);
  return touches.some(
    (t) => t.direction !== "inbound" && t.status !== "sent" && t.status !== "failed",
  );
}

/** Settle the target once a cadence exhausts: graduate to reactivation if past grace, else done. */
async function settleExhausted(target: RecallTarget, now: Date): Promise<void> {
  const overdueNow = (now.getTime() - new Date(target.dueAt).getTime()) / DAY;
  if (shouldGraduate(overdueNow, graceDays())) {
    await markGraduated(target.id);
  } else {
    await setTargetStatus(target.id, "exhausted");
  }
}

async function handleEnrol(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  let cadence = await getCadenceByTarget(targetId);
  if (!cadence) {
    // Anchor step 1 to the due date itself: a still-due-soon patient is reached ON the
    // due date, an already-overdue one immediately. (The old `- leadWindowDays*DAY`
    // pushed the anchor into the past for every in-window target, so it ALWAYS fired
    // immediately — dead code that contradicted the documented on/near-due intent.)
    const anchor = new Date(target.dueAt).getTime();
    const nextDueAt = new Date(Math.max(Date.now(), anchor)).toISOString();
    cadence = await createCadence({ targetId, siteId: target.siteId, nextDueAt });
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

  // Idempotency guard (mirrors the sweep's hasPending check): if an outbound touch
  // is already in flight for this target+step, a repeat draft (double-click / retry)
  // must not insert a fresh touch and enqueue a second patient message.
  if (await hasPendingTouch(targetId)) {
    return Response.json({ skipped: true, reason: "pending_touch", autoQueued: false });
  }

  const cadence = await getCadenceByTarget(targetId);
  const stepNumber = (cadence?.currentStep ?? 0) + 1;
  const step = stepDef(stepNumber, RECALL_CADENCE) ?? stepDef(1, RECALL_CADENCE)!;

  const { body: draftBody, rationale } = await draftRecall(target, channel, step);
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

  // Recall is routine and high-volume: auto-send whenever the channel is consented.
  const consented = channelConsented(target, channel);
  let autoQueued = false;
  if (consented) {
    touch = await approveTouch(touch.id, "auto");
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel,
      toRef: patientToRef(target),
      body: draftBody,
    });
    touch = { ...touch, status: "queued" };
    autoQueued = true;
  }

  return Response.json({
    touch,
    rationale,
    step: step.step,
    autoQueued,
    consentBlocked: !consented,
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
  // touchId (stale UI, mismatched ids, cross-site access) can never approve and enqueue
  // another target's message body to this target's patient.
  const touches = await listTouches(target.id);
  const targetTouch = touches.find((t) => t.id === touchId);
  if (!targetTouch) {
    return Response.json({ error: "touch not found for this target" }, { status: 404 });
  }

  // Idempotency guard: recall_outbox has no unique constraint on touch_id, so a
  // double-click / retry / concurrent approve would enqueue a second patient
  // message for the same touch. Skip if this touch already has a non-failed
  // outbox row (pending or queued).
  if (await hasPendingOutboxForTouch(touchId)) {
    return Response.json({ ok: true, skipped: true, reason: "already_enqueued" });
  }

  const touch = await approveTouch(touchId, "coordinator");
  await enqueueOutbox({
    touchId: touch.id,
    siteId: target.siteId,
    // Take the channel + body from the stored touch, never the client body, so a
    // mismatched body.channel can't dispatch (e.g.) an email-length body as an SMS.
    channel: targetTouch.channel,
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

  const cadence = await getCadenceByTarget(targetId);
  if (cadence) {
    // Guard against a stale / replayed client-supplied step rewinding the cadence and
    // re-sending a later step: only advance when this is genuinely the NEXT step.
    if (step !== cadence.currentStep + 1) {
      return Response.json({ ok: true, skipped: true, reason: "stale_step" });
    }
    await incrementPriorAttempts(targetId);
    const adv = advanceAfter(step, now, RECALL_CADENCE);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
    });
    if (adv.status === "exhausted") {
      const target = await getTarget(targetId);
      if (target) await settleExhausted(target, now);
    }
  } else {
    // No cadence (a manual one-off send): keep the attempt bookkeeping.
    await incrementPriorAttempts(targetId);
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
  const built = buildManualBookingPayload(body, target.dentallyPatientId);
  if ("error" in built) return badRequest(built.error);

  try {
    const { appointment } = await dentallyAgentClient().createAppointment(built.payload);
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
      body: "Booked recall appointment",
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

    // Owner kill switch: gate the state-changing recall actions so the owner can
    // switch recall off without a deploy.
    if (
      action === "draft" ||
      action === "approve" ||
      action === "send" ||
      action === "enrol" ||
      action === "book" ||
      action === "pause" ||
      action === "resume"
    ) {
      const _clientId = getSite(siteId)?.clientId;
      if (_clientId && !(await isSystemEnabled(_clientId, "recall"))) {
        return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
      }
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
