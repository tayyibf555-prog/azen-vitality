import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import { getPatientById } from "@/lib/dentally/read";
import { readPatientInvoices } from "@/lib/collection/read";
import { summariseBalance, verifyBalance } from "@/lib/collection/balance";
import { checkCollectionDraft, quotableAmount } from "@/lib/collection/draft";
import {
  parseApproveRequest,
  parseDiscardRequest,
  collectionRefusalMessage,
} from "@/lib/collection/approval";
import { collectionDiscardOutcome } from "@/lib/collection/discard";
import {
  approveDraft,
  discardDraft,
  discardSettledDraft,
  getTouch,
} from "@/lib/collection/repository";
import { collectionConfig } from "@/lib/collection/types";
import type { CollectionTouch, TouchChannel } from "@/lib/collection/types";
import type { PatientRecord } from "@/lib/dentally/read";
import type { AuthedUser } from "@/lib/auth/session";

// ===========================================================================
// THE COLLECTION AGENT'S APPROVAL SURFACE.
//
// Two actions, and between them they are the ONLY route out of `draft`:
//
//   approve  the draft, optionally with a human's edit, becomes a queued outbox
//            row the shared messaging drain will deliver;
//   discard  the draft dies, and the reason the human gave decides whether the
//            patient cools off, stops for good, or stops AND raises a work item.
//
// NOTHING HERE SENDS. `approveDraft` writes a collection_outbox row and stops; the
// shared drain owns suppression, the frequency cap, the atomic claim, the dry-run
// flag and the provider call, exactly as it does for every other module. There is
// no new send machinery in this file and there must never be.
//
// WHAT THE CALLER MAY NAME, AND WHAT IT MAY NOT.
//
// A request carries a touch id, and for a discard a reason. That is all. The site,
// the patient, the channel, the recipient and THE AMOUNT are read from the stored
// touch, server-side. A caller cannot point an approved message at a different
// number, move it onto a channel the patient has not consented to, approve a touch
// belonging to another practice, or change what the message says somebody owes:
// the parser has no field for any of it (src/lib/collection/approval.ts), which is
// a stronger guarantee than this file remembering not to read one.
//
// APPROVE RE-VERIFIES THE MONEY, LIVE, BEFORE IT RELEASES ANYTHING.
//
// This is the guard that matters most in the whole module. A draft can sit with a
// human for days, and in those days the patient can walk into reception and pay.
// Releasing the message anyway would be the platform telling somebody they owe
// money they have already handed over, which is precisely the failure this agent
// was built not to commit. So approve re-reads that patient's invoices and:
//   - nothing owed now  -> the draft is discarded, the conversation is reset, and
//                          the panel is told it was SETTLED rather than sent;
//   - figure has moved  -> refused, because the message quotes a figure that is no
//                          longer true;
//   - cannot be read    -> refused. A read that failed is not a balance.
// Two live reads on a button press is a real cost. It is a rounding error next to
// the cost of one wrong message about somebody's money.
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
 *  at all to read, never to a name a caller supplied. */
function actorOf(auth: AuthedUser | null): string {
  return auth?.id ?? "unattributed";
}

/**
 * Consent for the channel this touch was drafted on, read LIVE.
 *
 * Re-checked at approval even though the sweep checked it before drafting: consent
 * can be withdrawn in Dentally between the draft being written and a human getting
 * to it, and the draft may have sat for days. WhatsApp rides the SMS flag, matching
 * the sweep and every other module here.
 */
function channelConsented(patient: PatientRecord, channel: TouchChannel): boolean {
  return channel === "email" ? patient.emailConsent : patient.smsConsent;
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

async function handleApprove(
  auth: AuthedUser | null,
  touch: CollectionTouch,
  body: unknown,
): Promise<Response> {
  const parsed = parseApproveRequest(body);
  if (!parsed.ok) return badRequest(parsed.error);

  const config = collectionConfig();

  // 1. The patient, live. Consent, and whether the record is still active at all.
  const patient = await getPatientById(touch.patientId);
  if (!patient) {
    // getPatientById answers null for every failure, so this covers both "the
    // record is gone" and "Dentally did not answer". Neither is a state in which
    // this platform may release a message about somebody's money.
    return Response.json(
      {
        ok: false,
        error: "We could not check this patient's record just now, so nothing has been sent. Try again shortly.",
      },
      { status: 409 },
    );
  }
  if (!patient.active) {
    return Response.json(
      { ok: false, error: "This patient's record is no longer active." },
      { status: 409 },
    );
  }
  if (!channelConsented(patient, touch.channel)) {
    return Response.json(
      {
        ok: false,
        consentBlocked: true,
        error: "This patient has not consented to be contacted on that channel.",
      },
      { status: 409 },
    );
  }

  // 2. The money, live. See the header: this is the guard that matters most.
  let summary;
  try {
    const invoices = await readPatientInvoices(touch.patientId);
    summary = invoices.truncated
      ? { ...summariseBalance(invoices.rows), unreadableCount: 1 }
      : summariseBalance(invoices.rows);
  } catch {
    return Response.json(
      {
        ok: false,
        error: "We could not check this balance just now, so nothing has been sent. Try again shortly.",
      },
      { status: 409 },
    );
  }

  const verdict = verifyBalance({
    summary,
    // No second read exists at approval time, and saying so is more honest than
    // feeding the summary its own total back as a "check". See VerifyBalanceInput.
    snapshotPence: null,
    now: new Date(),
    config,
  });

  if (!verdict.ok) {
    if (verdict.refusal === "no_provable_debt") {
      // The best outcome this module has. The draft dies, the conversation resets,
      // and the person is told the account settled rather than being shown an error
      // they would have to interpret.
      await discardSettledDraft(
        touch.id,
        new Date(Date.now() + config.cooldownHours * 3_600_000),
      );
      return Response.json({
        ok: true,
        settled: true,
        error: "This balance has been settled, so the reminder was not sent.",
      });
    }
    return Response.json(
      {
        ok: false,
        balanceRefused: true,
        refusal: verdict.refusal,
        error:
          "The balance on this account is not what it was when the message was written, so nothing has been sent. Discard this draft and a fresh one will be prepared.",
      },
      { status: 409 },
    );
  }

  // 3. The figure must still be the one the message quotes. Only applicable when
  //    it quotes one at all: a message that carries no figure says "there is an
  //    unpaid invoice on your account", which a part-payment does not falsify.
  if (touch.amountPence !== null && verdict.balance.pence !== touch.amountPence) {
    return Response.json(
      {
        ok: false,
        balanceRefused: true,
        refusal: "amount_moved",
        error:
          "The amount owed has changed since this message was written, so nothing has been sent. Discard this draft and a fresh one will be prepared.",
      },
      { status: 409 },
    );
  }

  // 4. THE EDIT IS RE-SCANNED BEFORE IT IS STORED, AND BEFORE THE TRANSITION.
  //
  //    The AI draft was scanned when it was written; a human's rewrite has been
  //    scanned by nobody. Approving first and scanning later would leave a queued
  //    outbox row carrying unscanned text, and while the drain's own backstop would
  //    catch the funding and clinical rules, it would catch them SILENTLY, hours
  //    later, as a blocked send nobody is looking at — and it does not know this
  //    module's rules at all: no threats, no conditioning care on payment, no
  //    invented fee, no blame, no deadline, no named treatment, no request for card
  //    details, and the required invitation to query the amount.
  //
  //    The channel comes from the STORED touch and the figure from the STORED
  //    amount_pence, through the same `quotableAmount` the drafter's own projection
  //    uses, so a human's edit is held to exactly the standard the model's was.
  if (parsed.value.body !== null) {
    const scan = checkCollectionDraft(
      parsed.value.body,
      { amountPounds: quotableAmount(touch.amountPence) },
      touch.channel,
    );
    if (!scan.ok) {
      return Response.json(
        {
          ok: false,
          refused: true,
          category: scan.category,
          matched: scan.matched,
          error: collectionRefusalMessage(scan.category),
        },
        { status: 422 },
      );
    }
  }

  const result = await approveDraft(touch.id, actorOf(auth), {
    body: parsed.value.body ?? undefined,
    // Derived from the STORED touch, never from the request.
    toRef: `patient:${touch.patientId}`,
  });
  // Null means no row transitioned: somebody already approved or discarded this
  // draft. Idempotent no-op, and emphatically NOT a second outbox row.
  if (!result) return Response.json({ ok: true, alreadyActioned: true });

  return Response.json({ ok: true, touch: result.touch, queued: true });
}

// ---------------------------------------------------------------------------
// discard
// ---------------------------------------------------------------------------

async function handleDiscard(
  auth: AuthedUser | null,
  touch: CollectionTouch,
  body: unknown,
): Promise<Response> {
  const parsed = parseDiscardRequest(body);
  if (!parsed.ok) return badRequest(parsed.error);

  // The reason is an INPUT to the decider, not a note. `collectionDiscardOutcome`
  // is pure and is the single place that maps a human's words onto a cool-off, a
  // terminal stop, or a terminal stop that also raises a work item; this route does
  // not interpret the reason itself.
  const outcome = collectionDiscardOutcome(parsed.value.reason, {
    cooldownHours: collectionConfig().cooldownHours,
  });
  const discarded = await discardDraft(touch.id, actorOf(auth), parsed.value.reason, outcome);
  if (!discarded) return Response.json({ ok: true, alreadyActioned: true });

  return Response.json({
    ok: true,
    outcome: outcome.kind,
    reason: parsed.value.reason,
    escalated: outcome.kind === "stop" && outcome.escalate !== null,
  });
}

// ---------------------------------------------------------------------------
// Route.
// ---------------------------------------------------------------------------

async function handle(request: Request, action: string): Promise<Response> {
  if (action !== "approve" && action !== "discard") {
    return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  // 1. A session. 2. May this role be near the practice's money at all.
  //
  // THE MODULE GATE NAMES "payments", AND THAT IS DELIBERATE. This surface is the
  // debtors book with a message attached: the same list, the same patients, the
  // same figures. "payments" is a real CLIENT_NAV slug that client_clinician and
  // client_staff are both denied, so the gate is a live lock. "balance-reminders"
  // is a SYSTEM slug with no nav entry, and canRoleAccessModule returns TRUE for a
  // slug it does not recognise — a guard naming it would compile, read as a lock,
  // and refuse nobody.
  //
  // The slug is written as a literal rather than through a constant on purpose:
  // client-api-module-guard-coverage.test.ts matches the call by regex, and a guard
  // it cannot see is present in the code and absent from the proof.
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const moduleDenied = requireModuleApiAccess(auth, "payments");
  if (moduleDenied) return moduleDenied;

  // 2. Resolve the touch BEFORE any tenancy check, because the site to check
  //    against comes from the stored row.
  const touchId = typeof body.touchId === "string" ? body.touchId : "";
  if (touchId === "") return badRequest("touchId is required");
  const touch = await getTouch(touchId);
  if (!touch) return notFound();

  // 3. Tenancy: this touch's site must be one the caller holds.
  const siteDenied = requireSiteAccess(auth, touch.siteId);
  if (siteDenied) return siteDenied;

  // A touch that is not a draft has already been acted on. Answering 200 rather
  // than an error is deliberate: two people working the same list is normal, and
  // the second one should be told the work is done, not shown a failure.
  if (touch.status !== "draft" || touch.direction !== "outbound") {
    return Response.json({ ok: true, alreadyActioned: true });
  }

  if (action === "discard") {
    // NO KILL-SWITCH CHECK AND NO CAPABILITY ON DISCARD, both on purpose.
    //
    // Discarding is the direction that STOPS a message. Gating it on the system
    // being switched on would strand every outstanding draft the moment an owner
    // switched it off, which is the one time clearing them down matters most. And
    // requiring the send capability in order to REFUSE a send would mean the person
    // trusted to prepare the work but not to release it also cannot reject it,
    // which is backwards: they are the person most likely to spot that it should
    // not go.
    return handleDiscard(auth, touch, body);
  }

  // 4. THE OWNER'S KILL SWITCH, on the release only. 'balance-reminders' is
  //    default-OFF (catalog `defaultEnabled: false`), so this refuses until
  //    somebody has deliberately switched it on: an absent toggle row and an
  //    unreadable toggle table both resolve to disabled for this slug.
  const clientId = getSite(touch.siteId)?.clientId;
  if (clientId && !(await isSystemEnabled(clientId, "balance-reminders"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }

  // 5. THE PER-PERSON GATE, and it is on APPROVE because approve is the release.
  //    Same key as recall / reactivation / coordinator / closer: releasing a
  //    drafted lifecycle message is one permission, not five.
  const capabilityDenied = await requireCapability(auth, "messaging.lifecycle.send");
  if (capabilityDenied) return capabilityDenied;

  return handleApprove(auth, touch, body);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  // A person is waiting on this click, so the two live reads it makes take the
  // INTERACTIVE share of the practice's Dentally quota rather than competing with
  // the sweeps at background priority.
  return runWithDentallyPriority("interactive", () => handle(request, action));
}
