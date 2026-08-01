/**
 * The pinned-note colour vocabulary.
 *
 * PURE. No I/O. It is a named vocabulary rather than the diary's integer palette
 * slot because staff choose these by name ("the orange one"), because the observed
 * Dentally set is tiny, and because a named value is legible in the database when
 * somebody reads a row six months from now. The same six names are the check
 * constraint in migration 0064, and a test asserts the two lists cannot drift apart.
 *
 * THE EXECUTION CHANGE, and it is the only one. Dentally fills the whole card with a
 * saturated sticky-note colour, which is what makes five of them shout at once. Ours
 * renders the same user-chosen hue as a 3px rail down the left edge over a 6% tint of
 * itself on a white card. The colour stays instantly scannable; it stops being a wash.
 * A Dentally user still recognises a row of coloured cards along the top of the record.
 */

export const NOTE_COLOURS = ["yellow", "green", "orange", "blue", "pink", "grey"] as const;

export type NoteColour = (typeof NOTE_COLOURS)[number];

export function isNoteColour(value: unknown): value is NoteColour {
  return typeof value === "string" && (NOTE_COLOURS as readonly string[]).includes(value);
}

/** Shown on the swatch's accessible name, so a colour is choosable without sight of it. */
export const NOTE_COLOUR_LABEL: Record<NoteColour, string> = {
  yellow: "Yellow",
  green: "Green",
  orange: "Orange",
  blue: "Blue",
  pink: "Pink",
  grey: "Grey",
};

/**
 * The rail hue. Saturated enough to be told apart at a glance from two metres, which
 * is the diary's own test and applies here too: these are read across a room.
 */
export const NOTE_COLOUR_HEX: Record<NoteColour, string> = {
  yellow: "#c8961a",
  green: "#178a5b",
  orange: "#c96a1c",
  blue: "#16559a",
  pink: "#b4407a",
  grey: "#66748c",
};

/**
 * `rgba(r, g, b, a)` from a `#rrggbb`. Returns "transparent" for anything it cannot
 * parse, so a bad value renders a plain white card rather than throwing on a clinical
 * screen.
 */
export function tintFrom(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "transparent";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The card's tint: 6% of the rail hue. Enough to group, never enough to wash. */
export const NOTE_TINT_ALPHA = 0.06;

/**
 * The colour a card actually renders in.
 *
 * A note carries no colour until somebody picks one, and an uncoloured note in the
 * BAND still has to look like a sticky note or the band stops reading as Dentally's.
 * So an uncoloured pinned note falls back to yellow (Dentally's own default sticky),
 * and an uncoloured unpinned note stays plain: it is a line in a list, not a card on
 * a wall, and giving it a rail would imply a choice nobody made.
 */
export function effectiveColour(note: { colour: NoteColour | null; pinnedAt: string | null }): NoteColour | null {
  if (note.colour) return note.colour;
  return note.pinnedAt ? "yellow" : null;
}
