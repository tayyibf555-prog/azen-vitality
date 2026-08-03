// ===========================================================================
// FDI NUMBERING AND ARCH COMPOSITION.
//
// PURE. No I/O, no React, no DOM.
//
// THE ORIENTATION RULE, and it is the reason this module is tested rather than
// written inline: the arch is drawn AS THE CLINICIAN FACES THE PATIENT. So
// quadrant 1, the patient's UPPER RIGHT, sits on the VIEWER'S LEFT, and the R
// marker goes at that end of the row. Mirroring the rows is not a cosmetic
// slip; it marks the wrong side of the mouth.
//
// THE COUNTS: the permanent dentition is 32 teeth, eight per quadrant. The
// primary dentition is TWENTY teeth, FIVE per quadrant, ten per row. An earlier
// draft of this spec said sixteen, and an implementer trimming these arrays to
// satisfy a wrong count produces a mis-numbered deciduous chart.
// ===========================================================================

import { palmerToFdi } from "./palmer";
import type { Dentition } from "./types";

export const PERMANENT_UPPER: readonly number[] = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
];
export const PERMANENT_LOWER: readonly number[] = [
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
];
export const DECIDUOUS_UPPER: readonly number[] = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65];
export const DECIDUOUS_LOWER: readonly number[] = [85, 84, 83, 82, 81, 71, 72, 73, 74, 75];

const ALL_TEETH: ReadonlySet<number> = new Set([
  ...PERMANENT_UPPER,
  ...PERMANENT_LOWER,
  ...DECIDUOUS_UPPER,
  ...DECIDUOUS_LOWER,
]);

/**
 * The rows this view draws, top to bottom.
 *
 * "combined" draws all four, because a mixed-dentition child whose chart shows
 * half its findings is the failure the preference exists to prevent. "base"
 * draws all four for the same reason: a base chart carries no dentition of its
 * own, so guessing one would hide the other.
 */
export function archRows(dentition: Dentition): readonly (readonly number[])[] {
  if (dentition === "deciduous") return [DECIDUOUS_UPPER, DECIDUOUS_LOWER];
  if (dentition === "permanent") return [PERMANENT_UPPER, PERMANENT_LOWER];
  return [PERMANENT_UPPER, DECIDUOUS_UPPER, DECIDUOUS_LOWER, PERMANENT_LOWER];
}

/** 1-8. The first digit of the FDI number. */
export function quadrantOf(fdi: number): number {
  return Math.floor(fdi / 10);
}

/** The second digit: what Dentally prints in the strip above and below the arch.
 *  8..1 | 1..8 on the permanent dentition, 5..1 | 1..5 on the deciduous. */
export function displayNumber(fdi: number): number {
  return fdi % 10;
}

/** The PATIENT'S side. Quadrants 1, 4, 5 and 8 are the patient's right, and the
 *  right is drawn on the viewer's LEFT. */
export function sideOf(fdi: number): "right" | "left" {
  const q = quadrantOf(fdi);
  return q === 1 || q === 4 || q === 5 || q === 8 ? "right" : "left";
}

export function archOf(fdi: number): "upper" | "lower" {
  const q = quadrantOf(fdi);
  return q === 1 || q === 2 || q === 5 || q === 6 ? "upper" : "lower";
}

export function isDeciduous(fdi: number): boolean {
  const q = quadrantOf(fdi);
  return q >= 5 && q <= 8;
}

/** "UR6". The notation a dentist writes and speaks.
 *
 *  The deciduous teeth use their FDI position digit (UR5..UR1) rather than the
 *  Palmer letters A..E: DENTALLY.md prints a 5..1 number strip on the deciduous
 *  arch, and inventing a second notation over the top of the reference is the
 *  kind of drift this screen exists to avoid. */
export function toothLabel(fdi: number): string {
  return `${archOf(fdi) === "upper" ? "U" : "L"}${sideOf(fdi) === "right" ? "R" : "L"}${displayNumber(fdi)}`;
}

/** "upper right 6", for the aria-label and the tooltip header. Spoken in full
 *  because "UR6" read aloud by a screen reader is three letters and a number. */
export function toothLongLabel(fdi: number): string {
  return `${archOf(fdi)} ${sideOf(fdi)} ${displayNumber(fdi)}`;
}

/** The two-digit FDI number itself. It travels with every label because
 *  reconciling this chart against Dentally is the screen's whole purpose. */
export function fdiLabel(fdi: number): string {
  return String(fdi);
}

/** True when this view actually draws that tooth. The reducer refuses to chart
 *  a tooth the clinician cannot see. */
export function isInArch(fdi: number, dentition: Dentition): boolean {
  return archRows(dentition).some((row) => row.includes(fdi));
}

/** True for a real FDI position: quadrants 1-4 hold eight teeth, 5-8 hold five. */
export function isTooth(fdi: number): boolean {
  return ALL_TEETH.has(fdi);
}

export interface ParsedTeeth {
  teeth: number[];
  /** True when a value WAS present and some part of it could not be read as a
   *  tooth. An ABSENT value is not a parse failure: see the note below. */
  unparsed: boolean;
  /** True when the field held nothing at all. A hygiene appointment, an
   *  examination, a radiograph or a denture legitimately names no tooth, and on
   *  a real chart those are the majority of rows. Reporting them as failures put
   *  "some treatment items name teeth this platform could not read" on every
   *  patient and filed ordinary treatment under "could not place". */
  absent: boolean;
}

/**
 * Dentally's `teeth` field, in whatever shape it arrives.
 *
 * TEETH ARRIVE IN PALMER NOTATION. DENTALLY.md's correction block, verified
 * against the API on 2026-08-01, states it plainly: "All teeth are stored using
 * Palmer notation", and FDI appears nowhere in Dentally's documentation. So
 * "UR6" and "LLE" are the shapes to expect, and they are converted by
 * palmer.ts, which refuses a quadrant-less number rather than guessing one of
 * the four teeth it could name.
 *
 * A TWO-DIGIT NUMBER IS STILL READ AS FDI, and that is an assumption with a name
 * on it. Palmer has no two-digit form, so a value in 11-48 or 51-85 is either an
 * FDI number or a shape nobody in this repo has seen. Accepting it keeps the
 * mock and any FDI-shaped payload working; if live data turns out to encode
 * Palmer quadrants as digits in a DIFFERENT order, this line marks the
 * contralateral tooth, so it must be confirmed against a real charted patient
 * before anyone treats from this screen. It is listed as an open risk.
 *
 * AND IT REPORTS WHAT IT COULD NOT READ. Returning a bare empty array would
 * render on screen as "this item concerns no teeth", which is a claim about a
 * patient. `unparsed` is what puts the row in ChartRead.unplaced with a visible
 * count instead, and `absent` is what keeps a legitimate non-tooth treatment out
 * of that count.
 */
export function parseTeeth(raw: unknown): ParsedTeeth {
  const tokens: string[] = [];
  let unreadableShape = false;
  if (typeof raw === "number") tokens.push(String(raw));
  else if (typeof raw === "string") tokens.push(...raw.split(/[,;\s]+/));
  else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (typeof part === "number") tokens.push(String(part));
      else if (typeof part === "string") tokens.push(...part.split(/[,;\s]+/));
      else {
        // An object or a boolean inside the array: something was there and we
        // cannot read it, which is a failure rather than an absence.
        unreadableShape = true;
      }
    }
  } else if (raw !== null && raw !== undefined) {
    // An object, a boolean: a shape we have no reading of at all.
    unreadableShape = true;
  }

  const meaningful = tokens.filter((t) => t.trim().length > 0);
  const teeth: number[] = [];
  let unparsed = unreadableShape;
  for (const token of meaningful) {
    const trimmed = token.trim();
    const palmer = palmerToFdi(trimmed);
    if (palmer !== null) {
      if (!teeth.includes(palmer)) teeth.push(palmer);
      continue;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && isTooth(n)) {
      if (!teeth.includes(n)) teeth.push(n);
    } else {
      unparsed = true;
    }
  }
  return { teeth, unparsed, absent: meaningful.length === 0 && !unreadableShape };
}

/** The form we send back to our own draft table. Never sent to Dentally. */
export function serialiseTeeth(teeth: readonly number[]): string {
  return teeth.join(",");
}
