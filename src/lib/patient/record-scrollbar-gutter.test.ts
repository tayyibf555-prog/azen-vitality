import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * THE RECORD SCROLLER RESERVES ITS SCROLLBAR GUTTER IN BOTH APP SHELLS.
 *
 * Measured in a real browser at 1920x1000: the patient record was 15-30px narrower
 * on tabs whose content is short enough to leave no vertical scrollbar than on tabs
 * long enough to grow one, because the scroller that owns the record's own vertical
 * scroll ("min-h-0 flex-1 ... lg:overflow-y-auto", app/c/[client]/layout.tsx line 81
 * and app/owner/[client]/layout.tsx line 44) only occupies the space a scrollbar
 * takes when a scrollbar is actually there. `scrollbar-gutter: stable` reserves that
 * space unconditionally, so the content column stops moving when a tab's height
 * crosses the scroll threshold.
 *
 * THE PROPERTY THIS FILE PINS is not "the scroller has some scrollbar-related class
 * somewhere" - it is that BOTH shells carry it on the SAME element, because a fix
 * applied to one tree and not the other is a class of failure this project has
 * already shipped (see record-width.test.ts). Reading source, in the node environment
 * vitest actually runs (see that same file for why: only src/**\/*.test.ts, no .tsx).
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SHELLS = [
  { name: "/c", path: resolve(SRC, "app/c/[client]/layout.tsx") },
  { name: "/owner", path: resolve(SRC, "app/owner/[client]/layout.tsx") },
] as const;

const read = (path: string) => readFileSync(path, "utf8");

/** The record scroller: the element that owns lg:overflow-y-auto for the tab content. */
function findScrollerLine(source: string): string | null {
  const line = source.split("\n").find((l) => l.includes("lg:overflow-y-auto"));
  return line ?? null;
}

describe("the record scroller reserves a stable scrollbar gutter in both app shells", () => {
  describe.each(SHELLS)("$name", (shell) => {
    const source = read(shell.path);

    it("still has the vertical scroller this fix depends on", () => {
      expect(
        source,
        `${shell.name} lost its lg:overflow-y-auto scroller - this file is checking the wrong element`,
      ).toContain("lg:overflow-y-auto");
    });

    it("puts scrollbar-gutter: stable on that exact scroller", () => {
      const line = findScrollerLine(source);
      expect(line, `${shell.name}: no line carries lg:overflow-y-auto`).not.toBeNull();
      // Tailwind v4 scans raw source, so the arbitrary value must appear literally -
      // not built from a template string or a shared constant - or Tailwind never
      // generates the utility and the class name in the DOM does nothing.
      expect(
        line,
        `${shell.name}: the scroller does not carry [scrollbar-gutter:stable] literally`,
      ).toContain("[scrollbar-gutter:stable]");
    });
  });

  it("keeps both shells in agreement - one tree fixed and the other forgotten reintroduces the twitch", () => {
    const results = SHELLS.map((shell) => {
      const line = findScrollerLine(read(shell.path));
      return line?.includes("[scrollbar-gutter:stable]") ?? false;
    });
    expect(
      results.every(Boolean),
      `scrollbar-gutter:stable is missing from at least one shell: ${SHELLS.map((s, i) => `${s.name}=${results[i]}`).join(", ")}`,
    ).toBe(true);
  });
});
