"use client";

import { PracticeNotes } from "./practice-notes";
import { PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { relativeLabel } from "@/lib/time/relative";
import type { NoteRecord, ReadHealth } from "@/lib/dentally/read";

/**
 * Notes: TWO STREAMS, never merged, provenance always legible.
 *
 * 1. PRACTICE NOTES are ours (patient_note). Typed or dictated, written here, and
 *    from stage 2 pinnable and colourable.
 * 2. CLINICAL NOTES (DENTALLY) are read-only and are never copied into our table.
 *    DentallyClient has no create or update method for /v1/notes at all, so a
 *    Dentally note can never be edited, coloured or pinned here.
 *
 * They must stay visibly different without reading a label, or staff will try to pin
 * one that cannot be pinned. Ours carry the composer above them, a colour rail and
 * three controls; Dentally's carry a provenance tag, a muted surface, no rail and NO
 * CONTROLS AT ALL. That difference is structural rather than a label, which is the
 * point: nobody has to read anything to know which notes they can act on.
 *
 * The empty and failed sentences are DIFFERENT sentences, and NEITHER of them is a
 * claim about the patient. "No clinical notes have come through from Dentally" is a
 * claim about what this connection returned; "we could not read them just now" is a
 * claim about the connection failing. Before the read-health flags existed an outage
 * rendered as the empty state, which on a clinical record is a lie; and the empty
 * state itself used to read "No clinical notes in Dentally", which asserts something
 * about another system's record that one read-only endpoint cannot establish.
 */
export function TabNotes({
  siteId,
  patientId,
  dentallyNotes,
  reads,
  nowIso,
}: {
  siteId: string;
  patientId: string;
  dentallyNotes: NoteRecord[];
  reads: ReadHealth;
  nowIso: string;
}) {
  const now = new Date(nowIso);

  return (
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
      <PanelSection title="Practice notes">
        <PracticeNotes siteId={siteId} patientId={patientId} />
        <PanelNote>
          Practice notes are held on this platform. They are not written back to Dentally.
        </PanelNote>
      </PanelSection>

      <PanelSection title="Clinical notes (Dentally)">
        {reads.notes === "failed" ? (
          <PanelFailed>{FAILED_COPY.dentallyNotes}</PanelFailed>
        ) : dentallyNotes.length === 0 ? (
          <PanelEmpty>{EMPTY_COPY.dentallyNotes}</PanelEmpty>
        ) : (
          <ul className="space-y-2">
            {dentallyNotes.map((n) => (
              <li key={n.id} className="rounded-lg border border-line bg-card-muted/50 px-3 py-2.5">
                <p className="whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{n.body}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <span className="rounded border border-line-strong bg-card px-1.5 py-[1px] text-[10px] font-medium text-faint">
                    Dentally
                  </span>
                  {n.author}
                  {n.createdAt ? ` · ${relativeLabel(n.createdAt, now)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        <PanelNote>Read-only. Dentally does not accept note writes through the connection we have.</PanelNote>
      </PanelSection>
    </div>
  );
}
