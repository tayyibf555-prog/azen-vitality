import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * THE DASHBOARD IS PAINTED OUT OF THE TOKEN FILE, NOT OUT OF HEX LITERALS.
 *
 * Every colour on this screen has a name in globals.css - `--card`, `--card-muted`,
 * `--line`, the status tints - and the whole point of naming them is that a re-skin
 * is one file. A raw `#ffffff` sitting in a component is invisible to that file: it
 * survives every theme change, and it drifts away from whatever the token beside it
 * became. Two of them shipped on the donut's texture patterns and nothing caught it,
 * because the only hex bans in this repo are pinned to two named smile-assessment
 * files (create-experience-shell.test.ts, campaign-theme.test.ts) and eslint adds no
 * rule of its own.
 *
 * THE PROPERTY THIS FILE PINS:
 *
 *     no component under src/components/client/dashboard/ names a colour by hex.
 *
 * WHY THE DIRECTORY AND NOT A FILE LIST. A ban on named files is a ban on the files
 * somebody already found. The next literal will arrive in whichever panel is next
 * rewritten, so the scan is over the directory and picks up new files for free.
 *
 * COMMENTS ARE STRIPPED FIRST. Prose about a colour is not a colour, and a comment
 * quoting the old value is exactly how a fix like this gets explained. Only code is
 * checked. (The stripper is the one from create-experience-shell.test.ts.)
 *
 * WHAT TO DO WHEN THIS FAILS: add the colour to :root in src/app/globals.css and
 * reference it as var(--name), or reach for the token that already means it. Do not
 * substitute a token that is merely close - `--card` is #f9fbfe, not white, and
 * swapping it in for a texture highlight shifts the texture.
 *
 * Paths are resolved from import.meta.url so this never walks .claude/worktrees,
 * which are full repo copies and would match duplicate files.
 */

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBALS = resolve(DASHBOARD_DIR, "..", "..", "..", "app", "globals.css");

/** Source with block and line comments removed, so prose never counts as code. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const COMPONENTS = readdirSync(DASHBOARD_DIR)
  .filter((name) => name.endsWith(".tsx"))
  .sort();

describe("the practice dashboard names its colours", () => {
  it("scans the components it thinks it is scanning - otherwise this file is vacuous", () => {
    // A glob that matches nothing passes every assertion under it. These four are
    // the panels the band is made of; if the directory is ever restructured this
    // fails loudly rather than going quiet.
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(8);
    for (const required of [
      "appointments-donut.tsx",
      "takings-strip.tsx",
      "practice-dashboard.tsx",
      "appointment-list.tsx",
    ]) {
      expect(COMPONENTS, `${required} is no longer in the scanned directory`).toContain(required);
    }
  });

  it.each(COMPONENTS)("%s names no colour by hex", (name) => {
    const code = codeOnly(readFileSync(join(DASHBOARD_DIR, name), "utf8"));
    const found = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(
      found,
      `${name} hardcodes ${found.join(", ")}; give the colour a name in globals.css and use var(--name)`,
    ).toEqual([]);
  });

  it("keeps --on-fill in the token file, because the donut's textures are drawn with it", () => {
    // The two literals this test first caught were the white highlight cut into the
    // cancelled hatch and the missed-appointment dots. They are white ON a filled
    // arc, which is a different thing from a card surface: --card is #f9fbfe and
    // substituting it would tint the texture. So the token is its own.
    const css = readFileSync(GLOBALS, "utf8");
    expect(css, "globals.css has no --on-fill token for the donut's textures").toMatch(
      /--on-fill:\s*#ffffff;/,
    );
  });
});
