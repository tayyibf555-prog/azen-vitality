import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import { getPatientById } from "@/lib/dentally/read";
import { listNotes, createNote } from "@/lib/patient-notes/repository";
import { recordUsage } from "@/lib/telemetry";
import type { PatientNoteSource } from "@/lib/patient-notes/types";

export const dynamic = "force-dynamic";

const MAX_BODY = 5000;

// Confirm (when enforcement is on) that the named patient actually belongs to the
// named site, so a caller holding site A cannot read/write notes for a site-B
// patient by pairing site A with a foreign patient id. Fail closed. Mirrors the
// IDOR guard on /api/dentally/patients/[id].
async function patientBelongsToSite(auth: unknown, patientId: string, siteId: string): Promise<boolean> {
  if (!auth) return true; // unenforced pilot: the detail route behaves the same
  const patient = await getPatientById(patientId);
  return Boolean(patient && patient.siteId === siteId);
}

// GET /api/patient-notes?client=&siteId=&patientId=  -> this patient's practice notes
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;

  const siteId = url.searchParams.get("siteId") ?? "";
  const patientId = url.searchParams.get("patientId") ?? "";
  if (!siteId || !patientId) {
    return Response.json({ ok: false, error: "siteId and patientId are required" }, { status: 400 });
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  try {
    const notes = await listNotes({ siteId, patientId });
    return Response.json({ ok: true, notes });
  } catch {
    return Response.json({ ok: false, notes: [] }, { status: 500 });
  }
}

// POST /api/patient-notes  { client, siteId, patientId, body, source }  -> save a note
export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  let payload: { client?: string; siteId?: string; patientId?: string; body?: string; source?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const client = getClient(payload.client ?? "");
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;

  const siteId = payload.siteId ?? "";
  const patientId = payload.patientId ?? "";
  const body = (payload.body ?? "").trim();
  const source: PatientNoteSource = payload.source === "voice" ? "voice" : "typed";
  if (!siteId || !patientId || !body) {
    return Response.json({ ok: false, error: "siteId, patientId and body are required" }, { status: 400 });
  }
  if (body.length > MAX_BODY) {
    return Response.json({ ok: false, error: "note is too long" }, { status: 400 });
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  try {
    const note = await createNote({
      clientId: client.id,
      siteId,
      patientId,
      authorId: auth?.id ?? null,
      authorName: auth?.name ?? "Team",
      body,
      source,
    });
    // Action name only — never the note body or patient id (privacy).
    void recordUsage("patients", "note_added", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    return Response.json({ ok: true, note });
  } catch {
    return Response.json({ ok: false, error: "could not save note" }, { status: 500 });
  }
}
