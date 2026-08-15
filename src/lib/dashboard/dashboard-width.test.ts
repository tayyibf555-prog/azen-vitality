import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * THE DASHBOARD TAKES THE VIEWPORT. NOTHING ELSE ON THE PAGE DOES.
 *
 * The practice dashboard is a Dentally-shaped instrument - a five-cell takings strip,
 * a four-panel band, a day list - and the owner's verdict on it was that it "floats in
 * white space at a smaller scale" than Dentally's. It does: both app shells cap their
 * main column at max-w-[1400px], so on a 1920 reception monitor the band throws away
 * 388px and on a 2560 one it throws away over a thousand.
 *
 * The shells already have the escape hatch the diary and the tooth chart use, and it
 * is width and nothing else: has-[[data-wide]]:max-w-none. But :has() matches ANY
 * descendant, so a marker set anywhere in the main column un-caps the WHOLE column -
 * and on /owner the column also holds the task queue, the Management header, the
 * systems catalogue and the owner stat row. Un-capping those was never asked for: a
 * 2500px-wide line of body copy is not a better owner console, it is an unreadable one.
 *
 * THE PROPERTY THIS FILE PINS is therefore not "the dashboard is wide". It is:
 *
 *     the dashboard, and only the dashboard, escapes the cap - in both route trees.
 *
 * which is a structure, not a class string: a bare marker on the page wrapper, the
 * dashboard rendered directly inside it, and every other child re-capped by a wrapper
 * of its own. Assertions below are index arithmetic over the source for that reason.
 *
 * IT ALSO PINS THE BLEED, because full-bleed made an existing bug visible. The takings
 * strip and the band both pull themselves out of the page gutter with a hardcoded
 * -mx-4 while the gutter is px-4 sm:px-5 lg:px-6 - so at lg they stopped 8px short of
 * the edge on each side, despite the strip's own comment claiming the cells reach it.
 * The expected values are DERIVED FROM THE SHELL's padding here rather than written
 * down, so changing the gutter and forgetting the bleed fails instead of drifting.
 *
 * AND IT PINS WHAT THE WIDTH IS SPENT ON. PRODUCT.md:62 - "Removing chrome is not the
 * same as removing information... never a sparser screen than Dentally's". Width taken
 * and left as margin is the failure mode this whole change is one edit away from, so
 * the appointment list must give the receptionist's note its own column at the widths
 * where there is room for one.
 *
 * WHY A SOURCE-READING NODE TEST. vitest here collects only src/-star-star/*.test.ts in
 * the node environment and no .tsx at all, so there is no renderer to measure a width
 * with. Reading source is the strongest instrument available, and it is pointed at
 * structure rather than at styling. Paths are resolved from import.meta.url so this
 * never walks .claude/worktrees, which are full repo copies and would match duplicates.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The two route trees. Both render the SAME PracticeDashboard under the SAME cap. */
const TREES = [
  {
    name: "/c",
    appLayout: resolve(SRC, "app/c/[client]/layout.tsx"),
    page: resolve(SRC, "app/c/[client]/page.tsx"),
  },
  {
    name: "/owner",
    appLayout: resolve(SRC, "app/owner/[client]/layout.tsx"),
    page: resolve(SRC, "app/owner/[client]/page.tsx"),
  },
] as const;

const DASHBOARD_DIR = resolve(SRC, "components/client/dashboard");
const PRACTICE_DASHBOARD = resolve(DASHBOARD_DIR, "practice-dashboard.tsx");
const TAKINGS_STRIP = resolve(DASHBOARD_DIR, "takings-strip.tsx");
const APPOINTMENT_LIST = resolve(DASHBOARD_DIR, "appointment-list.tsx");

/** The re-cap the non-dashboard children of both pages must wear, character for character. */
const RECAP = 'className="mx-auto max-w-[1400px] space-y-4"';

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Source with block and line comments removed.
 *
 * Only needed where the assertion is "this file does NOT do X": practice-dashboard.tsx
 * explains at length WHY the marker is not set there, and prose about a marker is not
 * a marker. Everywhere else the raw source is read, because Tailwind v4 scans raw
 * source too and a class that only exists in a comment does not exist at all.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every attribute the app shell will drop its cap for, taken from the shell itself
 * rather than hardcoded here, so renaming a marker on one side only is a failure and
 * not a silent no-op. There are two and they are NOT interchangeable: data-diary is
 * the calendar's and drags space-y-0 and an lg:h-full two-axis scroller with it;
 * data-wide is width and nothing else. The dashboard must take the width one.
 */
function escapeHatchAttributes(appLayoutSource: string): string[] {
  return [...appLayoutSource.matchAll(/has-\[\[([a-z-]+)\]\]:max-w-none/g)].map((m) => m[1]);
}

/**
 * Locate a BARE marker attribute and the element carrying it.
 *
 * Bare is load-bearing. `data-wide={somethingConditional}` would type-check, render,
 * and make the page's width depend on state - the exact class of defect the patient
 * record already shipped once - so a marker with a value is not found at all.
 */
function bareMarkerElement(source: string, attr: string): { tag: string; at: number } | null {
  const re = new RegExp(`<([A-Za-z][\\w.]*)\\s+${attr}(?=\\s|/?>)`);
  const m = re.exec(source);
  return m ? { tag: m[1], at: m.index } : null;
}

/** Which of the shell's hatches this page actually opens, when it opens exactly one. */
function markerUsedByPage(pageSource: string, hatches: string[]) {
  const found = hatches
    .map((attr) => ({ attr, el: bareMarkerElement(pageSource, attr) }))
    .filter((x) => x.el !== null);
  return found.length === 1
    ? { attr: found[0].attr, ...(found[0].el as { tag: string; at: number }) }
    : null;
}

/** The className of the shell's capped main column. */
function cappedColumnClasses(appLayoutSource: string): string {
  const m = /className="([^"]*max-w-\[1400px\][^"]*)"/.exec(appLayoutSource);
  if (!m) throw new Error("the shell no longer has a max-w-[1400px] column to read");
  return m[1];
}

/**
 * The page gutter, as breakpoint-prefixed px- utilities, in source order.
 * "px-4 sm:px-5 lg:px-6" -> [["", "4"], ["sm:", "5"], ["lg:", "6"]]
 */
function gutterSteps(classes: string): [string, string][] {
  return [...classes.matchAll(/(?:^|\s)((?:[a-z0-9]+:)?)px-(\d+)(?=\s|$)/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
}

/** The negative margin that exactly cancels a gutter step: sm:px-5 -> sm:-mx-5. */
const bleedFor = ([prefix, step]: [string, string]) => `${prefix}-mx-${step}`;
/** The inner padding that puts a cell's text back on the content edge: sm:px-5. */
const padFor = ([prefix, step]: [string, string]) => `${prefix}px-${step}`;

/**
 * The double-quoted string literal containing `needle` - a class string, located by
 * something in it that is not the thing being asserted.
 *
 * Reading the LITERAL rather than the file matters. A first draft of the padding
 * assertion below searched the whole file for "sm:px-5" and passed against a
 * deliberately broken cell, because the comment ABOVE the cell quotes the gutter it
 * is supposed to match. Comments are stripped and the search is scoped for that
 * reason: an assertion a comment can satisfy is an assertion about comments.
 */
function quotedStringContaining(source: string, needle: string): string {
  const code = codeOnly(source);
  const at = code.indexOf(needle);
  if (at === -1) throw new Error(`no class string carrying "${needle}"`);
  const open = code.lastIndexOf('"', at);
  const close = code.indexOf('"', at);
  if (open === -1 || close === -1) throw new Error(`"${needle}" is not inside a string literal`);
  return code.slice(open + 1, close);
}

describe("the dashboard takes the viewport and nothing else on the page does", () => {
  describe.each(TREES)("$name", (tree) => {
    const app = read(tree.appLayout);
    const page = read(tree.page);

    it("still caps its main column, and still has a width-only escape hatch - otherwise this file is vacuous", () => {
      // Tailwind v4 scans RAW SOURCE, so both must appear literally. If the cap is
      // gone the dashboard is wide by accident and everything below proves nothing;
      // if the hatch is gone the marker is inert and the dashboard is still boxed.
      expect(app, `${tree.name} lost its max-w-[1400px] cap`).toContain("max-w-[1400px]");
      expect(app, `${tree.name} lost has-[[data-wide]]:max-w-none`).toContain(
        "has-[[data-wide]]:max-w-none",
      );
    });

    const hatches = escapeHatchAttributes(app);

    it("opens exactly one of the shell's escape hatches, and it is the width-only one", () => {
      expect(
        hatches.length,
        `${tree.name} has no has-[[...]]:max-w-none to read an attribute from`,
      ).toBeGreaterThan(0);
      const marker = markerUsedByPage(page, hatches);
      expect(
        marker,
        `${tree.name} home page opens none of ${hatches.join("/")}, or more than one`,
      ).not.toBeNull();
      // data-diary would drag the calendar's space-y-0 and its two-axis scroller in,
      // and the dashboard's own vertical rhythm would go with them.
      expect((marker as { attr: string }).attr).toBe("data-wide");
    });

    it("sets the marker unconditionally, so the dashboard's width cannot depend on state", () => {
      for (const attr of hatches) {
        expect(
          page.includes(`${attr}=`),
          `${tree.name}: ${attr} is given a value; a marker whose presence can vary makes the page jump width`,
        ).toBe(false);
      }
    });

    it("wraps the dashboard in the marker - opening before it and closing after it", () => {
      const marker = markerUsedByPage(page, hatches);
      expect(marker, `${tree.name} home page has no bare width marker`).not.toBeNull();
      const { tag, at } = marker as { tag: string; at: number };

      const dashboardAt = page.indexOf("<PracticeDashboard");
      expect(dashboardAt, `${tree.name} home page no longer renders PracticeDashboard`).toBeGreaterThan(-1);
      expect(
        at,
        `${tree.name}: the marker is set after the dashboard, so it cannot wrap it`,
      ).toBeLessThan(dashboardAt);
      expect(
        page.lastIndexOf(`</${tag}>`),
        `${tree.name}: the <${tag}> carrying the marker closes before the dashboard, so it does not wrap it`,
      ).toBeGreaterThan(dashboardAt);
    });

    it("re-caps everything that is NOT the dashboard, so :has() cannot un-cap the whole column", () => {
      // THE CENTRAL ASSERTION, and the one the /owner tree exists for. The marker is
      // read by a :has() on an ancestor of every child, so without a re-cap the task
      // queue, the Management header, the owner stat row and the systems catalogue
      // all go full-bleed with the dashboard. Exactly one re-cap wrapper, opening
      // after the dashboard, with every other component inside it.
      const occurrences = page.split(RECAP).length - 1;
      expect(
        occurrences,
        `${tree.name}: expected exactly one ${RECAP}, found ${occurrences}`,
      ).toBe(1);

      const recapAt = page.indexOf(RECAP);
      const dashboardAt = page.indexOf("<PracticeDashboard");
      expect(
        recapAt,
        `${tree.name}: the re-cap opens before the dashboard, so it would box the dashboard too`,
      ).toBeGreaterThan(dashboardAt);

      // Everything the page renders from the marker onward, other than the dashboard
      // itself, must sit after the re-cap opens. A component added to the page and
      // left outside the wrapper fails here, by name.
      const { at: markerAt } = markerUsedByPage(page, hatches) as { at: number };
      const slice = page.slice(markerAt);
      const rendered = new Set(
        [...slice.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]),
      );
      rendered.delete("PracticeDashboard");
      expect(rendered.size, `${tree.name}: nothing else is rendered beside the dashboard?`).toBeGreaterThan(0);
      for (const name of rendered) {
        expect(
          slice.indexOf(`<${name}`),
          `${tree.name}: <${name}> is rendered outside the re-cap, so it goes full-bleed with the dashboard`,
        ).toBeGreaterThan(slice.indexOf(RECAP));
      }
    });

    it("bleeds its bands by exactly the gutter the shell sets, at every breakpoint", () => {
      // The gutter is read off the shell rather than written down here. A shell that
      // moves to px-8 at xl and a band still on -mx-6 is the bug this catches.
      const steps = gutterSteps(cappedColumnClasses(app));
      expect(steps.length, `${tree.name}: could not read a px- gutter off the shell`).toBeGreaterThan(1);

      for (const [file, needle] of [
        [read(PRACTICE_DASHBOARD), "grid-cols-1"],
        [read(TAKINGS_STRIP), "grid-cols-2"],
      ] as const) {
        const classes = quotedStringContaining(file, needle);
        for (const step of steps) {
          expect(
            classes,
            `the band bleeding by ${classes} stops short of the edge at "${step[0] || "base"}": it needs ${bleedFor(step)}`,
          ).toContain(bleedFor(step));
        }
      }
    });
  });

  it("puts the cells' own padding back, so the first figure still sits on the content edge", () => {
    // The bleed is only half of it. takings-strip.tsx says "the cells bleed to the
    // content edge, so the first figure sits on the same left rule as every heading
    // and row on the page" - which is true only if the cell pads by the same amount
    // the band pulled out. Cell padding frozen at px-4 while the band bleeds -mx-6
    // moves the money 8px left of every heading under it.
    const steps = gutterSteps(cappedColumnClasses(read(TREES[0].appLayout)));
    // Located by something that is NOT padding, and read as the class string itself
    // rather than as "somewhere in the file" - see quotedStringContaining.
    const cells = [
      [read(TAKINGS_STRIP), "pressable group relative flex", "the takings cell"],
      [read(PRACTICE_DASHBOARD), "flex min-w-0 flex-col", "the band cell"],
    ] as const;
    for (const [source, needle, what] of cells) {
      const classes = quotedStringContaining(source, needle);
      for (const step of steps) {
        expect(
          classes,
          `${what} pads by "${classes}" and so does not match the bleed: it needs ${padFor(step)}`,
        ).toContain(padFor(step));
      }
    }
  });

  it("spends the reclaimed width on data, not on margin", () => {
    // PRODUCT.md:62: "Removing chrome is not the same as removing information...
    // never a sparser screen than Dentally's." The appointment row squeezes the
    // reason and whatever the receptionist typed onto ONE truncating line. At the
    // widths this change unlocks there is room to stop doing that, and doing it is
    // pure chrome: both strings are already on the row.
    const list = read(APPOINTMENT_LIST);
    expect(list, "the appointment list gained no wide-screen rule at all").toContain("2xl:");
    expect(
      /2xl:[a-z-]*block[^]{0,400}\{row\.note\}/.test(list),
      "the note still has no column of its own at 2xl - the width was taken and spent on margin",
    ).toBe(true);
  });

  it("keeps the marker on the PAGE, not inside the dashboard component", () => {
    // A marker inside practice-dashboard.tsx would compile, render, and un-cap the
    // whole main column again - the task queue and the entire owner console with it -
    // because :has() asks only whether ANY descendant carries the attribute. The
    // re-cap above cannot see that, so it is asserted here.
    // Comments are stripped first: the component explains at length why the marker
    // is NOT set there, and that explanation must not be what fails this.
    expect(
      codeOnly(read(PRACTICE_DASHBOARD)).includes("data-wide"),
      "practice-dashboard.tsx carries the width marker; it belongs to the page, which knows what its siblings are",
    ).toBe(false);
  });

  it("keeps the two trees identical in how they escape the cap and how they re-cap", () => {
    // A module wired into /c and not /owner is a class of failure this project has
    // already shipped. The width of the owner's dashboard and the practice manager's
    // is the same property, so it is one structure in two files or it is two products.
    const hatchSets = TREES.map((t) => escapeHatchAttributes(read(t.appLayout)).join(","));
    expect(
      new Set(hatchSets).size,
      `the shells key on different attributes: ${hatchSets.join(" vs ")}`,
    ).toBe(1);

    const markers = TREES.map((t) =>
      markerUsedByPage(read(t.page), escapeHatchAttributes(read(t.appLayout))),
    );
    expect(
      markers.every((m) => m !== null),
      "one tree's home page does not carry the marker at all - that tree's dashboard is still boxed",
    ).toBe(true);
    const shapes = markers.map(
      (m) => `${(m as { tag: string }).tag}[${(m as { attr: string }).attr}]`,
    );
    expect(new Set(shapes).size, `the trees mark the dashboard differently: ${shapes.join(" vs ")}`).toBe(1);

    const recaps = TREES.map((t) => (read(t.page).includes(RECAP) ? RECAP : "none"));
    expect(
      new Set(recaps).size,
      `the trees re-cap their extras differently: ${recaps.join(" vs ")}`,
    ).toBe(1);
    expect(recaps[0], "neither tree re-caps its extras").toBe(RECAP);
  });
});
