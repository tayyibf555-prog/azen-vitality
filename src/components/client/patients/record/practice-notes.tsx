"use client";

import { useState } from "react";
import { Pin } from "lucide-react";
import { EMPTY_COPY } from "@/lib/patient/tabs";
import { MAX_PINNED_PER_PATIENT } from "@/lib/patient-notes/pin-layout";
import type { NoteColour } from "@/lib/patient-notes/colours";
import { PanelEmpty, PanelFailed, PanelNote } from "./panel";
import { NoteCard } from "./note-card";
import { NoteComposer } from "./note-composer";
import { usePatientNotes } from "./use-patient-notes";

/**
 * OUR practice notes: the composer, then every note this practice has written about
 * this patient, pinned ones first.
 *
 * It reads the same hook the pinned band does, so pinning a note here makes it appear
 * in the band above immediately and in the same order, and the two can never disagree
 * about what is pinned.
 *
 * The pinned ones are NOT hidden from this list once they are in the band. A note is
 * one note; showing it twice is how Dentally behaves and it is what a reader scrolling
 * the full history expects to find. The "Pinned" marker on the card's foot line is
 * what distinguishes it.
 *
 * THE THREE SENTENCES STAY DIFFERENT. "No practice notes yet" is a fact about this
 * patient (we own these rows, so an empty list is a real answer). A failed read says
 * so in its own words. Neither is ever used for the other.
 */
export function PracticeNotes({ siteId, patientId }: { siteId: string; patientId: string }) {
  const { notes, loading, failed, error, busyId, saving, add, setPinned, setColour, setBody } = usePatientNotes(
    siteId,
    patientId,
  );
  const [now] = useState(() => new Date());

  const pinnedCount = notes.filter((n) => n.pinnedAt).length;

  return (
    <div className="space-y-3">
      <NoteComposer onSave={add} saving={saving} />

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-muted">Loading notes...</p>
      ) : failed ? (
        <PanelFailed>We could not read this patient&apos;s practice notes just now.</PanelFailed>
      ) : notes.length === 0 ? (
        <PanelEmpty>{EMPTY_COPY.practiceNotes}</PanelEmpty>
      ) : (
        <>
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note.id}>
                <NoteCard
                  note={note}
                  now={now}
                  variant="list"
                  busy={busyId === note.id}
                  onPin={(p) => void setPinned(note.id, p)}
                  onColour={(c: NoteColour | null) => void setColour(note.id, c)}
                  onSaveBody={(b) => setBody(note.id, b)}
                />
              </li>
            ))}
          </ul>
          <PanelNote className="flex items-center gap-1.5">
            <Pin size={10} aria-hidden />
            {pinnedCount} of {MAX_PINNED_PER_PATIENT} pins used. A pinned note sits across the top of this record on
            every tab.
          </PanelNote>
        </>
      )}
    </div>
  );
}
