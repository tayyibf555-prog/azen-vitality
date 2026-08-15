import { getClient } from "@/lib/mock/clients";
import {
  authEnforced,
  requireUser,
  requireClientAccess,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { consumeBudget } from "@/lib/rate-budget";
import { isSystemEnabled } from "@/lib/systems/repository";
import { findStaffByAppUser } from "@/lib/clock/repository";
import {
  ESIGN_COPY,
  hashIp,
  policyWithdrawn,
  trimUserAgent,
  validateSignatureInput,
} from "@/lib/hr/esign";
import { getPolicy, recordSignature } from "@/lib/hr/policy-repository";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// ===========================================================================
// SIGN A POLICY VERSION. This is the route that produces the evidence, so every
// decision in it is about making that evidence true.
//
// 1. THE SIGNER COMES FROM THE SESSION. `findStaffByAppUser(clientId, auth.id)`
//    resolves which staff record is signing. There is NO staffId parameter and there
//    must never be one: a route that accepted a body-supplied signer would let
//    anybody sign anything in somebody else's name, and the whole feature would be
//    producing false records rather than no records.
//
// 2. THE VERSION COMES FROM THE POLICY ROW. Not from the body either. The client
//    says WHICH policy; the server reads what version that policy actually is and
//    binds the signature to it. Otherwise a browser could claim it had signed v5
//    while being shown v2.
//
// 3. THE TIME COMES FROM THE SERVER CLOCK. A time the signer supplies is a time the
//    signer chose, and "at a recorded time" is half the evidential claim.
//
// 4. IT FAILS CLOSED WHEN SIGN-IN IS NOT CONFIGURED. `authEnforced()` is false on an
//    environment with no service-role key, and every other guard in this codebase
//    no-ops in that state. Here that would mean recording an attestation with NO
//    IDENTITY BEHIND IT, which is worse than recording nothing: it would look like
//    evidence and be none. So this route refuses with a 503 that says exactly why,
//    following move-service.ts and the destructive-capability posture.
//
// 5. THE KILL SWITCH. Migration 0077 seeds `staff-esign` DISABLED (the FP17
//    precedent): the legal framing must be agreed by the practice before anybody is
//    asked to sign anything. Switching it on is a business decision, not a build
//    step.
//
// ---------------------------------------------------------------------------
// WHY THIS ROUTE HAS NO MODULE GATE, AND WHY THAT IS THE LOCK RATHER THAN A HOLE.
// ---------------------------------------------------------------------------
// Signing is SELF-SERVICE: a nurse and a dentist affirm their own policies from My
// work. A module gate on "staff-hr" — which this route carried while the lane was
// being built — refuses exactly the two roles the feature exists for. (Described
// rather than written as a call: the coverage sweep reads this file as text and
// would count an example in a comment as a real guard, which is the worst possible
// outcome for a route whose whole point is that it does not have one.)
// And it cannot simply be repointed at "my-work" either: `my-work` is in
// CLINICIAN_SLUGS and STAFF_SLUGS both, so a gate naming it "compiles, reads as a
// lock, and does nothing", which the API coverage sweep refuses by design.
//
// So the module gate is GONE and this route is a `kind: "self-service"` entry in
// that sweep's EXEMPT map (added by the integrator, per campaign decision 13). The
// exemption is not taken on trust: its structural assertion is that this file
// resolves the signer from the SESSION (`findStaffByAppUser`, below) and reads no
// staff id from the body or the query. `requireClientAccess` still proves tenancy,
// `authEnforced()` still fails this closed without a real login, and somebody with
// no linked staff record gets a 409 that says so rather than a signature.
// ===========================================================================

const ESIGN_SYSTEM_SLUG = "staff-esign";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    if (!(await consumeBudget("hr-policy-sign", 300, 60))) {
      return Response.json({ ok: false, error: "please try again shortly" }, { status: 429 });
    }

    const result = await requireUser();
    if (result instanceof Response) return result;
    const auth: AuthedUser | null = result;

    let body: { clientSlug?: unknown; method?: unknown; value?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return bad("Expected a JSON body");
    }

    const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug.trim() : "";
    const client = getClient(clientSlug);
    if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

    const denied = requireClientAccess(auth, client.id);
    if (denied) return denied;
    // NO MODULE GATE — see the header. This is a self-service route and the lock is
    // that the signer comes from the session and nowhere else.

    // FAIL CLOSED without a real session. See (4) in the header.
    if (!authEnforced() || !auth) {
      return Response.json(
        {
          ok: false,
          error:
            "Signing is unavailable because sign in is not configured on this environment. A signature has to be tied to a login to mean anything.",
        },
        { status: 503 },
      );
    }

    if (!(await isSystemEnabled(client.id, ESIGN_SYSTEM_SLUG))) {
      return Response.json({ ok: false, error: ESIGN_COPY.switchedOff }, { status: 503 });
    }

    // (1) THE SIGNER, FROM THE SESSION. No staffId is read from anywhere.
    const staff = await findStaffByAppUser(client.id, auth.id);
    if (!staff) {
      // The copy the clocking route already models for this exact state: it is not an
      // error, it is a link that has not been made.
      return Response.json({ ok: false, error: ESIGN_COPY.noStaffRecord }, { status: 409 });
    }

    const { id: policyId } = await context.params;
    if (!policyId) return bad("Which policy?");

    // (2) THE VERSION, FROM THE POLICY ROW.
    const policy = await getPolicy(client.id, policyId);
    if (!policy) return Response.json({ ok: false, error: "not found" }, { status: 404 });

    // (3) THE TIME, FROM THE SERVER CLOCK.
    const nowIso = new Date().toISOString();

    // `retiredAt` may be a FUTURE instant: publishing a version effective next
    // month retires its predecessor next month. `policyWithdrawn` is the same
    // rule `currentPolicies` uses to decide what to OFFER, so this route can
    // never refuse a signature on the only version the screen shows.
    if (policyWithdrawn(policy, londonDayKey(new Date(nowIso)))) {
      return bad("That version of the policy has been withdrawn. Please reload and sign the current one.");
    }

    const signature = validateSignatureInput({ method: body.method, value: body.value }, nowIso);
    if (!signature.ok) return bad(signature.error);

    const stored = await recordSignature({
      clientId: client.id,
      staffId: staff.id,
      policyId: policy.id,
      policyVersion: policy.version,
      signature: signature.value,
      signedAt: nowIso,
      // Weak corroboration, hashed and bounded, and labelled as weak everywhere it
      // is shown. Never the raw address.
      ipHash: hashIp(clientIp(request), client.id),
      userAgent: trimUserAgent(request.headers.get("user-agent")),
    });

    // The response carries the METHOD and the TIME, never the signature value back.
    return Response.json({
      ok: true,
      signedAt: stored.signedAt,
      policyId: stored.policyId,
      policyVersion: stored.policyVersion,
      method: stored.signature.method,
    });
  } catch {
    // A write that failed must never read as a signature that happened.
    return bad("That signature could not be recorded. Please try again.", 500);
  }
}
