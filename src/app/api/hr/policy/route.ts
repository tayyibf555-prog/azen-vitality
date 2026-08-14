import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireApproverRole,
  requireOwnerRole,
} from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { consumeBudget } from "@/lib/rate-budget";
import { isSystemEnabled } from "@/lib/systems/repository";
import { listStaff } from "@/lib/rota/repository";
import {
  ALLOWED_POLICY_MIME,
  CONTENT_LENGTH_CEILING,
  MAX_DOCUMENT_BYTES,
  extensionForMime,
  safePolicyPath,
} from "@/lib/hr/documents";
import {
  ESIGN_COPY,
  MAX_POLICY_TITLE,
  isValidPolicySlug,
  nextPolicyVersion,
  policySlugFromTitle,
  toSignatureSummary,
} from "@/lib/hr/esign";
import { newPathToken, putStaffDocObject, removeStaffDocObject } from "@/lib/hr/document-repository";
import {
  createPolicy,
  listPolicies,
  listSignatures,
  listSignaturesForStaff,
  retireEarlierVersions,
} from "@/lib/hr/policy-repository";
import { resolveSelfStaff, selfServiceRequested } from "@/lib/self-service/read";

export const dynamic = "force-dynamic";

// ===========================================================================
// The practice policy library: read it, and publish a new version of a policy.
//
// A POLICY IS AN UPLOADED PDF, NOT A GENERATED ONE. There is no PDF library in this
// codebase (no pdf-lib, jspdf, puppeteer) and adding one is out of scope, so the
// practice uploads the document it already has and this route versions it. The
// upload half is the same hardened template as the document vault: PDF only here,
// 10MB cap, Content-Length pre-guard, shared budget, forced extension, unguessable
// path under the private staff-docs bucket.
//
// PUBLISHING IS OWNER-ONLY. It is the act that puts a document in front of every
// member of staff and asks them to affirm it, so it carries BOTH `requireOwnerRole`
// and the capability `esign.manage-policies` (owner + agency), which is now in the
// catalog. Reading the library is approver-level, so the practice manager can see
// who still has to sign.
//
// A NEW VERSION IS A NEW ROW. Nothing here edits a published version: a signature
// binds to a version, and rewriting the wording underneath a signature would
// fabricate evidence. Earlier versions are RETIRED, never deleted.
//
// KILL SWITCH. The e-sign feature ships dormant (migration 0077 seeds
// system_toggle 'staff-esign' disabled, the FP17 precedent) because the legal
// framing has to be agreed by the practice before anybody is asked to sign
// anything. Publishing is refused while it is off, and the GET reports the state so
// the screen can say so plainly instead of looking broken.
// ===========================================================================

const ESIGN_SYSTEM_SLUG = "staff-esign";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

type Access = { auth: AuthedUser | null; client: { id: string; slug: string } };

/**
 * SESSION AND TENANCY ONLY — the front half both callers share.
 *
 * Split out for the same reason as the document vault's: the self-service read
 * below must NOT run the manager gates, because "staff-hr" and the approver role
 * each refuse exactly the two roles that are asked to sign policies.
 */
async function identify(clientSlug: string): Promise<Response | Access> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  return { auth, client: { id: client.id, slug: client.slug } };
}

async function authorise(clientSlug: string): Promise<Response | Access> {
  const identified = await identify(clientSlug);
  if (identified instanceof Response) return identified;
  const { auth } = identified;
  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  return identified;
}

// ---------------------------------------------------------------------------
// GET /api/hr/policy?client=<slug>          — the library, plus who has signed what.
// GET /api/hr/policy?client=<slug>&mine=1   — the library, plus MY OWN signatures.
//
// THE SELF-SERVICE BRANCH IS WHAT MAKES THE SIGN ROUTE REACHABLE. A member of
// staff could always POST /api/hr/policy/[id]/sign — it is deliberately
// self-service — but could never LIST the policy in order to get to it, because
// this read was module-gated on "staff-hr". `mine=1` answers with the same
// policies (they are the practice's, not anybody's private record) and with
// EXACTLY the caller's own signature summaries: `listSignaturesForStaff` on the
// session's staff id, never `listSignatures` filtered afterwards.
//
// The staff list is NOT returned on this branch. Who else still owes a signature
// is the manager's compliance view; a nurse needs her own row and nobody else's.
// ---------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (selfServiceRequested(url)) {
    const identified = await identify(url.searchParams.get("client") ?? "");
    if (identified instanceof Response) return identified;
    return readOwnPolicies(identified);
  }

  const access = await authorise(url.searchParams.get("client") ?? "");
  if (access instanceof Response) return access;

  try {
    const enabled = await isSystemEnabled(access.client.id, ESIGN_SYSTEM_SLUG);
    // WHETHER THE PUBLISH CONTROL IS OFFERED IS DECIDED HERE, ON THE SERVER, by the
    // same guard the POST enforces. A screen that draws a button the server will
    // refuse is worse than one that does not draw it, and a screen that decides for
    // itself who is an owner is a second authority that will drift from the first.
    const canPublish = requireOwnerRole(access.auth) === null;
    const [{ ready, policies }, sigResult, staff] = await Promise.all([
      listPolicies(access.client.id),
      listSignatures(access.client.id),
      listStaff(access.client.id, { activeOnly: true }),
    ]);
    if (!ready) {
      return Response.json({
        ok: true,
        ready: false,
        enabled,
        canPublish,
        policies: [],
        signatures: [],
        staff: [],
        note: ESIGN_COPY.notReady,
      });
    }
    return Response.json({
      ok: true,
      ready: true,
      enabled,
      canPublish,
      policies,
      // SUMMARIES ONLY. The signature VALUE (a drawn image, or somebody's typed
      // name) is never re-served to a management list: the FP17 discipline, and the
      // reason `toSignatureSummary` exists.
      signatures: sigResult.signatures.map(toSignatureSummary),
      staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    });
  } catch {
    // LOUD FAILURE: an honest failure, never a confident empty library.
    return Response.json({ ok: false, error: "read-failed" }, { status: 500 });
  }
}

/** The `mine=1` answer: the practice's policies, and only the caller's signatures. */
async function readOwnPolicies(access: Access): Promise<Response> {
  const self = await resolveSelfStaff(
    access.client.id,
    access.auth,
    "there is nothing here to sign",
  );
  if (!self.ok) return self.response;

  try {
    const enabled = await isSystemEnabled(access.client.id, ESIGN_SYSTEM_SLUG);
    const [{ ready, policies }, sigResult] = await Promise.all([
      listPolicies(access.client.id),
      // NARROWED AT THE QUERY on the SESSION's staff id. Not `listSignatures`
      // filtered afterwards: the whole practice's signature table would have been
      // read into this process to answer a question about one person.
      listSignaturesForStaff(access.client.id, self.staff.id),
    ]);
    if (!ready) {
      return Response.json({
        ok: true,
        ready: false,
        enabled,
        // A member of staff never publishes, whatever their capabilities say.
        canPublish: false,
        mine: true,
        policies: [],
        signatures: [],
        note: ESIGN_COPY.notReady,
      });
    }
    return Response.json({
      ok: true,
      ready: true,
      enabled,
      canPublish: false,
      mine: true,
      policies,
      // SUMMARIES ONLY, exactly as the manager's view: the stored signature value
      // is never served back, not even to the person who gave it.
      signatures: sigResult.signatures.map(toSignatureSummary),
      // NO `staff` key. Who else still owes a signature is the manager's view.
    });
  } catch {
    return Response.json({ ok: false, error: "read-failed" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/hr/policy — publish a new version. Multipart: the PDF plus its title.
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  try {
    if (!(await consumeBudget("hr-policy-publish", 60, 60))) {
      return Response.json(
        { ok: false, error: "please try again shortly" },
        { status: 429 },
      );
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > CONTENT_LENGTH_CEILING) {
        return bad("That file is too large (max 10MB)", 413);
      }
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return bad("Expected a multipart form upload");
    }

    const clientSlug =
      typeof form.get("clientSlug") === "string" ? (form.get("clientSlug") as string).trim() : "";
    const access = await authorise(clientSlug);
    if (access instanceof Response) return access;
    const { auth, client } = access;

    // PUBLISHING IS OWNER-ONLY, on top of the approver-level read above, AND it
    // now carries `esign.manage-policies` from the capability catalog. The key is
    // DESTRUCTIVE — publishing puts a document in front of every member of staff
    // and the version can never be edited afterwards — so it also refuses outright
    // on an environment where sign-in is not configured.
    const ownerDenied = requireOwnerRole(auth);
    if (ownerDenied) return ownerDenied;
    const capDenied = await requireCapability(auth, "esign.manage-policies");
    if (capDenied) return capDenied;

    // The kill switch: refuse to publish while the feature is dormant, so nothing is
    // put in front of staff before the practice has agreed the wording.
    if (!(await isSystemEnabled(client.id, ESIGN_SYSTEM_SLUG))) {
      return Response.json({ ok: false, error: ESIGN_COPY.switchedOff }, { status: 503 });
    }

    const title =
      typeof form.get("title") === "string" ? (form.get("title") as string).trim() : "";
    if (title === "") return bad("Give the policy a title");
    if (title.length > MAX_POLICY_TITLE) return bad("That title is too long");

    // A slug may be supplied to publish a NEW VERSION of an existing policy; without
    // one it is derived from the title, which starts a new policy at version 1.
    const suppliedSlug =
      typeof form.get("slug") === "string" ? (form.get("slug") as string).trim() : "";
    const slug = suppliedSlug || policySlugFromTitle(title);
    if (!isValidPolicySlug(slug)) return bad("That policy name cannot be used");

    const effectiveFromRaw =
      typeof form.get("effectiveFrom") === "string"
        ? (form.get("effectiveFrom") as string).trim()
        : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFromRaw)) {
      return bad("Set the date this version takes effect");
    }

    const file = form.get("file");
    if (!(file instanceof File)) return bad("Attach the policy document");
    if (form.getAll("file").length !== 1) return bad("Upload one file at a time");

    const type = file.type;
    if (!extensionForMime(type, ALLOWED_POLICY_MIME)) {
      return bad("A policy must be a PDF");
    }
    if (file.size <= 0) return bad("The file appears to be empty");
    if (file.size > MAX_DOCUMENT_BYTES) return bad("That file is too large (max 10MB)", 413);

    // Allocate the version from what is already published for this slug.
    const existing = await listPolicies(client.id);
    if (!existing.ready) {
      return Response.json({ ok: false, error: ESIGN_COPY.notReady }, { status: 503 });
    }
    const version = nextPolicyVersion(existing.policies, slug);

    const path = safePolicyPath({
      clientSlug: client.slug,
      token: newPathToken(),
      filename: file.name || "policy",
      mime: type,
    });
    if (!path) return bad("That file could not be stored");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const storeFailed = await putStaffDocObject(path, bytes, type);
    if (storeFailed) {
      return Response.json(
        {
          ok: false,
          error: "That policy could not be stored, please try again",
          detail: "The staff-docs storage bucket may not exist on this environment.",
        },
        { status: 500 },
      );
    }

    try {
      const policy = await createPolicy({
        clientId: client.id,
        slug,
        title,
        version,
        storagePath: path,
        mime: type,
        sizeBytes: file.size,
        effectiveFrom: effectiveFromRaw,
        createdBy: auth?.id ?? null,
      });
      // Retire the earlier versions of this slug. Retired, never deleted: people
      // signed them. Best effort, and reported rather than thrown, because the new
      // version is already correct.
      const retired = await retireEarlierVersions(
        client.id,
        slug,
        version,
        new Date().toISOString(),
      );
      return Response.json({ ok: true, policy, earlierVersionsRetired: retired });
    } catch {
      // The PDF landed and the row did not: take the object back out rather than
      // leaving an orphan. The unique (client, slug, version) also lands here when
      // two managers publish at once, which is the correct outcome.
      await removeStaffDocObject(path);
      return bad("That policy could not be published, please try again", 500);
    }
  } catch {
    return bad("That policy could not be published, please try again", 500);
  }
}
