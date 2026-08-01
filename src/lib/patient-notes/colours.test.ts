import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { NOTE_COLOURS, NOTE_COLOUR_HEX, NOTE_COLOUR_LABEL, effectiveColour, isNoteColour, tintFrom } from "./colours";

/**
 * The picker and the database must agree. A colour the picker offers but the check
 * constraint refuses turns a one-click recolour into a 500 on a clinical record, and
 * a colour the constraint allows but the picker never offers is dead schema.
 */
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/0064_patient_note_pinning.sql", import.meta.url)),
  "utf8",
);

describe("note colour vocabulary", () => {
  it("matches migration 0064's check constraint exactly", () => {
    const m = /colour in \(([^)]*)\)/.exec(MIGRATION);
    expect(m, "0064 must carry a colour check constraint").not.toBeNull();
    const inSql = [...(m as RegExpExecArray)[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect([...inSql].sort()).toEqual([...NOTE_COLOURS].sort());
  });

  it("labels and hues every colour, so nothing renders unnamed or invisible", () => {
    for (const c of NOTE_COLOURS) {
      expect(NOTE_COLOUR_LABEL[c]).toBeTruthy();
      expect(NOTE_COLOUR_HEX[c]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("rejects anything outside the vocabulary", () => {
    expect(isNoteColour("yellow")).toBe(true);
    expect(isNoteColour("puce")).toBe(false);
    expect(isNoteColour(null)).toBe(false);
    expect(isNoteColour(3)).toBe(false);
  });
});

describe("tintFrom", () => {
  it("mixes a hex down to an alpha", () => {
    expect(tintFrom("#16559a", 0.06)).toBe("rgba(22, 85, 154, 0.06)");
  });

  it("returns transparent rather than throwing on a bad value", () => {
    expect(tintFrom("nonsense", 0.06)).toBe("transparent");
  });

  it("clamps the alpha", () => {
    expect(tintFrom("#000000", 5)).toBe("rgba(0, 0, 0, 1)");
    expect(tintFrom("#000000", -1)).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("effectiveColour", () => {
  it("uses whatever the user chose", () => {
    expect(effectiveColour({ colour: "green", pinnedAt: null })).toBe("green");
  });

  it("falls back to yellow for a pinned note nobody has coloured", () => {
    expect(effectiveColour({ colour: null, pinnedAt: "2026-07-01T09:00:00Z" })).toBe("yellow");
  });

  it("leaves an uncoloured unpinned note plain, implying no choice nobody made", () => {
    expect(effectiveColour({ colour: null, pinnedAt: null })).toBeNull();
  });
});
