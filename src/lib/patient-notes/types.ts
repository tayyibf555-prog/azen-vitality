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
