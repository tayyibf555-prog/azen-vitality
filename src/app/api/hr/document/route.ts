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
import { consumeBudget } from "@/lib/rate-budget";
import { getStaff } from "@/lib/rota/repository";
import {
  ALLOWED_DOCUMENT_MIME,
  CONTENT_LENGTH_CEILING,
  DOCUMENT_COPY,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_LABEL,
  extensionForMime,
  isDocumentKind,
  safeDocPath,
} from "@/lib/hr/documents";
import {
  createStaffDocument,
  listStaffDocuments,
  newPathToken,
  putStaffDocObject,
  removeStaffDocObject,
} from "@/lib/hr/document-repository";

export const dynamic = "force-dynamic";

// ===========================================================================
// The staff document vault: list a person's documents, and upload one.
//
// THIS IS THE ONBOARDING UPLOAD TEMPLATE (api/onboarding/upload/route.ts), cloned in
// shape and then TIGHTENED, because that route is the only upload in this codebase
// and it is a good one. Kept from it, deliberately and in the same order:
//   - a per-IP hourly cap taken FIRST, so a flood is blunted before the body is read;
//   - `consumeBudget`, the shared cross-instance ceiling that IP spoofing cannot
//     bypass and that bounds orphaned-object flooding;
//   - a Content-Length PRE-GUARD above the file cap, then the authoritative
//     post-parse size check (Content-Length can be absent or a lie);
//   - a MIME allow-list of exactly five types;
//   - a leaf name that never trusts the supplied filename, with the extension FORCED
//     from the validated content-type;
//   - an unguessable path under a random token directory.
//
// TIGHTENED because this one is NOT public: it is
// requireUser -> requireClientAccess -> requireModuleApiAccess("staff-hr") ->
// requireApproverRole, and the staff member the document belongs to must already
// exist in THIS practice.
//
// CAPABILITIES, NOW REAL. Reading the vault is `hr.view-documents` and uploading is
// `hr.manage-documents` (owner + agency + coordinator by default), both in the
// catalog and both enforced here. The approver role guard STAYS beside them: the API
// module-guard sweep reads role and module tokens as the proof a route is locked, so
// a capability alone would read to it as no lock. Revoking a key from one named
// person bites today; granting one beyond APPROVER_ROLES does not, yet.
//
// NO VIRUS SCANNING EXISTS IN THIS CODEBASE and none is proposed here. The
// mitigations are the allow-list, the size cap, a PRIVATE bucket, 120-second signed
// URLs only, and the fact that only signed-in staff of this practice can upload.
// DOCUMENT_COPY.noVirusScanning says exactly that on the screen.
// ===========================================================================

const IP_RATE_LIMIT = 40; // uploads from one IP per hour (best-effort, per-instance)
const HOUR_MS = 60 * 60 * 1000;

const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
  }
  return hits.length > IP_RATE_LIMIT;
}

function clientIp(request: Request): string {
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the LAST
  // x-forwarded-for entry (Vercel appends the real connecting IP at the end); the
  // leftmost entry is attacker-controlled, so never trust it.
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** YYYY-MM-DD or nothing. A malformed date is refused, never coerced. */
function optionalDate(v: FormDataEntryValue | null): string | null | "invalid" {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "invalid";
  return trimmed;
}

type Access = { auth: AuthedUser | null; client: { id: string; slug: string } };

/**
 * SESSION AND TENANCY, and nothing more.
 *
 * Split out of `authorise` because the self-service read (`mine=1`, below) needs
 * exactly this much and must NOT have the rest: every one of the manager gates
 * refuses `client_staff`, the role whose own file this is.
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

/**
 * The shared front half of the MANAGER paths: session, tenancy, module, role.
 *
 * Returned as a Response the caller returns directly, or the resolved context.
 */
async function authorise(clientSlug: string): Promise<Response | Access> {
  const identified = await identify(clientSlug);
  if (identified instanceof Response) return identified;
  const { auth, client } = identified;
  // Staff HR is owner + agency + the practice manager. The module gate refuses the
  // clinician and the staff role outright: employee files are not their surface.
  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  // Both methods need to be able to SEE the vault. The upload adds
  // `hr.manage-documents` on top of this, in POST, where the write is.
  const capDenied = await requireCapability(auth, "hr.view-documents");
  if (capDenied) return capDenied;

  return { auth, client };
}

/** The vault read itself, shared by both callers so they cannot answer differently. */
async function readVault(clientId: string, staffId: string): Promise<Response> {
  try {
    const { ready, documents } = await listStaffDocuments(clientId, staffId);
    if (!ready) {
      // NOT an empty vault: the table is not there yet, and the screen says so.
      return Response.json({ ok: true, ready: false, documents: [], note: DOCUMENT_COPY.notReady });
    }
    return Response.json({ ok: true, ready: true, documents });
  } catch {
    // LOUD FAILURE: a read error is an honest failure, never a confident empty list.
    return Response.json({ ok: false, error: "read-failed" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/hr/document?client=<slug>&staffId=<uuid> — one person's vault.
// GET /api/hr/document?client=<slug>&mine=1        — the CALLER's own vault.
//
// THE TWO CALLERS ARE THE POINT OF THE SPLIT. A manager reads a named person's
// file behind the module gate, the approver role and `hr.view-documents`. A
// member of staff reads THEIR OWN from My work, and every one of those three
// guards refuses them — "staff-hr" is in neither allow-list, the role is not an
// approver, and the capability is a manager's. So `mine=1` skips them, and what
// stands in their place is that `resolveSelfStaff` takes the session and no staff
// id: the `staffId` parameter is not read at all on that branch, and there is
// therefore no other file it could return. See the `kind:"self-service"` entry in
// src/app/api/client-api-module-guard-coverage.test.ts.
// ---------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // ---- SELF SERVICE (`mine=1`), before any manager gate --------------------
  if (selfServiceRequested(url)) {
    const identified = await identify(url.searchParams.get("client") ?? "");
    if (identified instanceof Response) return identified;
    const self = await resolveSelfStaff(
      identified.client.id,
      identified.auth,
      "there are no documents to show",
    );
    if (!self.ok) return self.response;
    return readVault(identified.client.id, self.staff.id);
  }

  const access = await authorise(url.searchParams.get("client") ?? "");
  if (access instanceof Response) return access;

  const staffId = (url.searchParams.get("staffId") ?? "").trim();
  if (!staffId) return bad("Which member of staff?");

  return readVault(access.client.id, staffId);
}

// ---------------------------------------------------------------------------
// POST /api/hr/document — multipart upload of ONE file.
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  try {
    // Per-IP cap first (cheap), so a flood is blunted before the body is read.
    if (tooManyForIp(clientIp(request), Date.now())) {
      return bad("Too many uploads, please try again later", 429);
    }
    // Shared global budget: the real ceiling across all instances, immune to IP
    // spoofing. Bounds abuse and orphaned-object flooding regardless of warm
    // instances.
    if (!(await consumeBudget("hr-document-upload", 200, 60))) {
      return Response.json(
        { ok: false, error: "the vault is busy, please try again shortly" },
        { status: 429 },
      );
    }

    // Fast Content-Length guard: reject an oversized body before parsing it. Above
    // the 10MB file cap to allow multipart overhead. The post-parse size check below
    // remains authoritative (Content-Length can be absent or lied about).
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

    // THE WRITE HALF. `hr.manage-documents` is DESTRUCTIVE in the catalog, so on an
    // environment with no sign-in configured this refuses rather than writing a
    // right-to-work document into somebody's file on nobody's authority.
    const manageDenied = await requireCapability(auth, "hr.manage-documents");
    if (manageDenied) return manageDenied;

    const staffId =
      typeof form.get("staffId") === "string" ? (form.get("staffId") as string).trim() : "";
    if (!staffId) return bad("Which member of staff?");
    // TENANCY, PROVEN NOT ASSUMED: the staff row must exist in THIS practice. The
    // composite FK would refuse a cross-tenant id anyway, but that would surface as a
    // 500 after the bytes were already written.
    const staff = await getStaff(staffId, client.id);
    if (!staff) return bad("That member of staff is not on this practice's team");

    const kind = form.get("kind");
    if (!isDocumentKind(kind)) return bad("Choose what kind of document this is");

    const label =
      typeof form.get("label") === "string" ? (form.get("label") as string).trim() : "";
    if (label === "") return bad("Give the document a name");
    if (label.length > MAX_DOCUMENT_LABEL) return bad("That name is too long");

    const expiresOn = optionalDate(form.get("expiresOn"));
    if (expiresOn === "invalid") return bad("That expiry date is not a date");
    const retainUntil = optionalDate(form.get("retainUntil"));
    if (retainUntil === "invalid") return bad("That retention date is not a date");

    const file = form.get("file");
    if (!(file instanceof File)) return bad("No file provided");
    // Single file per request: reject if extra `file` entries were sent.
    if (form.getAll("file").length !== 1) return bad("Upload one file at a time");

    const type = file.type;
    if (!extensionForMime(type, ALLOWED_DOCUMENT_MIME)) {
      return bad("That file type is not supported. Upload a PDF or a photograph.");
    }
    if (file.size <= 0) return bad("The file appears to be empty");
    if (file.size > MAX_DOCUMENT_BYTES) return bad("That file is too large (max 10MB)", 413);

    // staff-docs/<clientSlug>/<staffId>/<token>/<safeName>. The token directory makes
    // the path unguessable; the leaf never trusts the supplied filename.
    const path = safeDocPath({
      clientSlug: client.slug,
      staffId,
      token: newPathToken(),
      filename: file.name || "document",
      mime: type,
    });
    if (!path) return bad("That file could not be stored");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const storeFailed = await putStaffDocObject(path, bytes, type);
    if (storeFailed) {
      // The most likely cause by far is that the private `staff-docs` bucket has not
      // been created on this environment. The onboarding upload answers this case
      // with a message that gives no clue why, and a fresh deployment therefore
      // fails silently and confusingly. This one says which bucket is missing.
      return Response.json(
        {
          ok: false,
          error: DOCUMENT_COPY.uploadFailed,
          detail: "The staff-docs storage bucket may not exist on this environment.",
        },
        { status: 500 },
      );
    }

    try {
      const document = await createStaffDocument({
        clientId: client.id,
        staffId,
        kind,
        label,
        storagePath: path,
        mime: type,
        sizeBytes: file.size,
        expiresOn: expiresOn === "invalid" ? null : expiresOn,
        retainUntil: retainUntil === "invalid" ? null : retainUntil,
        uploadedBy: auth?.id ?? null,
      });
      return Response.json({ ok: true, document });
    } catch {
      // The bytes landed and the row did not. Take the object back out rather than
      // leaving an orphan nobody can see, list or delete.
      await removeStaffDocObject(path);
      return bad("That document could not be recorded, please try again", 500);
    }
  } catch {
    return bad("That document could not be stored, please try again", 500);
  }
}
