// ===========================================================================
// PALMER NOTATION, AND THE CONVERSION INTO FDI.
//
// PURE. No I/O, no React, no DOM.
//
// WHY THIS MODULE EXISTS. DENTALLY.md's correction block, verified against the
// API on 2026-08-01, states plainly: "All teeth are stored using Palmer
// notation." FDI appears nowhere in Dentally's documentation. The chart we draw
// is an FDI chart, so every tooth Dentally sends has to be converted, and a
// conversion that is off by one quadrant labels the CONTRALATERAL tooth. That
// is a wrong-site error, not a formatting preference, which is why the whole
// mapping lives here as one tested function rather than inline at the mapper.
//
// THE MAPPING, spelled out rather than derived, so a reader can check it:
//
//   PERMANENT (Palmer 1-8, counted outward from the midline)
//     UR -> FDI quadrant 1    upper right, the VIEWER'S LEFT
//     UL -> FDI quadrant 2    upper left
//     LL -> FDI quadrant 3    lower left
//     LR -> FDI quadrant 4    lower right
//
//   DECIDUOUS (Palmer A-E, counted outward from the midline)
//     UR -> FDI quadrant 5     A=51 (central incisor) .. E=55 (second molar)
//     UL -> FDI quadrant 6
//     LL -> FDI quadrant 7
//     LR -> FDI quadrant 8
//
// WHAT IS DELIBERATELY REFUSED. A bare 1-8 with no quadrant ("6") is a complete
// Palmer tooth number with the quadrant symbol lost in transport, and there are
// FOUR teeth it could name. Guessing one is exactly the contralateral error this
// module exists to prevent, so it is refused and the row goes to
// ChartRead.unplaced with the raw value shown. An unplaced count on screen is
// recoverable; a filling drawn on the wrong side of the mouth is not.
// ===========================================================================

/** Palmer's four quadrant codes, in the order a chart reader says them. */
export type PalmerQuadrant = "UR" | "UL" | "LL" | "LR";

const PERMANENT_QUADRANT: Record<PalmerQuadrant, number> = { UR: 1, UL: 2, LL: 3, LR: 4 };
const DECIDUOUS_QUADRANT: Record<PalmerQuadrant, number> = { UR: 5, UL: 6, LL: 7, LR: 8 };

/** A..E are the deciduous positions, counted outward from the midline exactly as
 *  1..8 are on the permanent dentition. */
const DECIDUOUS_LETTERS = "ABCDE";

function isQuadrant(raw: string): raw is PalmerQuadrant {
  return raw === "UR" || raw === "UL" || raw === "LL" || raw === "LR";
}

/**
 * One Palmer tooth ("UR6", "LLE") to its FDI number, or null when the value is
 * not a Palmer tooth we can place WITHOUT GUESSING.
 *
 * Tolerant of case and of internal spacing or punctuation, because a wire format
 * nobody in this repo has yet seen may well send "ur 6" or "UR-6". Not tolerant
 * of a missing quadrant: see the module banner.
 */
export function palmerToFdi(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  // Strip everything that is not a letter or a digit, so "UR-6", "ur 6" and
  // "UR6" are one value. A separator is presentation; the quadrant is not.
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 3) return null;

  const quadrant = cleaned.slice(0, 2);
  const position = cleaned.slice(2);
  if (!isQuadrant(quadrant)) return null;

  if (position >= "1" && position <= "8") {
    return PERMANENT_QUADRANT[quadrant] * 10 + Number(position);
  }
  const deciduous = DECIDUOUS_LETTERS.indexOf(position);
  if (deciduous >= 0) {
    return DECIDUOUS_QUADRANT[quadrant] * 10 + deciduous + 1;
  }
  return null;
}

/**
 * The inverse: an FDI number back to the Palmer string Dentally stores.
 *
 * Nothing in the shipped product sends a tooth TO Dentally, because Dentally
 * publishes no create route on any charting resource. This exists so the
 * conversion can be round-trip tested across all fifty-two teeth, which is the
 * only way to prove no quadrant is transposed, and so that a future write path
 * has one place to call rather than a second hand-written table.
 */
export function fdiToPalmer(fdi: number): string | null {
  const quadrantDigit = Math.floor(fdi / 10);
  const position = fdi % 10;
  const permanent = (Object.keys(PERMANENT_QUADRANT) as PalmerQuadrant[]).find(
    (q) => PERMANENT_QUADRANT[q] === quadrantDigit,
  );
  if (permanent) {
    return position >= 1 && position <= 8 ? `${permanent}${position}` : null;
  }
  const deciduous = (Object.keys(DECIDUOUS_QUADRANT) as PalmerQuadrant[]).find(
    (q) => DECIDUOUS_QUADRANT[q] === quadrantDigit,
  );
  if (deciduous) {
    return position >= 1 && position <= 5
      ? `${deciduous}${DECIDUOUS_LETTERS[position - 1]}`
      : null;
  }
  return null;
}
