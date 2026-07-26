import { requirePatientAdmin } from "@/lib/patient/access";
import { recordUsage } from "@/lib/telemetry";
import { getSite } from "@/lib/mock/clients";
import { canonicaliseProfile, parseProfileChanges } from "@/lib/patient/profile";
import { applyProfileEdit, getProfile } from "@/lib/patient/profile-service";
import { listProfileAudit } from "@/lib/patient/profile-audit";
import { isDentallyWriteEnabled } from "@/lib/dentally/write";

export const dynamic = "force-dynamic";

// Editable patient profile. Owners, practice managers (client_coordinator) and the agency
// admin only; the guard chain, including the site-scope IDOR check, lives in
// lib/patient/access so this route and the status route cannot drift apart.
//
// GET   /api/patients/[id]/profile?siteId=   current editable values + the edit history
// PATCH /api/patients/[id]/profile           { siteId, changes, expected, reason? }

/**
 * GET: what is on file, plus the trail of past edits. Deliberately readable whether or
 * not the Dentally write gate is open (viewing is not writing); the response says which,
 * so the UI can put the form in read-only mode with an honest explanation.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const siteId = new URL(request.url).searchParams.get("siteId") ?? "";

  const gate = await requirePatientAdmin(id, siteId);
  if (gate instanceof Response) return gate;

  try {
    const [profile, audit] = await Promise.all([getProfile(id), listProfileAudit(gate.siteId, id, 20)]);
    if (!profile) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return Response.json({ ok: true, profile, audit, editingEnabled: isDentallyWriteEnabled() });
  } catch (err) {
    console.error(`[patients/profile] GET failed for ${id}`, err);
    return Response.json({ ok: false, error: "profile read failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;

  let body: { siteId?: unknown; changes?: unknown; expected?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const siteId = typeof body.siteId === "string" ? body.siteId : "";

  // Authorise BEFORE parsing the payload, so an unauthorised caller learns nothing about
  // which fields are editable or whether the patient exists.
  const gate = await requirePatientAdmin(id, siteId);
  if (gate instanceof Response) return gate;

  // Strict whitelist. The raw body NEVER reaches Dentally: `changes` is rebuilt field by
  // field from keys we recognise, so a patient id, a site id or any other Dentally field
  // a caller tries to smuggle is dropped here.
  const parsed = parseProfileChanges(body.changes);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: "validation", fields: parsed.errors }, { status: 400 });
  }
  if (Object.keys(parsed.parsed.values).length === 0) {
    return Response.json({ ok: false, error: "no editable fields were supplied" }, { status: 400 });
  }
  // `expected` is the snapshot the form was loaded with, run through the SAME
  // canonicaliser as the live record so the comparison is like for like.
  const expected = canonicaliseProfile(
    body.expected && typeof body.expected === "object" ? (body.expected as Record<string, unknown>) : {},
  );
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const result = await applyProfileEdit({
      siteId: gate.siteId,
      patientId: id,
      changes: parsed.parsed.values,
      expected,
      reason,
      actorEmail: gate.auth?.email ?? null,
    });

    if (!result.ok) {
      const status =
        result.code === "write_disabled" ? 503 : result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 502;
      return Response.json(
        { ok: false, error: result.code, message: result.message, conflicts: result.conflicts },
        { status },
      );
    }

    void recordUsage("patients", "profile_edit", {
      clientId: getSite(gate.siteId)?.clientId ?? "unknown",
      userEmail: gate.auth?.email ?? null,
      role: gate.auth?.role ?? null,
    });
    return Response.json({
      ok: true,
      changed: result.changed,
      profile: result.profile,
      auditRecorded: result.auditRecorded,
      // Surfaced so the caller can see a key was ignored rather than silently applied.
      dropped: parsed.parsed.dropped,
    });
  } catch (err) {
    console.error(`[patients/profile] PATCH failed for ${id}`, err);
    return Response.json({ ok: false, error: "profile update failed" }, { status: 500 });
  }
}
