import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireApproverRole,
} from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { resolveSelfStaff, selfServiceRequested } from "@/lib/self-service/read";
import type { AuthedUser } from "@/lib/auth/session";
import { isWithinOwnDocPrefix, isWithinStaffDocPrefix } from "@/lib/hr/documents";
import { signStaffDocUrl } from "@/lib/hr/document-repository";

export const dynamic = "force-dynamic";

// ===========================================================================
// Mint a SHORT-LIVED signed URL for one staff document.
//
// CLONED FROM api/onboarding/file/route.ts, which is the tenancy template in this
// codebase, with one difference: its prefix + traversal check is inline and
// therefore untestable, and this one calls `isWithinStaffDocPrefix`, a pure function
// with its own tests. The check is the only thing standing between one practice's
// employee passports and another's, so it is proven rather than believed.
//
// The guard is stricter than "starts with the client slug" on purpose: a path of
// "onboarding/<slug>/..." would satisfy that and read a PATIENT's uploaded document
// out of the other bucket. The prefix asserted is the BUCKET and the client:
// `staff-docs/<clientSlug>/`.
//
// A VIEW, NOT A SHAREABLE LINK: 120 seconds, matching the onboarding precedent. A
// public URL is never minted anywhere in this codebase (`getPublicUrl` appears
// nowhere) and this route must not be the first.
//
// CAPABILITY "hr.view-documents": in the catalog, and enforced below. The approver
// role guard stays beside it — the API module-guard sweep reads role and module
// tokens as the proof a route is locked, so a capability on its own would read to
// that sweep as no lock at all. Revoking the key from one named person bites today;
// granting it outside APPROVER_ROLES does not, until the role guard comes off.
//
// ---------------------------------------------------------------------------
// `mine=1`: THE SAME URL, FOR YOUR OWN DOCUMENT, WITH A NARROWER PATH GUARD.
// ---------------------------------------------------------------------------
// My work's "My documents" tab opens a person's own file, and all three manager
// gates above refuse the roles it exists for. On that branch the caller is
// resolved by `resolveSelfStaff` (session in, no staff id anywhere) and the path
// must satisfy `isWithinOwnDocPrefix` — one segment stricter than the practice
// prefix, because a manager may open anybody's document and a nurse may not. A
// colleague's path is refused even though it is unquestionably this practice's.
// ===========================================================================

const SIGNED_URL_TTL_SECONDS = 120; // short-lived: a view, not a shareable link

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const path = url.searchParams.get("path") ?? "";

  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // ---- SELF SERVICE (`mine=1`), before any manager gate --------------------
  if (selfServiceRequested(url)) {
    const self = await resolveSelfStaff(client.id, auth, "there are no documents to show");
    if (!self.ok) return self.response;
    // BOTH guards, in order: the practice prefix (traversal, other bucket, other
    // client) and then this person's own sub-prefix. A path from a browser is a
    // request, not a fact, however it was obtained.
    if (!isWithinOwnDocPrefix(path, client.slug, self.staff.id)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const ownUrl = await signStaffDocUrl(path, SIGNED_URL_TTL_SECONDS);
    if (!ownUrl) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ url: ownUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
  }

  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "hr.view-documents");
  if (capDenied) return capDenied;

  // Tenancy + traversal guard: the path must be exactly under this client's prefix
  // inside the staff-docs bucket, and must contain no `..` anywhere.
  if (!isWithinStaffDocPrefix(path, client.slug)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const signedUrl = await signStaffDocUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signedUrl) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ url: signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
}
