import { DentallyError } from "@/lib/dentally/client";
import { isDentallyWriteEnabled, dentallyAgentClient, buildManualBookingPayload } from "@/lib/dentally/write";
import { draftOutreach } from "@/lib/coordinator/draft";
import {
  approveTouch,
  enqueueOutbox,
  getOpportunity,
  insertTouch,
  listTouches,
  setLastTouchAt,
} from "@/lib/coordinator/repository";
import type {
  CoordinatorTouch,
  TouchChannel,
  TreatmentOpportunity,
} from "@/lib/coordinator/types";
import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const VALID_CHANNELS: readonly TouchChannel[] = ["sms", "email", "whatsapp"];

function isChannel(value: unknown): value is TouchChannel {
  return typeof value === "string" && VALID_CHANNELS.includes(value as TouchChannel);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function autoSendThreshold(): number {
  return Number(process.env.COORDINATOR_AUTO_SEND_THRESHOLD ?? 250);
}

/**
 * Whether the chosen channel is consented for this opportunity.
 * WhatsApp uses SMS consent as a proxy for now.
 */
function isChannelConsented(
  opportunity: TreatmentOpportunity,
  channel: TouchChannel,
): boolean {
  switch (channel) {
    case "email":
      return opportunity.consent.email;
    case "sms":
    case "whatsapp":
      return opportunity.consent.sms;
  }
}

function patientToRef(opportunity: TreatmentOpportunity): string {
  return `patient:${opportunity.dentallyPatientId}`;
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Action handlers.
// ---------------------------------------------------------------------------

async function handleDraft(body: Record<string, unknown>): Promise<Response> {
  const opportunityId = body.opportunityId;
  const channel = body.channel;

  if (typeof opportunityId !== "string" || opportunityId === "") {
    return badRequest("opportunityId is required");
  }
  if (!isChannel(channel)) {
    return badRequest("channel must be one of sms, email, whatsapp");
  }

  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) {
    return Response.json({ error: "Opportunity not found" }, { status: 404 });
  }

  const { body: draftBody, rationale } = await draftOutreach(opportunity, channel);

  let touch: CoordinatorTouch = await insertTouch({
    opportunityId: opportunity.id,
    siteId: opportunity.siteId,
    channel,
    body: draftBody,
    draftedBy: "claude",
    status: "draft",
  });

  const consented = isChannelConsented(opportunity, channel);
  const underThreshold = opportunity.amountOutstanding < autoSendThreshold();

  let autoQueued = false;
  if (underThreshold && consented) {
    // The touch was just inserted as 'draft', so this conditional approve transitions
    // it (returns non-null); guard defensively so a null never enqueues.
    const approved = await approveTouch(touch.id, "auto");
    if (approved) {
      await enqueueOutbox({
        touchId: approved.id,
        siteId: opportunity.siteId,
        channel,
        toRef: patientToRef(opportunity),
        body: draftBody,
      });
      touch = { ...approved, status: "queued" };
      autoQueued = true;
    }
  }

  return Response.json({
    touch,
    rationale,
    autoQueued,
    consentBlocked: underThreshold && !consented,
  });
}

async function handleApprove(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const opportunityId = body.opportunityId;
  const channel = body.channel;
  const toRef = body.toRef;

  if (typeof touchId !== "string" || touchId === "") {
    return badRequest("touchId is required");
  }
  if (typeof opportunityId !== "string" || opportunityId === "") {
    return badRequest("opportunityId is required");
  }
  if (!isChannel(channel)) {
    return badRequest("channel must be one of sms, email, whatsapp");
  }
  if (toRef !== undefined && typeof toRef !== "string") {
    return badRequest("toRef must be a string");
  }

  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) {
    return Response.json({ error: "Opportunity not found" }, { status: 404 });
  }

  // Consent gate, matching handleDraft and the unattended sweep: never enqueue a
  // patient touch on a channel the patient has not consented to, even on a manual
  // approve. Suppression (STOP) is enforced again later at the drain.
  if (!isChannelConsented(opportunity, channel)) {
    return Response.json(
      { ok: false, consentBlocked: true, error: "Patient has not consented to this channel" },
      { status: 409 },
    );
  }

  // Verify the touch belongs to THIS opportunity BEFORE approving, so a stray/foreign
  // touchId can never be approved and enqueued under this opportunity's recipient.
  const touches = await listTouches(opportunityId);
  const target = touches.find((t) => t.id === touchId);
  if (!target) {
    return Response.json({ ok: false, error: "touch not found for this opportunity" }, { status: 404 });
  }

  // Conditional approve (draft -> approved). A double-clicked / retried approve returns
  // null (already transitioned): idempotent no-op, do NOT enqueue a second outbox row.
  const touch = await approveTouch(touchId, "coordinator");
  if (!touch) {
    return Response.json({ ok: true, alreadyApproved: true });
  }
  await enqueueOutbox({
    touchId: touch.id,
    siteId: opportunity.siteId,
    channel,
    toRef: toRef ?? patientToRef(opportunity),
    body: touch.body,
  });

  return Response.json({ ok: true });
}

async function handleSend(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const opportunityId = body.opportunityId;

  if (typeof touchId !== "string" || touchId === "") {
    return badRequest("touchId is required");
  }
  if (typeof opportunityId !== "string" || opportunityId === "") {
    return badRequest("opportunityId is required");
  }

  // The approved touch was already enqueued by handleApprove; the shared drain
  // delivers it via Twilio and writes to_address (inbound-reply correlation). Do
  // NOT stub-send it here. This just records that the opportunity was actioned.
  void touchId;
  await setLastTouchAt(opportunityId, new Date().toISOString());

  return Response.json({ ok: true });
}

async function handleBook(body: Record<string, unknown>): Promise<Response> {
  const opportunityId = body.opportunityId;
  const start = body.start;

  if (typeof opportunityId !== "string" || opportunityId === "") {
    return badRequest("opportunityId is required");
  }
  if (typeof start !== "string" || start === "") {
    return badRequest("start is required");
  }

  // Manual bookings go through the SAME gate as the agent's writes: no real
  // appointment can be created until the write path is deliberately enabled.
  if (!isDentallyWriteEnabled()) {
    return Response.json(
      { error: "Booking into Dentally is not switched on yet. Ask your administrator to enable it." },
      { status: 503 },
    );
  }

  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) {
    return Response.json({ error: "Opportunity not found" }, { status: 404 });
  }

  // Whitelisted payload: patient_id comes from OUR opportunity record, never the body.
  const built = buildManualBookingPayload(body, opportunity.dentallyPatientId);
  if ("error" in built) return badRequest(built.error);

  try {
    const { appointment } = await dentallyAgentClient().createAppointment(built.payload);
    await insertTouch({
      opportunityId: opportunity.id,
      siteId: opportunity.siteId,
      channel: "sms",
      body: "Booked next step",
      draftedBy: "human",
      status: "sent",
    });
    await setLastTouchAt(opportunity.id, new Date().toISOString());
    return Response.json({ ok: true, appointment });
  } catch (err) {
    const message =
      err instanceof DentallyError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Dentally booking failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// Route.
// ---------------------------------------------------------------------------

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

  // Treatment Coordinator is outside CLINICIAN_SLUGS. The per-site check below is a
  // tenancy control, not a role one: a clinician's siteIds cover their own practice.
  const moduleDenied = requireModuleApiAccess(auth, "treatment-coordinator");
  if (moduleDenied) return moduleDenied;

  // THE PER-PERSON GATE on the SEND. Releasing a drafted message puts a text on a
  // real patient's phone in the practice's name; approving or drafting one does
  // not. Only "send" is gated, so a team member can still prepare the work for
  // somebody else to release — which is the arrangement a practice that wants
  // this control usually wants.
  if (action === "send") {
    const capabilityDenied = await requireCapability(auth, "messaging.lifecycle.send");
    if (capabilityDenied) return capabilityDenied;
  }

  // Per-site authz: every coordinator action carries an opportunityId. Resolve
  // its site and gate, mirroring recall/reactivation, so a user can't drive
  // outreach/booking on another tenant's opportunity by id.
  if (auth && typeof body.opportunityId === "string" && body.opportunityId !== "") {
    const opp = await getOpportunity(body.opportunityId);
    if (!opp) return Response.json({ error: "Opportunity not found" }, { status: 404 });
    const denied = requireSiteAccess(auth, opp.siteId);
    if (denied) return denied;

    // Owner kill switch: gate the state-changing coordinator actions so the owner
    // can switch the treatment coordinator off without a deploy.
    if (action === "draft" || action === "approve" || action === "send" || action === "book") {
      const _clientId = getSite(opp.siteId)?.clientId;
      if (_clientId && !(await isSystemEnabled(_clientId, "treatment-coordinator"))) {
        return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
      }
    }
  }

  switch (action) {
    case "draft":
      return handleDraft(body);
    case "approve":
      return handleApprove(body);
    case "send":
      return handleSend(body);
    case "book":
      return handleBook(body);
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
