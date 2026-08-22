// THE WALK ITSELF, AND THE ONE PROPERTY EVERY SWEEP BUILT ON IT DEPENDS ON.
//
// A structural guard is a sentence about the SOURCE, and every one of them starts
// by finding the files. That first step is invisible in the result: a sweep that
// found nothing and a tree that is clean produce the same green tick, so a walk
// that is subtly wrong turns a whole family of guards into decoration without
// anything going red. This file is where the walk is checked instead of assumed.
//
// The specific way it goes wrong here is the ROOT. process.cwd() is the runner's
// directory, not the file's, and agent work in this repo happens inside
// .claude/worktrees/<name>/ — a complete second checkout of this same repo. A cwd
// rooting therefore does not crash and does not find an empty tree; it finds a real
// src/, sweeps it, and passes, having said nothing at all about the code that was
// actually changed. That is why the assertions below name FILES rather than only
// counting them: a count cannot tell two checkouts of the same repo apart.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SRC_ROOT, srcPath, walkSrc } from "./walk-src";

const HELPER_SOURCE = readFileSync(srcPath("lib/test-support/walk-src.ts"), "utf8");

/**
 * Source with comments stripped: what a file DOES, not what it explains.
 *
 * Needed because the thing being banned is also the thing worth WRITING ABOUT —
 * every file below carries a paragraph explaining why process.cwd() is wrong here,
 * and a raw `includes` would read those explanations as the offence.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const HELPER_CODE = codeOnly(HELPER_SOURCE);

/**
 * The sweeps that have been moved onto this walk.
 *
 * KNOWN GAP, stated rather than hidden. Three more tree-walking guards still root
 * their own walk at process.cwd() and are not migrated here because their sweeps
 * are shaped differently enough that "provably identical afterwards" has not been
 * demonstrated for them: lib/dentally/budget-priority-coverage.test.ts,
 * components/assess/funnel-progress-wiring.test.ts and
 * lib/smile-assessment/step-beacon.test.ts. One more, lib/source-hygiene.test.ts,
 * is NOT a gap: it walks the whole REPO (scripts/ and supabase/ too) and by bytes
 * rather than by extension, so it is a different sweep and keeps its own walk on
 * purpose.
 */
const MIGRATED = [
  ["the beacon-transport sweep", "lib/beacon-transport.test.ts"],
  ["the pageAll-uniqueness sweep", "lib/dashboard/money-path-hardening.test.ts"],
  ["the loading.tsx sweep", "app/navigation-instant-coverage.test.ts"],
  ["the destructive-route sweep", "app/api/destructive-route-capability-coverage.test.ts"],
] as const;

describe("the walk is rooted at this file, never at the runner", () => {
  // MUTATION: swap the import.meta.url derivation for `join(process.cwd(), "src")`
  // "because it reads better". That is the exact edit this module exists to make
  // impossible to repeat in five places at once, and it passes every other test in
  // the suite when the runner happens to be started from the repo root.
  it("derives src/ from import.meta.url and never reads cwd", () => {
    expect(HELPER_CODE).toContain("import.meta.url");
    expect(
      HELPER_CODE,
      "the root must come from this file's own location: cwd is the runner's " +
        "directory, and in a worktree that is a different checkout of this repo",
    ).not.toContain("process.cwd");
  });

  // MUTATION: add a `root` option "for one caller that needs it". Five hand-rolled
  // walks with four different roots is what this replaced; an option is the same
  // divergence with a nicer surface.
  it("offers no root option for a caller to get wrong", () => {
    expect(HELPER_CODE).not.toMatch(/\broot\??\s*:/);
  });

  it("resolves to the src/ this test is running out of", () => {
    expect(SRC_ROOT.replace(/\/$/, "")).toMatch(/\/src$/);
    expect(walkSrc({ includeTests: true })).toContain("lib/test-support/walk-src.test.ts");
  });

  // MUTATION: re-root any migrated sweep at cwd, or hand-roll its walk back. Both
  // are green until the day someone runs the suite from the other tree.
  it.each(MIGRATED)("%s walks through this module, not a copy of it", (_name, file) => {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    expect(code, `${file} no longer calls walkSrc`).toContain("walkSrc(");
    expect(code, `${file} has hand-rolled a walk again`).not.toContain("readdirSync");
    expect(code, `${file} has re-rooted a read at the runner's directory`).not.toContain(
      "process.cwd",
    );
  });
});

describe("what a caller can ask for", () => {
  it("returns .ts and .tsx under src/, excluding tests, as posix paths from src/", () => {
    const files = walkSrc();
    expect(files).toContain("lib/beacon-transport.ts");
    expect(files).toContain("components/platform/usage-beacon.tsx");
    expect(files).not.toContain("lib/beacon-transport.test.ts");
    for (const file of files) {
      expect(file).toMatch(/\.tsx?$/);
      expect(file, "a walked path must be relative to src/ and posix").not.toMatch(/^[/\\]|\\/);
    }
  });

  it("includes tests when asked, and only then", () => {
    expect(walkSrc({ includeTests: true })).toContain("lib/beacon-transport.test.ts");
  });

  // The subdir narrows the WALK but not the path grammar: a path means "under src/"
  // whoever asked for it, so two sweeps' outputs can be compared without a decoder.
  it("narrows to a subdirectory while keeping paths relative to src/", () => {
    const api = walkSrc({ subdir: "app/api", includeTests: true });
    expect(api).toContain("app/api/destructive-route-capability-coverage.test.ts");
    for (const file of api) expect(file.startsWith("app/api/")).toBe(true);
    expect(api.length).toBeLessThan(walkSrc({ includeTests: true }).length);
  });

  // For a sweep hunting a FILENAME rather than a language: a `loading.jsx` is
  // invisible to a .ts/.tsx filter, which is the whole point of the loading.tsx
  // guard finding nothing.
  it("keeps every file when extensions is null", () => {
    const everything = walkSrc({ subdir: "app", extensions: null, includeTests: true });
    expect(everything).toContain("app/globals.css");
    expect(everything).toContain("app/icon.png");
    expect(walkSrc({ subdir: "app", includeTests: true })).not.toContain("app/globals.css");
  });

  it("is sorted, so a failure lists the same files in the same order twice running", () => {
    const files = walkSrc();
    expect(files).toEqual([...files].sort());
  });

  // MUTATION: drop the node_modules / dot-directory skip. Neither exists under src/
  // today, so nothing goes red — until a .claude worktree or an installed package
  // lands under src/ and every declaration in the repo is found twice.
  it("never descends into node_modules or a dot-directory", () => {
    expect(HELPER_CODE).toContain('name === "node_modules"');
    expect(HELPER_CODE).toContain('name.startsWith(".")');
    for (const file of walkSrc({ includeTests: true })) {
      expect(file.split("/").some((s) => s === "node_modules" || s.startsWith("."))).toBe(false);
    }
  });
});

describe("srcPath", () => {
  it("resolves a src-relative path against the same root the walk uses", () => {
    expect(readFileSync(srcPath("lib/test-support/walk-src.ts"), "utf8")).toBe(HELPER_SOURCE);
  });

  // The walk's output feeds straight back into srcPath in every migrated sweep, so
  // the two must agree about what a path means.
  it("opens every file the walk names", () => {
    for (const file of walkSrc().slice(0, 40)) {
      expect(() => readFileSync(srcPath(file), "utf8")).not.toThrow();
    }
  });
});
