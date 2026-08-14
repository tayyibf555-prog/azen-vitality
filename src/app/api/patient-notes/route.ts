import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { getPatientById } from "@/lib/dentally/read";
import {
  listNotes,
  createNote,
  countPinned,
  getNoteAuthorship,
  pinNote,
  setColour,
  updateBody,
  type NoteViewer,
} from "@/lib/patient-notes/repository";
import { canEditNote } from "@/lib/patient-notes/edit-window";
import { isNoteColour, type NoteColour } from "@/lib/patient-notes/colours";
import { MAX_PINNED_PER_PATIENT } from "@/lib/patient-notes/pin-layout";
import { recordUsage } from "@/lib/telemetry";
import type { PatientNoteSource } from "@/lib/patient-notes/types";

/**
 * THE OWNER KILL SWITCH IS DELIBERATELY NOT APPLIED TO THIS ROUTE, and that is a
 * decision rather than an oversight.
 *
 * The diary and every messaging path check `system_toggle` because they SEND things
 * to patients, and a halt there stops something leaving the building. Notes are a
 * record-keeping primitive: halting them would silently discard clinical information
 * a nurse believed she had saved, which is a worse failure than any it would prevent.
 * If notes ever gain an outbound behaviour, that behaviour gets the gate, not this.
 */

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
  // THE MODULE LOCK. requireClientAccess admits every role attached to this
  // practice, so this line is the only one that asks whether the caller's ROLE may
  // reach the patient record at all. Practice notes stay open to all four
  // staff-facing roles — a receptionist writing "patient rang about their bill" is
  // exactly what this feature is for — but "patients" is not in STAFF_SLUGS, so a
  // `client_staff` login is refused: their surface is "my-work" and nothing else.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;

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
    const notes = await listNotes({ siteId, patientId, viewer: viewerOf(auth) });
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
  // THE MODULE LOCK. requireClientAccess admits every role attached to this
  // practice, so this line is the only one that asks whether the caller's ROLE may
  // reach the patient record at all. Practice notes stay open to all four
  // staff-facing roles — a receptionist writing "patient rang about their bill" is
  // exactly what this feature is for — but "patients" is not in STAFF_SLUGS, so a
  // `client_staff` login is refused: their surface is "my-work" and nothing else.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;

  // THE PER-PERSON GATE. Practice notes stay open to all four record roles by
  // default (nothing is tightened here); this key exists so an owner can withhold
  // note-writing from ONE named person — a locum, somebody under review — without
  // taking the patient record away from them. GET is deliberately not gated:
  // reading a note is not writing one.
  const capabilityDenied = await requireCapability(auth, "patient.note.write");
  if (capabilityDenied) return capabilityDenied;

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
    const note = await createNote(
      {
        clientId: client.id,
        siteId,
        patientId,
        authorId: auth?.id ?? null,
        authorName: auth?.name ?? "Team",
        body,
        source,
      },
      viewerOf(auth),
    );
    // Action name only — never the note body or patient id (privacy).
    void recordUsage("patients", "note_added", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    return Response.json({ ok: true, note });
  } catch {
    return Response.json({ ok: false, error: "could not save note" }, { status: 500 });
  }
}

/**
 * PATCH /api/patient-notes
 *   { client, siteId, patientId, noteId, pinned?, colour?, body? }
 *
 * Pin, unpin, recolour and correct. Pinning, unpinning and recolouring are open to any
 * signed-in client user, matching POST, which has no role gate either: a receptionist
 * who cannot pin the note she just wrote would simply not use the feature.
 *
 * CORRECTING THE BODY IS NOT: the author only, inside fifteen minutes. After that a
 * correction is a NEW note, which is what clinical systems do and what an auditor
 * expects. See lib/patient-notes/edit-window.ts for why.
 *
 * FIVE GUARDS, in this order, and the last is the one the study did not have:
 *   1. requireUser
 *   2. requireClientAccess
 *   3. requireSiteAccess
 *   4. patientBelongsToSite   (the IDOR check POST already carries)
 *   5. the NOTE belongs to (siteId, patientId), enforced inside every update's own
 *      where-clause, so a caller legitimately scoped to site A cannot mutate a note
 *      attached to a different patient in site A by quoting its id.
 */
export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  let payload: {
    client?: string;
    siteId?: string;
    patientId?: string;
    noteId?: string;
    pinned?: unknown;
    colour?: unknown;
    body?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const client = getClient(payload.client ?? "");
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;
  // THE MODULE LOCK. requireClientAccess admits every role attached to this
  // practice, so this line is the only one that asks whether the caller's ROLE may
  // reach the patient record at all. Practice notes stay open to all four
  // staff-facing roles — a receptionist writing "patient rang about their bill" is
  // exactly what this feature is for — but "patients" is not in STAFF_SLUGS, so a
  // `client_staff` login is refused: their surface is "my-work" and nothing else.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;

  // THE PER-PERSON GATE. Practice notes stay open to all four record roles by
  // default (nothing is tightened here); this key exists so an owner can withhold
  // note-writing from ONE named person — a locum, somebody under review — without
  // taking the patient record away from them. GET is deliberately not gated:
  // reading a note is not writing one.
  const capabilityDenied = await requireCapability(auth, "patient.note.write");
  if (capabilityDenied) return capabilityDenied;

  const siteId = payload.siteId ?? "";
  const patientId = payload.patientId ?? "";
  const noteId = payload.noteId ?? "";
  if (!siteId || !patientId || !noteId) {
    return Response.json({ ok: false, error: "siteId, patientId and noteId are required" }, { status: 400 });
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const wantsPin = typeof payload.pinned === "boolean";
  const wantsColour = payload.colour !== undefined;
  const wantsBody = payload.body !== undefined;
  if (!wantsPin && !wantsColour && !wantsBody) {
    return Response.json({ ok: false, error: "nothing to change" }, { status: 400 });
  }
  // null clears the colour; anything else must be one of the six names in the
  // vocabulary, which is the same list migration 0064's check constraint holds.
  let colour: NoteColour | null | undefined;
  if (wantsColour) {
    if (payload.colour === null) colour = null;
    else if (isNoteColour(payload.colour)) colour = payload.colour;
    else return Response.json({ ok: false, error: "unknown colour" }, { status: 400 });
  }
  const newBody = wantsBody ? String(payload.body ?? "").trim() : "";
  if (wantsBody && !newBody) {
    return Response.json({ ok: false, error: "a note cannot be emptied" }, { status: 400 });
  }
  if (wantsBody && newBody.length > MAX_BODY) {
    return Response.json({ ok: false, error: "note is too long" }, { status: 400 });
  }

  const now = new Date();
  const viewer: NoteViewer = { viewerId: auth?.id ?? null, now };
  const scope = { noteId, siteId, patientId };
  const actorName = auth?.name ?? "Team";

  try {
    // Guard 5. A note that is not this patient's, in this site, does not exist as far
    // as this caller is concerned: the same 404 as a missing one, so a probe learns
    // nothing from the difference.
    const existing = await getNoteAuthorship(scope);
    if (!existing) return Response.json({ ok: false, error: "not found" }, { status: 404 });

    if (wantsBody && !canEditNote(existing, now, viewer.viewerId)) {
      return Response.json(
        {
          ok: false,
          error:
            "This note can no longer be edited. Notes can be corrected by their author for 15 minutes; after that, add a new note.",
        },
        { status: 403 },
      );
    }

    // The cap is checked here rather than in the database because a receptionist needs
    // a sentence she can act on, not a constraint violation. Only a note that is not
    // already pinned can push the count up.
    if (payload.pinned === true && !existing.pinnedAt) {
      const pinned = await countPinned({ siteId, patientId });
      if (pinned >= MAX_PINNED_PER_PATIENT) {
        return Response.json(
          {
            ok: false,
            error: `This patient already has ${MAX_PINNED_PER_PATIENT} pinned notes. Unpin one first.`,
          },
          { status: 409 },
        );
      }
    }

    let note = null;
    if (colour !== undefined) {
      note = await setColour({ ...scope, colour }, viewer);
    }
    if (wantsPin) {
      note = await pinNote({ ...scope, pinned: payload.pinned === true, actorName }, viewer);
    }
    if (wantsBody) {
      note = await updateBody({ ...scope, body: newBody, actorName }, viewer);
    }
    if (!note) return Response.json({ ok: false, error: "not found" }, { status: 404 });

    // Action name only: never the note body and never the patient id, exactly as
    // note_added has always behaved.
    void recordUsage("patients", wantsBody ? "note_edited" : "note_pinned", {
      clientId: client.id,
      userEmail: auth?.email,
      role: auth?.role,
    });
    return Response.json({ ok: true, note });
  } catch {
    return Response.json({ ok: false, error: "could not update the note" }, { status: 500 });
  }
}

/** The reader, for canEdit. Built once per request so every note is judged at the
 *  same instant rather than drifting across a long list. */
function viewerOf(auth: { id?: string } | null): NoteViewer {
  return { viewerId: auth?.id ?? null, now: new Date() };
}
