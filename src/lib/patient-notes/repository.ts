import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { canEditNote } from "./edit-window";
import { isNoteColour, type NoteColour } from "./colours";
import type { NewPatientNote, PatientNote, PatientNoteSource } from "./types";

interface Row {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  author_name: string;
  body: string;
  source: string;
  created_at: string;
  pinned_at: string | null;
  colour: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * WHAT IS DELIBERATELY NOT IN THIS PROJECTION: author_id.
 *
 * It is written on every note and it never leaves this file. The privacy posture of
 * this repository has always been that no session id reaches the client, and pinning
 * did not change it: the UI needs to know whether the PENCIL should appear, not whose
 * note it is, so what crosses the wire is a computed `canEdit` boolean. Where a query
 * does read author_id (below), it is consumed immediately by canEditNote and dropped
 * by toNote, which has no field to put it in.
 */
const COLS =
  "id, site_id, dentally_patient_id, author_name, body, source, created_at, pinned_at, colour, updated_at, updated_by";

/** The same projection plus authorship, for the rows this file decides canEdit on. */
const COLS_WITH_AUTHOR = `${COLS}, author_id`;

/** Who is reading, so canEdit is decided in one place rather than by every caller. */
export interface NoteViewer {
  /** The signed-in user's id, or null when auth enforcement is off (pilot). */
  viewerId: string | null;
  now: Date;
}

type AuthoredRow = Row & { author_id: string | null };

function toNote(r: Row, viewer: NoteViewer, authorId: string | null): PatientNote {
  return {
    id: r.id,
    siteId: r.site_id,
    patientId: r.dentally_patient_id,
    authorName: r.author_name,
    body: r.body,
    source: (r.source === "voice" ? "voice" : "typed") as PatientNoteSource,
    createdAt: r.created_at,
    pinnedAt: r.pinned_at,
    // A colour outside the vocabulary renders plain rather than throwing: a row
    // written by some future migration must never break a clinical screen.
    colour: isNoteColour(r.colour) ? r.colour : null,
    updatedAt: r.updated_at,
    editedBy: r.updated_by,
    canEdit: canEditNote({ authorId, createdAt: r.created_at }, viewer.now, viewer.viewerId),
  };
}

function fromAuthored(data: unknown, viewer: NoteViewer): PatientNote {
  const row = data as AuthoredRow;
  return toNote(row, viewer, row.author_id ?? null);
}

/**
 * A patient's practice notes.
 *
 * PINNED FIRST, newest pin first, then everything else newest first. The band takes
 * the pinned ones off the top of this same list, which is what stops the band and the
 * Notes tab from ever disagreeing about what is pinned or in what order.
 */
export async function listNotes(args: {
  siteId: string;
  patientId: string;
  viewer: NoteViewer;
}): Promise<PatientNote[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .select(COLS_WITH_AUTHOR)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AuthoredRow[]).map((r) => fromAuthored(r, args.viewer));
}

export async function createNote(note: NewPatientNote, viewer: NoteViewer): Promise<PatientNote> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .insert({
      client_id: note.clientId,
      site_id: note.siteId,
      dentally_patient_id: note.patientId,
      author_id: note.authorId,
      author_name: note.authorName,
      body: note.body,
      source: note.source,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return toNote(data as Row, viewer, note.authorId);
}

/**
 * Authorship and age of one note, for the PATCH guard only.
 *
 * Scoped by site AND patient, not by id alone: a caller legitimately holding site A
 * must not be able to reach a note attached to a different patient in site A by
 * quoting its id. Returning null for "no such note here" is what the route turns into
 * its 404, so a probe cannot tell a foreign note from a missing one.
 *
 * The author id it returns decides a boolean and is never serialised into a response.
 */
export async function getNoteAuthorship(args: {
  noteId: string;
  siteId: string;
  patientId: string;
}): Promise<{ authorId: string | null; createdAt: string; pinnedAt: string | null } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .select("author_id, created_at, pinned_at")
    .eq("id", args.noteId)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { author_id: string | null; created_at: string; pinned_at: string | null };
  return { authorId: row.author_id ?? null, createdAt: row.created_at, pinnedAt: row.pinned_at };
}

/** How many notes this patient already has pinned. Guards the 12-pin cap. */
export async function countPinned(args: { siteId: string; patientId: string }): Promise<number> {
  const db = serviceClient();
  const { count, error } = await db
    .from("patient_note")
    .select("id", { count: "exact", head: true })
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .not("pinned_at", "is", null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Every mutation below carries the SAME three-part predicate: id AND site AND
 * patient. It is written into each query rather than checked once by a caller so it
 * cannot be forgotten when a fourth verb is added, and so a note can never be mutated
 * across a site or a patient boundary by id alone. A predicate that matches nothing
 * returns null, which the route reports as a 404.
 */
interface NoteScope {
  noteId: string;
  siteId: string;
  patientId: string;
}

export async function pinNote(
  args: NoteScope & { pinned: boolean; actorName: string },
  viewer: NoteViewer,
): Promise<PatientNote | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .update(
      args.pinned
        ? { pinned_at: new Date().toISOString(), pinned_by: args.actorName }
        : { pinned_at: null, pinned_by: null },
    )
    .eq("id", args.noteId)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .select(COLS_WITH_AUTHOR)
    .maybeSingle();
  if (error) throw error;
  return data ? fromAuthored(data, viewer) : null;
}

export async function setColour(
  args: NoteScope & { colour: NoteColour | null },
  viewer: NoteViewer,
): Promise<PatientNote | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .update({ colour: args.colour })
    .eq("id", args.noteId)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .select(COLS_WITH_AUTHOR)
    .maybeSingle();
  if (error) throw error;
  return data ? fromAuthored(data, viewer) : null;
}

/**
 * Correct a note's body.
 *
 * The window and the authorship check belong to the route (they need the request's
 * user). This records that the correction happened: updated_at and updated_by are
 * written together and never separately, because a body that changed with no record
 * of who changed it is exactly what the window exists to prevent.
 */
export async function updateBody(
  args: NoteScope & { body: string; actorName: string },
  viewer: NoteViewer,
): Promise<PatientNote | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .update({ body: args.body, updated_at: new Date().toISOString(), updated_by: args.actorName })
    .eq("id", args.noteId)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .select(COLS_WITH_AUTHOR)
    .maybeSingle();
  if (error) throw error;
  return data ? fromAuthored(data, viewer) : null;
}
