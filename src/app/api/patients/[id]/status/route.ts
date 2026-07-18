import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import { recordUsage } from "@/lib/telemetry";
import type { AuthedUser } from "@/lib/auth/session";
import { getPatientById } from "@/lib/dentally/read";
import { getSite } from "@/lib/mock/clients";
import { applyStatusChange } from "@/lib/patient-status/service";
import { getOverride, listAudit } from "@/lib/patient-status/repository";
import { isPatientAdminStatus } from "@/lib/patient-status/types";

export const dynamic = "force-dynamic";

// Roles permitted to see and use the patient status control. SERVER-enforced here; the
// UI hides the control for other roles too, but this is the real gate.
const ALLOWED_ROLES = new Set(["client_owner", "client_coordinator", "agency_admin"]);

/** 403 Response if an enforced user is not permitted to manage patient status; else null.
 *  No-op when user is null (enforcement off), matching the other guard helpers. */
function requireStatusRole(user: AuthedUser | null): Response | null {
  if (user && !ALLOWED_ROLES.has(user.role)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Run the shared guard chain for both verbs: requireUser -> role -> requireClientAccess
 * -> requireSiteAccess -> patient/site IDOR check. Returns either a Response to return
 * immediately, or the resolved { auth, siteId } on success.
 *
 * The IDOR check mirrors the getPatientDetail fix: proving the caller may reach the named
 * site is NOT enough - the requested PATIENT must actually belong to that site, or a
 * caller holding site A could mutate a site B patient's status by pairing site A with a
 * foreign patient id. Fail closed with a 404 that never reveals the patient exists.
 */
async function guard(
  request: Request,
  id: string,
  siteId: string,
): Promise<Response | { auth: AuthedUser | null; siteId: string }> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const roleDenied = requireStatusRole(auth);
  if (roleDenied) return roleDenied;

  if (!siteId) return Response.json({ ok: false, error: "siteId is required" }, { status: 400 });

  // Resolve the client that owns this site; an unknown site is a bad request.
  const clientId = getSite(siteId)?.clientId;
  if (!clientId) return Response.json({ ok: false, error: "unknown site" }, { status: 400 });

  const clientDenied = requireClientAccess(auth, clientId);
  if (clientDenied) return clientDenied;

  const siteDenied = requireSiteAccess(auth, siteId);
  if (siteDenied) return siteDenied;

  // IDOR: only when enforcement is on (auth non-null), the requested patient's REAL site
  // must match the named site. Fail closed (404) on an unresolved or foreign-site patient.
  if (auth) {
    const patient = await getPatientById(id);
    if (!patient || patient.siteId !== siteId) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
  }

  return { auth, siteId };
}

// PATCH /api/patients/[id]/status  body { siteId, status, reason? }
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;

  let body: { siteId?: unknown; status?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const siteId = typeof body.siteId === "string" ? body.siteId : "";
  const status = body.status;
  if (!isPatientAdminStatus(status)) {
    return Response.json(
      { ok: false, error: "status must be one of active, inactive, do_not_contact" },
      { status: 400 },
    );
  }
  const reason = typeof body.reason === "string" ? body.reason : null;

  const gate = await guard(request, id, siteId);
  if (gate instanceof Response) return gate;

  try {
    const result = await applyStatusChange({
      siteId: gate.siteId,
      patientId: id,
      status,
      reason,
      actorEmail: gate.auth?.email ?? null,
    });
    void recordUsage("patients", "status_change", {
      clientId: getSite(gate.siteId)?.clientId ?? "unknown",
      userEmail: gate.auth?.email ?? null,
      role: gate.auth?.role ?? null,
    });
    return Response.json({ ok: true, status: result.status, dentally: result.dentally });
  } catch (err) {
    console.error(`[patients/status] PATCH failed for ${id}`, err);
    return Response.json({ ok: false, error: "status update failed" }, { status: 500 });
  }
}

// GET /api/patients/[id]/status?siteId=  -> current override + last 10 audit entries.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const siteId = new URL(request.url).searchParams.get("siteId") ?? "";

  const gate = await guard(request, id, siteId);
  if (gate instanceof Response) return gate;

  try {
    const [override, audit] = await Promise.all([
      getOverride(gate.siteId, id),
      listAudit(gate.siteId, id, 10),
    ]);
    return Response.json({ ok: true, override, audit });
  } catch (err) {
    console.error(`[patients/status] GET failed for ${id}`, err);
    return Response.json({ ok: false, error: "status read failed" }, { status: 500 });
  }
}
