import { DentallyClient, DentallyError } from "@/lib/dentally/client";
import { draftOutreach } from "@/lib/coordinator/draft";
import {
  approveTouch,
  enqueueOutbox,
  getOpportunity,
  insertTouch,
  markTouchSent,
  setLastTouchAt,
} from "@/lib/coordinator/repository";
import type {
  CoordinatorTouch,
  TouchChannel,
  TreatmentOpportunity,
} from "@/lib/coordinator/types";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";

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
    touch = await approveTouch(touch.id, "auto");
    await enqueueOutbox({
      touchId: touch.id,
      siteId: opportunity.siteId,
      channel,
      toRef: patientToRef(opportunity),
      body: draftBody,
    });
    touch = { ...touch, status: "queued" };
    autoQueued = true;
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

  const touch = await approveTouch(touchId, "coordinator");
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

  // STUB adapter: mark the touch (and its outbox row) sent, provider 'stub'.
  await markTouchSent(touchId);
  await setLastTouchAt(opportunityId, new Date().toISOString());

  return Response.json({ ok: true, sentVia: "stub" });
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

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }

  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) {
    return Response.json({ error: "Opportunity not found" }, { status: 404 });
  }

  const client = new DentallyClient({
    apiKey,
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });

  // Forward every caller-supplied field except our routing key, then stamp
  // booked_via_api so Dentally records the booking source.
  const { opportunityId: _omit, ...rest } = body;
  void _omit;
  const payload: Record<string, unknown> = { ...rest, booked_via_api: true };

  try {
    const { appointment } = await client.createAppointment(payload);
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

  // Per-site authz: every coordinator action carries an opportunityId. Resolve
  // its site and gate, mirroring recall/reactivation, so a user can't drive
  // outreach/booking on another tenant's opportunity by id.
  if (auth && typeof body.opportunityId === "string" && body.opportunityId !== "") {
    const opp = await getOpportunity(body.opportunityId);
    if (!opp) return Response.json({ error: "Opportunity not found" }, { status: 404 });
    const denied = requireSiteAccess(auth, opp.siteId);
    if (denied) return denied;
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
