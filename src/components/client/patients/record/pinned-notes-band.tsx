"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { moreLabel, splitPinnedBand } from "@/lib/patient-notes/pin-layout";
import type { NoteColour } from "@/lib/patient-notes/colours";
import type { PatientNote } from "@/lib/patient-notes/types";
import { NoteCard } from "./note-card";
import { usePatientNotes } from "./use-patient-notes";

/**
 * Dentally's pinned sticky notes, across the top of the record.
 *
 * WHERE IT SITS, and this is why it is a component of the LAYOUT rather than of a
 * page: directly under the header and ABOVE the tab strip, so a pinned note reaches
 * the reader whichever tab they are on, and switching tabs never repaints it.
 *
 * THE METAPHOR IS KEPT. The owner's first verdict was that the reference looked bad,
 * and then he corrected the premise himself: "that image does have a lot of pinned
 * notes ours wont look like that it looks messy but the layout of the profile should
 * be the same so they are used to it". So the work is in EXECUTION (see note-card)
 * and in VOLUME, which is what this file is.
 *
 * VOLUME, all of it decided by lib/patient-notes/pin-layout.ts and tested there:
 *   0        nothing at all. No heading, no empty shell, no chrome: the record starts
 *            at the tab strip. This is the commonest case and it must cost nothing.
 *   1        one full-width card, three lines.
 *   2 to 3   one row.
 *   4 to 6   two rows, two lines each.
 *   7+       two rows and "N more pinned notes", which expands IN PLACE, never into a
 *            modal, and never on load.
 *   always   the band is capped at 40% of the viewport and scrolls inside itself past
 *            that, so the tab content is reachable without scrolling past notes.
 * Order is newest pin first, so what somebody just pinned is never the one hidden.
 *
 * HIDE IS PER-READER AND LASTS THE SESSION. sessionStorage, keyed by site and patient,
 * no column and no second table. A practice-wide hide would let one receptionist clear
 * a clinical note off fifty people's screens, which is a clinical-safety act dressed
 * as a UI control; a persisted per-user hide would need a table for something
 * transient. "Show hidden (N)" is present whenever anything is hidden, so nothing can
 * be lost silently.
 *
 * A FAILED READ IS NOT AN ABSENT BAND. If the notes read throws, this says so. On a
 * record where a pinned note may read "allergic to latex", silence and "there are
 * none" must never look the same.
 *
 * IT IS SEEDED FROM THE SERVER. The record shell reads the same list server-side and
 * hands it in, so the band is in its final shape on the first paint. Without that it
 * rendered null until a client fetch landed and then pushed the tab strip and every
 * tab panel down by roughly 90px per row, under a cursor already aimed at a tab.
 */

function hideKey(siteId: string, patientId: string): string {
  return `pinnedhide:${siteId}:${patientId}`;
}

function readHidden(key: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function PinnedNotesBand({
  siteId,
  patientId,
  initial,
}: {
  /** Internal site id. Half of the note's identity, and of the session hide key. */
  siteId: string;
  /** Dentally patient id. */
  patientId: string;
  /** The server's own read of this patient's notes, so the first paint is final. */
  initial?: { ok: boolean; notes: PatientNote[] };
  /** Client slug, because the notes API is client-scoped. The hook reads it from the
   *  route, exactly as the notes panel always has; it stays in the signature so stage
   *  1's layout call site did not have to change. */
  clientSlug?: string;
}): React.ReactElement | null {
  // Keyed on the record, so every piece of per-patient state below (which notes are
  // hidden, whether the band is expanded) is discarded by React when the reader moves
  // to another patient, rather than being reset by an effect that has to remember to.
  return <Band key={`${siteId}:${patientId}`} siteId={siteId} patientId={patientId} initial={initial} />;
}

function Band({
  siteId,
  patientId,
  initial,
}: {
  siteId: string;
  patientId: string;
  initial?: { ok: boolean; notes: PatientNote[] };
}): React.ReactElement | null {
  const { notes, loading, failed, error, busyId, setPinned, setColour, setBody } = usePatientNotes(
    siteId,
    patientId,
    initial,
  );
  const [expanded, setExpanded] = useState(false);
  const [now] = useState(() => new Date());

  const key = hideKey(siteId, patientId);

  // Read once, on the first client render. Guarded because this component is rendered
  // from a server layout, where there is no window; the server render returns null
  // either way (nothing has loaded yet), so there is nothing for hydration to disagree
  // about.
  const [hidden, setHidden] = useState<string[]>(() => (typeof window === "undefined" ? [] : readHidden(key)));

  const persistHidden = useCallback(
    (ids: string[]) => {
      setHidden(ids);
      try {
        window.sessionStorage.setItem(key, JSON.stringify(ids));
      } catch {
        // A browser with session storage blocked still hides for this render. Losing
        // the preference is acceptable; failing the record is not.
      }
    },
    [key],
  );

  const pinned = useMemo(() => notes.filter((n) => n.pinnedAt), [notes]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = useMemo(() => pinned.filter((n) => !hiddenSet.has(n.id)), [pinned, hiddenSet]);
  const hiddenCount = pinned.length - visible.length;

  const { shown, plan } = splitPinnedBand(visible, { expanded });

  // With a server seed this is already false on the first paint, so the band is in
  // its final shape before hydration and nothing below it moves. Without one (the
  // quick view, which has no server pass of its own) the first paint is the same as
  // the commonest finished state: nothing.
  if (loading) return null;

  if (failed) {
    return (
      <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12.5px] text-status-amber">
        We could not read this patient&apos;s pinned notes just now. Open the Notes tab to try again, and check
        Dentally before treating this patient.
      </p>
    );
  }

  if (pinned.length === 0) return null;

  // plan.columns is HONOURED rather than collapsed into an auto-fit that ignores it:
  // auto-fit with a 280px minimum yields four tracks on a ~1200px content column, so
  // six notes rendered 4 + 2 while pin-layout.ts (and its test) said 3 + 3. Below sm
  // the cards stack, which is what auto-fit was really being used for.
  const columnStyle = { "--pin-cols": String(plan.columns) } as React.CSSProperties;

  return (
    <section aria-label="Pinned notes">
      <div className="max-h-[40vh] overflow-y-auto">
        {shown.length > 0 ? (
          <div
            className="grid grid-cols-1 gap-2 sm:[grid-template-columns:repeat(var(--pin-cols),minmax(0,1fr))]"
            style={columnStyle}
          >
            {shown.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                now={now}
                variant="band"
                clampLines={plan.clampLines}
                busy={busyId === note.id}
                onPin={(p) => void setPinned(note.id, p)}
                onColour={(c: NoteColour | null) => void setColour(note.id, c)}
                onSaveBody={(b) => setBody(note.id, b)}
                onHide={() => persistHidden([...hidden, note.id])}
              />
            ))}
          </div>
        ) : null}

        {/* One dense line carrying both volume controls. Sticky, so "N more" stays
            reachable once the band has hit its ceiling and started scrolling. */}
        <div className="sticky bottom-0 mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-cream/95 py-1">
          <div className="flex items-center gap-3">
            {plan.hidden > 0 || expanded ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1 rounded text-[11.5px] font-medium text-blue-dark hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
              >
                {expanded ? (
                  <>
                    <ChevronUp size={12} aria-hidden /> Show fewer
                  </>
                ) : (
                  <>
                    <ChevronDown size={12} aria-hidden /> {moreLabel(plan.hidden)}
                  </>
                )}
              </button>
            ) : null}
            {error ? <span className="text-[11.5px] text-danger">{error}</span> : null}
          </div>

          <div className="flex items-center gap-3">
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={() => persistHidden([])}
                className="inline-flex items-center gap-1 rounded text-[11.5px] font-medium text-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
              >
                <Eye size={12} aria-hidden /> Show hidden ({hiddenCount})
              </button>
            ) : null}
            {visible.length > 0 ? (
              <button
                type="button"
                onClick={() => persistHidden(pinned.map((n) => n.id))}
                className="inline-flex items-center gap-1 rounded text-[11.5px] font-medium text-muted hover:text-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
              >
                <EyeOff size={12} aria-hidden /> Hide all
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
