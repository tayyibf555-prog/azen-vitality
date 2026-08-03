import { describe, it, expect } from "vitest";
import { fdiToPalmer, palmerToFdi } from "./palmer";
import { DECIDUOUS_LOWER, DECIDUOUS_UPPER, PERMANENT_LOWER, PERMANENT_UPPER } from "./fdi";

/**
 * DENTALLY.md's correction says the conversion "must be a pure, exhaustively
 * tested function covering all 32 permanent and all 20 deciduous teeth", and it
 * says so because an off-by-one-quadrant conversion names the contralateral
 * tooth. So the round trip below is not a sample: it is all fifty-two.
 */
const ALL_TEETH = [...PERMANENT_UPPER, ...PERMANENT_LOWER, ...DECIDUOUS_UPPER, ...DECIDUOUS_LOWER];

describe("Palmer to FDI", () => {
  it("puts each permanent quadrant on the right side of the mouth", () => {
    // The four corners. If any pair of these is transposed the whole arch is
    // mirrored, which is the error the module exists to prevent.
    expect(palmerToFdi("UR6")).toBe(16);
    expect(palmerToFdi("UL6")).toBe(26);
    expect(palmerToFdi("LL6")).toBe(36);
    expect(palmerToFdi("LR6")).toBe(46);
    expect(palmerToFdi("UR1")).toBe(11);
    expect(palmerToFdi("LR8")).toBe(48);
  });

  it("reads the deciduous letters A to E as positions one to five", () => {
    expect(palmerToFdi("URA")).toBe(51);
    expect(palmerToFdi("URE")).toBe(55);
    expect(palmerToFdi("ULA")).toBe(61);
    expect(palmerToFdi("LLC")).toBe(73);
    expect(palmerToFdi("LRE")).toBe(85);
  });

  it("tolerates case and separators, because the wire format has never been seen", () => {
    expect(palmerToFdi("ur6")).toBe(16);
    expect(palmerToFdi("UR-6")).toBe(16);
    expect(palmerToFdi(" ur 6 ")).toBe(16);
    expect(palmerToFdi("lLe")).toBe(75);
  });

  it("REFUSES a tooth number with no quadrant, rather than guessing one of four", () => {
    // The whole point. "6" is UR6, UL6, LL6 or LR6, and picking one is exactly
    // the contralateral error. Refused, so the row lands in unplaced with its
    // raw value visible instead of being drawn on the wrong side of the mouth.
    expect(palmerToFdi("6")).toBeNull();
    expect(palmerToFdi("E")).toBeNull();
    expect(palmerToFdi("R6")).toBeNull();
    expect(palmerToFdi("U6")).toBeNull();
  });

  it("refuses positions that do not exist and shapes it cannot read", () => {
    expect(palmerToFdi("UR9")).toBeNull();
    expect(palmerToFdi("UR0")).toBeNull();
    expect(palmerToFdi("URF")).toBeNull();
    expect(palmerToFdi("XX6")).toBeNull();
    expect(palmerToFdi("UR66")).toBeNull();
    expect(palmerToFdi(16)).toBeNull();
    expect(palmerToFdi(null)).toBeNull();
    expect(palmerToFdi(undefined)).toBeNull();
  });
});

describe("FDI back to Palmer", () => {
  it("round-trips all 32 permanent and all 20 deciduous teeth", () => {
    expect(ALL_TEETH).toHaveLength(52);
    for (const fdi of ALL_TEETH) {
      const palmer = fdiToPalmer(fdi);
      expect(palmer, `no Palmer form for FDI ${fdi}`).not.toBeNull();
      expect(palmerToFdi(palmer as string), `FDI ${fdi} did not round-trip`).toBe(fdi);
    }
  });

  it("produces the letters on the deciduous dentition and the digits on the permanent", () => {
    expect(fdiToPalmer(16)).toBe("UR6");
    expect(fdiToPalmer(38)).toBe("LL8");
    expect(fdiToPalmer(55)).toBe("URE");
    expect(fdiToPalmer(81)).toBe("LRA");
  });

  it("returns null for a number that is not a tooth position", () => {
    expect(fdiToPalmer(19)).toBeNull();
    expect(fdiToPalmer(56)).toBeNull();
    expect(fdiToPalmer(99)).toBeNull();
    expect(fdiToPalmer(0)).toBeNull();
  });
});
