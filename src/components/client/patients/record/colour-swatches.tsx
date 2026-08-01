"use client";

import { Check } from "lucide-react";
import { NOTE_COLOURS, NOTE_COLOUR_HEX, NOTE_COLOUR_LABEL, type NoteColour } from "@/lib/patient-notes/colours";

/**
 * The note colour picker: six named swatches and a "no colour".
 *
 * Colour is the one thing Dentally's pinned notes carry that nothing else on the
 * record does, and staff use it as a private code (orange for money, green for a
 * medical caution, and so on). So the vocabulary is small, named and stable rather
 * than a colour wheel.
 *
 * Every swatch is a real button with an accessible name and a focus-visible ring: the
 * colour is a fact about the note, and a fact must be reachable without a mouse and
 * without sight of the hue.
 */
export function ColourSwatches({
  value,
  onChange,
  disabled,
}: {
  value: NoteColour | null;
  onChange: (colour: NoteColour | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Note colour">
      {NOTE_COLOURS.map((c) => {
        const selected = value === c;
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => onChange(c)}
            aria-label={NOTE_COLOUR_LABEL[c]}
            aria-pressed={selected}
            title={NOTE_COLOUR_LABEL[c]}
            style={{ backgroundColor: NOTE_COLOUR_HEX[c] }}
            className="flex h-5 w-5 items-center justify-center rounded-full ring-offset-1 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 disabled:opacity-50"
          >
            {selected ? <Check size={12} strokeWidth={3} className="text-white" /> : null}
          </button>
        );
      })}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(null)}
        aria-label="No colour"
        aria-pressed={value === null}
        title="No colour"
        className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-card text-muted transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 disabled:opacity-50"
      >
        {value === null ? <Check size={12} strokeWidth={3} /> : null}
      </button>
    </div>
  );
}
