import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import { getOpportunity } from "@/lib/coordinator/repository";
import { approveDraft, discardDraft, getTouch } from "@/lib/closer/repository";
import { checkCloserDraft, remainingValueOf } from "@/lib/closer/draft";
import { parseApproveRequest, parseDiscardRequest, refusalMessage } from "@/lib/closer/approval";
import { discardOutcome } from "@/lib/closer/discard";
import { closerConfig } from "@/lib/closer/types";
import type { TouchChannel, TreatmentOpportunity } from "@/lib/coordinator/types";
import type { CloserTouch } from "@/lib/closer/types";
import type { AuthedUser } from "@/lib/auth/session";

// ===========================================================================
// THE TREATMENT-PLAN CLOSER'S APPROVAL SURFACE.
//
// Two actions, and between them they are the ONLY route out of `draft`:
//
//   approve  the draft, optionally with a human's edit, becomes a queued outbox
//            row the shared messaging drain will deliver;
//   discard  the draft dies, and the reason the human gave decides whether the
//            opportunity cools off or stops for good.
//
// NOTHING HERE SENDS. `approveDraft` writes a closer_outbox row and stops; the
// shared drain owns suppression, the frequency cap, the atomic claim, the dry-run
// flag and the provider call, exactly as it does for every other module. There is
// no new send machinery in this file and there must never be.
//
// WHAT THE CALLER MAY NAME, AND WHAT IT MAY NOT.
//
// A request carries a touch id, and for a discard a reason, and that is all. The
// site, the opportunity, the channel and the RECIPIENT are read from the stored
// touch and its opportunity, server-side. A caller cannot point an approved
// message at a different phone number, move it onto a channel the patient has not
// consented to, or approve a touch belonging to another practice: the parser has
// no field for any of it (src/lib/closer/approval.ts), which is a stronger
// guarantee than this file remembering not to read one.
// ===========================================================================

export const dynamic = "force-dynamic";

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

function notFound(): Response {
  return Response.json({ ok: false, error: "That draft no longer exists." }, { status: 404 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Who to record against the transition. Falls back only where there is no session
 *  at all to read (the un-enforced pilot), never to a name a caller supplied. */
function actorOf(auth: AuthedUser | null): string {
  return auth?.id ?? "unattributed";
}

/** The recipient reference, derived from the OPPORTUNITY. Never from the request. */
function patientToRef(opportunity: TreatmentOpportunity): string {
  return `patient:${opportunity.dentallyPatientId}`;
}

/**
 * Consent for the channel this touch was drafted on.
 *
 * Re-checked at approval even though the sweep checked it before drafting: consent
 * can be withdrawn in Dentally between the draft being written and a human getting
 * to it, and the draft may have sat for days. WhatsApp rides the SMS flag, matching
 * the sweep and the coordinator's own route.
 */
function channelConsented(opportunity: TreatmentOpportunity, channel: TouchChannel): boolean {
  return channel === "email" ? opportunity.consent.email : opportunity.consent.sms;
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

async function handleApprove(
  auth: AuthedUser | null,
  touch: CloserTouch,
  opportunity: TreatmentOpportunity,
  body: unknown,
): Promise<Response> {
  const parsed = parseApproveRequest(body);
  if (!parsed.ok) return badRequest(parsed.error);

  if (!channelConsented(opportunity, touch.channel)) {
    return Response.json(
      {
        ok: false,
        consentBlocked: true,
        error: "This patient has not consented to be contacted on that channel.",
      },
      { status: 409 },
    );
  }

  // THE EDIT IS RE-SCANNED BEFORE IT IS STORED, AND BEFORE THE TRANSITION.
  //
  // The AI draft was scanned when it was written; a human's rewrite has been
  // scanned by nobody. Approving first and scanning later would leave a queued
  // outbox row carrying unscanned text, and while the drain's own backstop would
  // catch the funding and clinical rules, it would catch them SILENTLY, hours
  // later, as a blocked send nobody is looking at — and it does not know this
  // module's rules at all (no debt wording, no harm-from-delay, no figure that is
  // not the plan's own). So the scan runs here, the draft stays a draft when it
  // fails, and the person who typed the words is told which words to change.
  //
  // The channel comes from the STORED touch and the figure from the STORED
  // opportunity, through the same `remainingValueOf` the drafter's own projection
  // uses, so the human's edit is held to the identical standard as the model's.
  if (parsed.value.body !== null) {
    const scan = checkCloserDraft(
      parsed.value.body,
      { remainingValue: remainingValueOf(opportunity.amountOutstanding) },
      touch.channel,
    );
    if (!scan.ok) {
      return Response.json(
        {
          ok: false,
          refused: true,
          category: scan.category,
          matched: scan.matched,
          error: refusalMessage(scan.category),
        },
        { status: 422 },
      );
    }
  }

  const result = await approveDraft(touch.id, actorOf(auth), {
    body: parsed.value.body ?? undefined,
    toRef: patientToRef(opportunity),
  });
  // Null means no row transitioned: somebody already approved or discarded this
  // draft. Idempotent no-op — emphatically NOT a second outbox row.
  if (!result) return Response.json({ ok: true, alreadyActioned: true });

  return Response.json({ ok: true, touch: result.touch, queued: true });
}

// ---------------------------------------------------------------------------
// discard
// ---------------------------------------------------------------------------

async function handleDiscard(
  auth: AuthedUser | null,
  touch: CloserTouch,
  body: unknown,
): Promise<Response> {
  const parsed = parseDiscardRequest(body);
  if (!parsed.ok) return badRequest(parsed.error);

  // The reason is an INPUT to the closer's decider, not a note. `discardOutcome`
  // is pure and is the single place that maps a human's words onto a cool-off or a
  // terminal stop; this route does not interpret the reason itself.
  const outcome = discardOutcome(parsed.value.reason, { cooldownHours: closerConfig().cooldownHours });
  const discarded = await discardDraft(touch.id, actorOf(auth), parsed.value.reason, outcome);
  if (!discarded) return Response.json({ ok: true, alreadyActioned: true });

  return Response.json({ ok: true, outcome: outcome.kind, reason: parsed.value.reason });
}

// ---------------------------------------------------------------------------
// Route.
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  if (action !== "approve" && action !== "discard") {
    return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  // 1. A session. 2. May this role be in the Treatment Coordinator at all.
  //
  // THE MODULE GATE NAMES THE COORDINATOR, NOT THE CLOSER, AND THAT IS DELIBERATE.
  // This surface is a tab of the Treatment Coordinator page: the same worklist, the
  // same people, the same patients. "treatment-coordinator" is a real CLIENT_NAV
  // slug that client_clinician and client_staff are both denied, so the gate is a
  // live lock. "treatment-closer" is a SYSTEM slug with no nav entry, and
  // canRoleAccessModule returns TRUE for a slug it does not recognise — a guard
  // naming it would compile, read as a lock, and refuse nobody.
  //
  // The slug is written as a literal rather than through a constant on purpose:
  // client-api-module-guard-coverage.test.ts matches the call by regex, and a guard
  // it cannot see is present in the code and absent from the proof.
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const moduleDenied = requireModuleApiAccess(auth, "treatment-coordinator");
  if (moduleDenied) return moduleDenied;

  // 3. Resolve the touch, then the opportunity. Both BEFORE any tenancy check,
  //    because the site to check against comes from the stored row.
  const touchId = typeof body.touchId === "string" ? body.touchId : "";
  if (touchId === "") return badRequest("touchId is required");
  const touch = await getTouch(touchId);
  if (!touch) return notFound();

  // 4. Tenancy: this touch's site must be one the caller holds.
  const siteDenied = requireSiteAccess(auth, touch.siteId);
  if (siteDenied) return siteDenied;

  const opportunity = await getOpportunity(touch.opportunityId);
  if (!opportunity) return notFound();

  // A touch that is not a draft has already been acted on. Answering 200 rather
  // than an error is deliberate: two people working the same list is normal, and
  // the second one should be told the work is done, not shown a failure.
  if (touch.status !== "draft" || touch.direction !== "outbound") {
    return Response.json({ ok: true, alreadyActioned: true });
  }

  if (action === "discard") {
    // NO KILL-SWITCH CHECK AND NO CAPABILITY ON DISCARD, both on purpose.
    //
    // Discarding is the direction that STOPS a message. Gating it on the closer
    // being switched on would strand every outstanding draft the moment an owner
    // switched the system off — the one time clearing them down matters most. And
    // requiring the send capability to refuse a send would mean the person trusted
    // to prepare the work but not to release it also cannot reject it, which is
    // backwards: they are the person most likely to spot that it should not go.
    return handleDiscard(auth, touch, body);
  }

  // 5. THE OWNER'S KILL SWITCH, on the release only. 'treatment-closer' is
  //    default-OFF (catalog `defaultEnabled: false`), so this refuses until
  //    somebody has deliberately switched the system on — an absent toggle row and
  //    an unreadable toggle table both resolve to disabled for this slug.
  const clientId = getSite(touch.siteId)?.clientId;
  if (clientId && !(await isSystemEnabled(clientId, "treatment-closer"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }

  // 6. THE PER-PERSON GATE, and it is on APPROVE because approve is the release.
  //
  //    The Treatment Coordinator gates `send`, but its `send` no longer sends —
  //    approving is what writes the outbox row the drain picks up. The closer has
  //    no `send` action at all, so putting the capability anywhere else would be
  //    putting it on nothing. Same key as recall / reactivation / coordinator:
  //    releasing a drafted lifecycle message is one permission, not four.
  const capabilityDenied = await requireCapability(auth, "messaging.lifecycle.send");
  if (capabilityDenied) return capabilityDenied;

  return handleApprove(auth, touch, opportunity, body);
}
