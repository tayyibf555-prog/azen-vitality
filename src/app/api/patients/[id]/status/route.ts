import { recordUsage } from "@/lib/telemetry";
import { getSite } from "@/lib/mock/clients";
import { applyStatusChange } from "@/lib/patient-status/service";
import { getOverride, listAudit } from "@/lib/patient-status/repository";
import { isPatientAdminStatus } from "@/lib/patient-status/types";
import { requirePatientAdmin } from "@/lib/patient/access";

export const dynamic = "force-dynamic";

// The guard chain (requireUser -> role -> client -> site -> patient/site IDOR) now lives
// in lib/patient/access and is shared with the profile-edit route, so the two cannot
// drift apart. The behaviour here is unchanged: owners, practice managers
// (client_coordinator) and the agency admin only, and a foreign-site patient id 404s.

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

  const gate = await requirePatientAdmin(id, siteId);
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

  const gate = await requirePatientAdmin(id, siteId);
  if (gate instanceof Response) return gate;

  try {
    // patient_admin_audit now also carries PROFILE-edit rows ('edit:<field>'), which are
    // not status changes and whose to_status is a field value, not a status. Read a wider
    // slice and keep only the status rows, so a burst of detail edits can never push the
    // status history out of view or paint a field value as a status.
    const [override, audit] = await Promise.all([
      getOverride(gate.siteId, id),
      listAudit(gate.siteId, id, 50),
    ]);
    return Response.json({ ok: true, override, audit: audit.filter((a) => a.action === "set_status").slice(0, 10) });
  } catch (err) {
    console.error(`[patients/status] GET failed for ${id}`, err);
    return Response.json({ ok: false, error: "status read failed" }, { status: 500 });
  }
}
