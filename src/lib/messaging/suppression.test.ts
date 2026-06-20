import { describe, it, expect } from "vitest";
import { isStopKeyword } from "./suppression";

describe("isStopKeyword", () => {
  it("matches the opt-out keywords case-insensitively and trimmed", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel", "END", "quit", "stopall"]) {
      expect(isStopKeyword(w)).toBe(true);
    }
  });
  it("does not match normal replies", () => {
    for (const w of ["yes please", "stop by tomorrow", "ok", ""]) {
      expect(isStopKeyword(w)).toBe(false);
    }
  });
});
