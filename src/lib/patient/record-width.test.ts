import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PATIENT_TAB_SLUGS } from "./tabs";

/**
 * THE PATIENT RECORD IS ONE WIDTH, ON EVERY TAB, IN BOTH ROUTE TREES.
 *
 * This exists because of a shipped, owner-reported bug. The app shells cap their main
 * column at max-w-[1400px] and drop the cap on has-[[data-wide]]. For a while the ONLY
 * thing setting data-wide was chart-workspace.tsx - one tab out of eleven. So the Chart
 * tab ran full-bleed and Details, Medical, Appointments, Recalls, Notes, Account, Perio,
 * Correspondence, Tasks and Audit stayed capped and centred. And because the marker is
 * read by a :has() on an ancestor of the whole record, what resized was not the panel:
 * it was the record - header, patient name, pinned-notes band and tab strip included.
 * Clicking a tab moved the chrome.
 *
 * THE PROPERTY THIS FILE PINS is not "the marker exists somewhere". It is:
 *
 *     no tab is capped while another is not.
 *
 * The only structure that gives you that is a marker owned by the RECORD - set on an
 * element that wraps PatientRecordShell, which is rendered from the layout that wraps
 * every tab URL. A marker set inside any single tab's component cannot give it, because
 * a tab is by definition one of eleven. So the assertions below are structural, not
 * textual: the marker must open before the shell and close after it, it must be
 * unconditional, and it must be present in BOTH trees.
 *
 * WHY A SOURCE-READING NODE TEST. vitest here collects only src/-slash-star-star/*.test.ts in
 * the node environment and no .tsx at all, so there is no renderer to measure a width
 * with. Reading source is the strongest instrument available, and it is pointed at the
 * structural facts rather than at a class string, so it survives restyling.
 *
 * Paths are resolved from import.meta.url so this never walks .claude/worktrees, which
 * are full repo copies and would match duplicate files.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The two route trees. Both render the SAME PatientRecordShell under the SAME cap. */
const TREES = [
  {
    name: "/c",
    appLayout: resolve(SRC, "app/c/[client]/layout.tsx"),
    recordLayout: resolve(SRC, "app/c/[client]/patients/[id]/layout.tsx"),
    recordDir: resolve(SRC, "app/c/[client]/patients/[id]"),
  },
  {
    name: "/owner",
    appLayout: resolve(SRC, "app/owner/[client]/layout.tsx"),
    recordLayout: resolve(SRC, "app/owner/[client]/patients/[id]/layout.tsx"),
    recordDir: resolve(SRC, "app/owner/[client]/patients/[id]"),
  },
] as const;

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Every attribute the app shell will drop its cap for, taken from the shell itself
 * rather than hardcoded here, so renaming a marker on one side only is a failure and
 * not a silent no-op.
 *
 * There are two, and they are NOT interchangeable. data-diary is the calendar's, and
 * it drags space-y-0 and an lg:h-full two-axis scroller along with it; data-wide is
 * width and nothing else. The record must take the width one.
 */
function escapeHatchAttributes(appLayoutSource: string): string[] {
  return [...appLayoutSource.matchAll(/has-\[\[([a-z-]+)\]\]:max-w-none/g)].map((m) => m[1]);
}

/** Which of the shell's hatches this record layout actually opens. */
function markerUsedByRecord(recordSource: string, hatches: string[]) {
  const found = hatches
    .map((attr) => ({ attr, el: bareMarkerElement(recordSource, attr) }))
    .filter((x) => x.el !== null);
  return found.length === 1 ? { attr: found[0].attr, ...(found[0].el as { tag: string; at: number }) } : null;
}

/**
 * Locate a BARE marker attribute and the element carrying it.
 *
 * Bare is load-bearing. `data-wide={slug === "chart"}` would type-check, render, and
 * reinstate exactly the bug this file exists to prevent - a width that depends on which
 * tab you are looking at - so a marker with a value is not found at all.
 */
function bareMarkerElement(source: string, attr: string): { tag: string; at: number } | null {
  const re = new RegExp(`<([A-Za-z][\\w.]*)\\s+${attr}(?=\\s|/?>)`);
  const m = re.exec(source);
  return m ? { tag: m[1], at: m.index } : null;
}

describe("the patient record keeps one width across all eleven tabs", () => {
  describe.each(TREES)("$name", (tree) => {
    const app = read(tree.appLayout);
    const record = read(tree.recordLayout);

    it("still caps its main column, and still has an escape hatch - otherwise this file is vacuous", () => {
      // Tailwind v4 scans RAW SOURCE, so both of these must appear literally. If the
      // cap is gone the record is full-bleed by accident and the rest of these
      // assertions prove nothing; if the hatch is gone the marker below is inert.
      expect(app, `${tree.name} lost its max-w-[1400px] cap`).toContain("max-w-[1400px]");
      expect(app, `${tree.name} lost has-[[data-wide]]:max-w-none`).toContain(
        "has-[[data-wide]]:max-w-none",
      );
    });

    const hatches = escapeHatchAttributes(app);

    it("opens exactly one of the shell's escape hatches, and it is the width-only one", () => {
      expect(hatches.length, `${tree.name} has no has-[[...]]:max-w-none to read an attribute from`).toBeGreaterThan(0);
      const marker = markerUsedByRecord(record, hatches);
      expect(marker, `${tree.name} record layout opens none of ${hatches.join("/")}, or more than one`).not.toBeNull();
      // data-diary is the calendar's marker and carries a two-axis scroller with it.
      // A record wearing it loses its own vertical scroll and its spacing.
      expect((marker as { attr: string }).attr).toBe("data-wide");
    });

    it("sets the marker at the RECORD level - opening before the shell and closing after it", () => {
      // THE CENTRAL ASSERTION. This is what fails if the marker is moved back down
      // into a single tab, or sideways onto an element that is not an ancestor of
      // the record: a marker that does not enclose PatientRecordShell does not
      // enclose the header, the tab strip, or the other ten tabs.
      const marker = markerUsedByRecord(record, hatches);
      expect(marker, `${tree.name} record layout has no bare width marker`).not.toBeNull();
      const { tag, at } = marker as { tag: string; at: number };

      const shellOpen = record.indexOf("<PatientRecordShell");
      const shellClose = record.indexOf("</PatientRecordShell>");
      expect(shellOpen, `${tree.name} record layout no longer renders PatientRecordShell`).toBeGreaterThan(-1);
      expect(shellClose).toBeGreaterThan(shellOpen);

      expect(at, `${tree.name}: the marker is set after the shell opens, so it cannot wrap it`).toBeLessThan(
        shellOpen,
      );
      const markerClose = record.lastIndexOf(`</${tag}>`);
      expect(
        markerClose,
        `${tree.name}: the <${tag}> carrying the marker closes before the shell does, so it does not wrap the record`,
      ).toBeGreaterThan(shellClose);
    });

    it("sets the marker unconditionally, so the width cannot depend on which tab is open", () => {
      // A conditional marker is the width jump wearing a different hat.
      for (const attr of hatches) {
        expect(
          record.includes(`${attr}=`),
          `${tree.name}: ${attr} is given a value; a marker whose presence can vary re-opens the jump`,
        ).toBe(false);
      }
    });

    it("wraps every tab URL from that one layout, so all eleven tabs inherit the width", () => {
      // The layout is only the record's ancestor for tabs routed BENEATH it. The
      // default tab is page.tsx and the other ten are [tab]/page.tsx; a tab lifted
      // out to a sibling segment would escape the marker and start jumping again.
      expect(existsSync(resolve(tree.recordDir, "page.tsx"))).toBe(true);
      expect(existsSync(resolve(tree.recordDir, "[tab]", "page.tsx"))).toBe(true);
      for (const slug of PATIENT_TAB_SLUGS) {
        expect(
          existsSync(resolve(tree.recordDir, slug)),
          `${tree.name}: ${slug} has its own route segment beside the record layout instead of going through [tab]`,
        ).toBe(false);
      }
    });

    it("has no loading.tsx anywhere under the record, which once killed every button on the page", () => {
      // A streamed loading.tsx under this exact route left authed pages unhydrated
      // and every button on them dead (commit feb8677). Named here because this is
      // the file a width fix touches.
      for (const dir of [tree.recordDir, resolve(tree.recordDir, "[tab]")]) {
        expect(existsSync(resolve(dir, "loading.tsx")), `${dir} has a loading.tsx`).toBe(false);
      }
    });
  });

  it("keeps the two trees identical in how they escape the cap", () => {
    // A module wired into /c and not /owner is a class of failure this project has
    // already shipped. Both shells must key on the same attribute and both records
    // must set it on the same kind of element.
    const hatchSets = TREES.map((t) => escapeHatchAttributes(read(t.appLayout)).join(","));
    expect(new Set(hatchSets).size, `the shells key on different attributes: ${hatchSets.join(" vs ")}`).toBe(1);

    const markers = TREES.map((t) =>
      markerUsedByRecord(read(t.recordLayout), escapeHatchAttributes(read(t.appLayout))),
    );
    expect(
      markers.every((m) => m !== null),
      "one tree's record layout does not carry the marker at all - that tree still jumps width between tabs",
    ).toBe(true);
    const shapes = markers.map((m) => `${(m as { tag: string }).tag}[${(m as { attr: string }).attr}]`);
    expect(new Set(shapes).size, `the trees mark the record differently: ${shapes.join(" vs ")}`).toBe(1);
  });

  it("does not depend on any single tab's component to set the marker", () => {
    // The chart tab still sets its own data-wide and that is fine - the has-[]
    // selector only asks whether ANY descendant carries it, so the two are
    // idempotent. What must never again be true is that a TAB is the only carrier.
    // Deleting every component-level marker must leave the record's width unchanged,
    // which is exactly what "both record layouts carry it" means.
    for (const tree of TREES) {
      const hatches = escapeHatchAttributes(read(tree.appLayout));
      expect(
        markerUsedByRecord(read(tree.recordLayout), hatches),
        `${tree.name}: the record's width is delegated to whatever tab happens to set the marker`,
      ).not.toBeNull();
    }
  });
});
