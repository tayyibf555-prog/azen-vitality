import type { NoteColour } from "./colours";

export type PatientNoteSource = "typed" | "voice";

/** A practice-authored note stored in our platform (distinct from Dentally's own
 *  clinical notes, which are read live and shown separately). */
export interface PatientNote {
  id: string;
  siteId: string;
  /** Dentally patient id the note is attached to. */
  patientId: string;
  authorName: string;
  body: string;
  source: PatientNoteSource;
  createdAt: string;
  /** When it was pinned, null when it is not pinned. The band orders on this, newest
   *  first, so what someone just pinned is never the one hidden behind "N more". */
  pinnedAt: string | null;
  /** User-chosen, from the vocabulary in colours.ts. Null until somebody picks one. */
  colour: NoteColour | null;
  /** Set only when the body was corrected inside the author's edit window. */
  updatedAt: string | null;
  /** Who made that correction, by display name. */
  editedBy: string | null;
  /**
   * Whether THIS viewer may still correct the body: the author, inside fifteen
   * minutes. Computed on the server, never trusted from the client, and returned as a
   * boolean precisely so the note's author_id never has to leave the server.
   */
  canEdit: boolean;
}

export interface NewPatientNote {
  clientId: string;
  siteId: string;
  patientId: string;
  authorId: string | null;
  authorName: string;
  body: string;
  source: PatientNoteSource;
}

export type { NoteColour };
