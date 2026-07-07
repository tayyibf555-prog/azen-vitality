import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { NewPatientNote, PatientNote, PatientNoteSource } from "./types";

interface Row {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  author_name: string;
  body: string;
  source: string;
  created_at: string;
}

const COLS = "id, site_id, dentally_patient_id, author_name, body, source, created_at";

function toNote(r: Row): PatientNote {
  return {
    id: r.id,
    siteId: r.site_id,
    patientId: r.dentally_patient_id,
    authorName: r.author_name,
    body: r.body,
    source: (r.source === "voice" ? "voice" : "typed") as PatientNoteSource,
    createdAt: r.created_at,
  };
}

/** A patient's practice notes, newest first. */
export async function listNotes(args: { siteId: string; patientId: string }): Promise<PatientNote[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_note")
    .select(COLS)
    .eq("site_id", args.siteId)
    .eq("dentally_patient_id", args.patientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as Row[]).map(toNote);
}

export async function createNote(note: NewPatientNote): Promise<PatientNote> {
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
  return toNote(data as Row);
}
