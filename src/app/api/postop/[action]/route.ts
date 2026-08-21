import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import { isSuppressed } from "@/lib/messaging/suppression";
import { approveDraft, discardDraft, getTouch, getTarget, stopTarget } from "@/lib/postop/repository";
import { checkPostopMessage } from "@/lib/postop/copy";
import { decideSend, notBeforeFor } from "@/lib/postop/schedule";
import { postopConfig } from "@/lib/postop/types";
import type { AuthedUser } from "@/lib/auth/session";

// ===========================================================================
// THE POST-OP CHECK-IN'S APPROVAL SURFACE.
//
// Two actions, and between them they are the ONLY route out of `draft`:
//
//   approve  the drafted check-in becomes a queued outbox row the shared drain
//            will deliver, no earlier than the quiet-hours instant on the row;
//   discard  the draft dies and the target is stopped for good.
//
// NOTHING HERE SENDS. `approveDraft` writes a postop_outbox row and stops; the
// shared drain owns suppression, the frequency cap, the atomic claim, the dry-run
// flag and the provider call, exactly as it does for every other module. There is
// no new send machinery in this file and there must never be.
//
// WHAT THE CALLER MAY NAME. A request carries a touch id and nothing else. There is
// no body field, no channel field, no recipient field: the site, the target, the
// channel and the phone number are all read from the stored rows, server-side.
//
// AND THERE IS NO EDIT. The closer lets a receptionist reword a draft before
// releasing it; this route deliberately does not, and the repository has no
// parameter for it. The approval decides WHETHER this patient is checked on, never
// WHAT is said to them — which is what stops a well-meaning human typing "rinse
// with salt water and it should settle" into a message the practice then sends
// automatically in a dentist's name.
// ===========================================================================

export const dynamic = "force-dynamic";

const CLIENT_ID_FALLBACK = "vitality";

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

function notFound(): Response {
  return Response.json({ ok: false, error: "That check-in no longer exists." }, { status: 404 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Who to record against the transition. Falls back only where there is no session
 *  at all to read (the un-enforced pilot), never to a name a caller supplied. */
function actorOf(auth: AuthedUser | null): string {
  return auth?.id ?? "unattributed";
}

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

  // 1. A session. 2. May this role work a clinical worklist at all.
  //
  // THE MODULE GATE NAMES "task-queue", AND THAT IS DELIBERATE. Post-op escalations
  // surface in the task queue, and the release list is the same desk work by the
  // same people. "task-queue" is a real CLIENT_NAV slug that client_clinician and
  // client_staff are both denied (it is in neither CLINICIAN_SLUGS nor
  // STAFF_SLUGS), so the gate is a live lock. "postop-checkin" is a SYSTEM slug
  // with no nav entry, and canRoleAccessModule returns TRUE for a slug it does not
  // recognise — a guard naming it would compile, read as a lock, and refuse nobody.
  //
  // The slug is written as a literal rather than through a constant on purpose:
  // client-api-module-guard-coverage.test.ts matches the call by regex, and a guard
  // it cannot see is present in the code and absent from the proof.
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const moduleDenied = requireModuleApiAccess(auth, "task-queue");
  if (moduleDenied) return moduleDenied;

  // 3. Resolve the touch, then the target. Both BEFORE any tenancy check, because
  //    the site to check against comes from the stored row.
  const touchId = typeof body.touchId === "string" ? body.touchId : "";
  if (touchId === "") return badRequest("touchId is required");
  const touch = await getTouch(touchId);
  if (!touch) return notFound();

  // 4. Tenancy: this touch's site must be one the caller holds.
  const siteDenied = requireSiteAccess(auth, touch.siteId);
  if (siteDenied) return siteDenied;

  const target = await getTarget(touch.targetId);
  if (!target) return notFound();

  // A touch that is not a draft has already been acted on. Answering 200 rather than
  // an error is deliberate: two people working the same list is normal, and the
  // second one should be told the work is done, not shown a failure.
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
    // which is backwards: they are the person most likely to spot that a particular
    // patient should not be texted.
    const discarded = await discardDraft(touch.id, actorOf(auth));
    if (!discarded) return Response.json({ ok: true, alreadyActioned: true });
    return Response.json({ ok: true, discarded: true });
  }

  // 5. THE OWNER'S KILL SWITCH, on the release only. 'postop-checkin' is default-OFF
  //    (catalog `defaultEnabled: false`), so this refuses until somebody has
  //    deliberately switched the system on — an absent toggle row and an unreadable
  //    toggle table both resolve to disabled for this slug.
  const clientId = getSite(touch.siteId)?.clientId ?? CLIENT_ID_FALLBACK;
  if (!(await isSystemEnabled(clientId, "postop-checkin"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }

  // 6. THE PER-PERSON GATE. Same key as recall / reactivation / coordinator / the
  //    closer: releasing a drafted lifecycle message to a patient is one permission,
  //    not five.
  const capabilityDenied = await requireCapability(auth, "messaging.lifecycle.send");
  if (capabilityDenied) return capabilityDenied;

  const config = postopConfig();

  // 7. STALENESS, RE-CHECKED AT THE MOMENT OF RELEASE. The sweep checked it when it
  //    drafted, but a draft can sit on a list overnight, and "just checking in after
  //    your extraction" is a different message three days later. A stale draft is
  //    not sent and its target is retired, rather than the human being allowed to
  //    release something the sweep would now refuse to write.
  const decision = decideSend(target, new Date(), config);
  if (decision.action === "drop") {
    await stopTarget(target.id, "stale");
    return Response.json(
      { ok: false, error: "This check-in is too old to send now. It has been closed." },
      { status: 409 },
    );
  }

  // 8. CONSENT AND OPT-OUT, RE-CHECKED for the same reason: both can change between
  //    the draft being written and a human getting to it. The drain re-checks
  //    suppression too, so this is the earlier of two independent refusals rather
  //    than the only one.
  const toRef = `patient:${target.dentallyPatientId}`;
  if (!target.consentSms) {
    return Response.json(
      { ok: false, error: "This patient has not agreed to be contacted by text." },
      { status: 422 },
    );
  }
  let suppressed = true;
  try {
    suppressed = await isSuppressed(target.siteId, "sms", toRef);
  } catch {
    // A suppression read that throws must never be read as "not opted out".
    return Response.json(
      { ok: false, error: "Could not check this patient's opt-out just now. Try again shortly." },
      { status: 503 },
    );
  }
  if (suppressed) {
    return Response.json(
      { ok: false, error: "This patient has opted out of messages." },
      { status: 422 },
    );
  }

  // 9. THE COMPLIANCE SCAN, on the STORED body rather than on the composer's output.
  //    The body cannot have been edited (there is no edit path), so this is a
  //    tripwire and not a filter: it catches a template edited into a violation and
  //    a row tampered with in the database, and it costs one pure function call.
  const scan = checkPostopMessage(touch.body);
  if (!scan.ok) {
    console.error(
      `[postop] refused to release touch ${touch.id} (${scan.category}: ${scan.matched})`,
    );
    return Response.json(
      { ok: false, error: "This message does not pass the practice's messaging rules." },
      { status: 422 },
    );
  }

  const result = await approveDraft(touch.id, actorOf(auth), {
    toRef,
    // QUIET HOURS. The shared drain has no time-of-day gate, so the window lives on
    // the row: approving at 22:30 queues something the drain cannot pick up until
    // 08:00, and a recovering patient is not woken by it.
    notBeforeAt: notBeforeFor(new Date()),
  });
  // Null means no row transitioned: somebody already approved or discarded this
  // draft. Idempotent no-op — emphatically NOT a second outbox row.
  if (!result) return Response.json({ ok: true, alreadyActioned: true });

  return Response.json({ ok: true, queued: true, notBeforeAt: result.outbox.createdAt });
}
