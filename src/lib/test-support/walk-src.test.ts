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
//
// THE ROOT IS NOT THE ONLY WAY A WALK NARROWS IN SILENCE. What it refuses to DESCEND
// into does the same thing, one directory at a time, and this walk skips every
// dot-prefixed folder by default. Next's app router serves those — `.well-known` is
// named in the framework's own docs as an endpoint you may define — so a route parked
// in one is live and invisible to the sweep whose stated job is that no write route
// is unguarded. `includeDotDirs` is the answer, and an option nobody checks is worth
// nothing: the last describe below builds a REAL dot-directory under src/ and proves
// the option changes what comes back, because with no dot-folder in the tree "the
// option works" and "the option is ignored" produce identical output everywhere else.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
 * EVERY SWEEP THAT WAS BOTH CWD-ROOTED AND WHOLE-SRC IS NOW HERE. The last two
 * left in the wave-3c round-1 co-pilot fix lane
 * (lib/copilot/cited-tests-resolve.test.ts, after it threw
 * `ENOENT ... .walk-fixture-XXXX/.git/route.ts` twice in about fifty full-suite
 * runs during the review) and in the wave-3d platform-hygiene lane
 * (lib/smile-assessment/step-beacon.test.ts, whose ENOENT the finder reproduced
 * on `.walk-fixture-1Q4dbv/.git/route.ts`). Both are pinned from their own side
 * too, and both keep the default `includeDotDirs: false`, which is the right
 * default for a whole-src sweep.
 *
 * WHY THE RACE WAS WORTH CLOSING RATHER THAN TOLERATING. A hand-rolled walk that
 * descends dot-directories meets the fixture at the foot of this file — a REAL
 * `.walk-fixture-XXXX/` created under src/lib/test-support and deleted a few
 * milliseconds later — and reads files that are vanishing underneath it.
 * components/assess/funnel-progress-wiring.test.ts flaked on exactly that (ENOENT
 * on .walk-fixture-XXXX/node_modules/route.ts, reproduced 1 run in 11) until it
 * was migrated, and lib/source-hygiene.test.ts had to name the fixture prefix in
 * its own skip list for the same reason. The fixture cannot be made safe from its
 * own side: it has to exist under src/ for the dot-directory assertions to mean
 * anything, so the fix was always on the walkers' side.
 *
 * KNOWN GAP, AND IT IS NOT THE ONE THIS LIST USED TO NAME. The gap was written
 * down as "the sweeps that still root at process.cwd()", and rooting is only HALF
 * of what makes a walk race the fixture. The other half — descending into a
 * dot-directory — is independent of the root, so three sweeps that root
 * CORRECTLY, through import.meta.url, and were therefore never on the list are
 * live racers all the same. They are named in REMAINING_HAND_ROLLED below with
 * what each one is, and the entries are pinned non-stale so this paragraph cannot
 * quietly rot the way the last one did. Each needs a change in a directory this
 * file does not own; the migration is the same three lines every time.
 *
 * lib/source-hygiene.test.ts is NOT a gap: it walks the whole REPO (scripts/ and
 * supabase/ too) and by bytes rather than by extension, so it is a different
 * sweep, and it already names the `.walk-fixture-` prefix in its own skip list.
 */

/**
 * The whole-src sweeps that still hand-roll their walk, with WHY each is listed.
 *
 * A "racer" here means one specific thing: its root is src/ (or above) and it
 * descends dot-directories, so it walks into the `.walk-fixture-XXXX/` at the
 * foot of this file while that directory is being deleted, and throws ENOENT on a
 * file that existed a millisecond ago. That is a flake in a sweep whose whole job
 * is to make a claim about the source, and the claim is not made at all on the
 * run where the file aborts at collection.
 *
 * The second column is the file. The third says what is wrong with it, because
 * the two failure modes are genuinely different and the fix for one is not the
 * fix for the other: a cwd rooting sweeps THE WRONG TREE (silently green about
 * source nobody edited, in every worktree), a dot-directory descent RACES.
 *
 * Every one of these is a three-line change — import { srcPath, walkSrc }, call
 * walkSrc with the options that sweep needs, read through srcPath — and every one
 * of them lives in a directory this file does not own, so they are listed rather
 * than done here. Migrating one means moving its row into MIGRATED above IN THE
 * SAME EDIT; the assertion below reddens on a row that no longer hand-rolls.
 */
const REMAINING_HAND_ROLLED = [
  [
    "the perio-flag reader sweep",
    "lib/perio/gate.test.ts",
    "racer: rooted correctly at src/ through import.meta.url, but its walk has no " +
      "skip list at all, so it descends the fixture (and node_modules, and .git)",
  ],
  [
    "the medical-history-flag reader sweep",
    "lib/patient-medical/gate.test.ts",
    "racer: the same walk as perio/gate.test.ts, copied — which is the argument " +
      "for one shared walk rather than the dedup argument",
  ],
  [
    "the platform citation sweep",
    "components/platform/platform-citations.test.ts",
    "racer: rooted at src/ through import.meta.url and descends everything; it " +
      "stats every entry inside the fixture on its way to finding *.test.ts files",
  ],
  [
    "the Dentally budget-priority sweep",
    "lib/dentally/budget-priority-coverage.test.ts",
    "cwd rooting only, NOT a racer: narrowed to src/app/api it can never reach " +
      "src/lib/test-support. Migrating it means walkSrc({ subdir: 'app/api', " +
      "extensions: null }) plus a route.ts filename filter",
  ],
  [
    "the patient-facing copy sweep",
    "lib/systems/os-copy-sweep.test.ts",
    "cwd rooting only, NOT a racer: it walks the six public src/app trees, none " +
      "of which contains the fixture",
  ],
] as const;

const MIGRATED = [
  ["the beacon-transport sweep", "lib/beacon-transport.test.ts"],
  ["the pageAll-uniqueness sweep", "lib/dashboard/money-path-hardening.test.ts"],
  ["the loading.tsx sweep", "app/navigation-instant-coverage.test.ts"],
  ["the destructive-route sweep", "app/api/destructive-route-capability-coverage.test.ts"],
  ["the send-site crawl", "lib/inbox/send-sites.test.ts"],
  ["the funnel-progress importer sweep", "components/assess/funnel-progress-wiring.test.ts"],
  // MIGRATED in the wave-3c round-1 co-pilot fix lane: it was one of the racers
  // named in the KNOWN GAP above, and it aborted at COLLECTION on the fixture at
  // the foot of this file, so none of its ~740 citation checks ran on that pass.
  ["the citation sweep", "lib/copilot/cited-tests-resolve.test.ts"],
  // MIGRATED in the wave-3d platform-hygiene lane: the last sweep that both rooted
  // at cwd AND descended every directory, so it raced the fixture at the foot of
  // this file (`ENOENT ... .walk-fixture-1Q4dbv/.git/route.ts`, reproduced by the
  // finder). Its claim — "the beacon has exactly one importer" — is precisely the
  // kind a wrong root turns into decoration.
  ["the step-beacon importer sweep", "lib/smile-assessment/step-beacon.test.ts"],
] as const;

/**
 * The sweeps whose sentence is about ROUTING, and so the ones that may not skip a
 * folder the router serves. The third column is the claim each file prints, because
 * that claim is the reason the option is not optional there.
 */
const DOT_DIR_SWEEPS = [
  [
    "the destructive-route sweep",
    "app/api/destructive-route-capability-coverage.test.ts",
    "no write route in the platform is unguarded",
  ],
  [
    "the loading.tsx sweep",
    "app/navigation-instant-coverage.test.ts",
    "no loading.tsx exists anywhere under src/app",
  ],
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

  // THE LIST OF WHAT IS NOT DONE YET, KEPT HONEST.
  //
  // The old KNOWN GAP paragraph was prose, and prose rots: it named three racers,
  // one of which (budget-priority-coverage) could not reach the fixture at all,
  // while three real racers that root correctly were never on it because the
  // paragraph was written about ROOTS. These two assertions make the list a
  // checkable claim instead — an entry that has been migrated goes red, and so
  // does an entry that was never true.
  //
  // MUTATION: migrate one of these sweeps and leave its row here. The suite would
  // otherwise stay green while this file went on telling the next reader that a
  // closed gap is open, which is exactly how the paragraph this replaced ended up
  // describing a tree that no longer existed.
  it.each(REMAINING_HAND_ROLLED)("%s is still hand-rolling its walk", (_name, file, why) => {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    expect(
      code,
      `${file} no longer hand-rolls a walk (${why}) — move its row into MIGRATED`,
    ).toContain("readdirSync");
  });

  it("does not list the same sweep as both migrated and outstanding", () => {
    const migrated = new Set<string>(MIGRATED.map(([, file]) => file));
    const both = REMAINING_HAND_ROLLED.map(([, file]) => file).filter((f) => migrated.has(f));
    expect(both, `listed as migrated and as outstanding at once: ${both.join(", ")}`).toEqual([]);
  });

  // MUTATION: drop `includeDotDirs: true` from either sweep "because src/app holds no
  // dot-folders today". Both stay green, both go on printing the same claim, and both
  // have stopped covering a directory the framework will happily serve.
  //
  // These two are pinned and the other callers are not, deliberately. A dot-directory
  // is a ROUTING fact — app/.well-known/<x>/route.ts is a reachable handler — so a
  // sweep whose claim is about routes, or about the shape of src/app, has to look in
  // one. The whole-src walks (beacon-transport, money-path-hardening, dentally/paging)
  // are the opposite case: the only dot-directory they would meet is a nested checkout
  // under src/, and descending it counts every declaration twice. They keep the
  // default, and say so where they call it.
  it.each(DOT_DIR_SWEEPS)("%s looks inside dot-directories", (_name, file, claim) => {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    expect(
      code,
      `${file} claims "${claim}", which it cannot claim about a directory it never opens`,
    ).toContain("includeDotDirs: true");
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

  // MUTATION: drop the node_modules / .git skip, or make dot-directories the default
  // for every caller. Neither exists under src/ today, so nothing goes red — until a
  // .claude worktree or an installed package lands there and every declaration in the
  // repo is found twice.
  it("skips node_modules, .git and — by default — every dot-directory", () => {
    expect(HELPER_CODE).toContain('"node_modules"');
    expect(HELPER_CODE).toContain('".git"');
    expect(HELPER_CODE).toContain('name.startsWith(".")');
    for (const file of walkSrc({ includeTests: true })) {
      expect(file.split("/").some((s) => s === "node_modules" || s.startsWith("."))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// THE OPTION THAT DECIDES WHAT A SWEEP CANNOT SEE.
//
// Every assertion above this line is about files that exist anyway. This one has to
// MAKE a dot-directory, because src/ holds none — which is exactly why the blind spot
// survived four hand-rolled walks and the consolidation that replaced them.
//
// The fixture is created and destroyed inside the assertion, under lib/test-support/
// rather than under app/. What that buys is narrower than it once claimed: EVERY
// WHOLE-SRC WALK THAT SKIPS DOT-DIRECTORIES CANNOT SEE IT, AND THE ONES THAT DO NOT
// SKIP THEM ARE THE BUG. The two callers that pass includeDotDirs are narrowed to
// app/ and app/api, and every caller of walkSrc takes the default — but a sweep
// with its own hand-rolled walk descends into this directory while it is being
// deleted and gets an ENOENT. That is not hypothetical: lib/source-hygiene.test.ts
// names ".walk-fixture-" in its own skip list because of it, and
// components/assess/funnel-progress-wiring.test.ts, lib/copilot/
// cited-tests-resolve.test.ts and lib/smile-assessment/step-beacon.test.ts each
// flaked on it until they were migrated onto walkSrc. There are no racers left
// (see MIGRATED above), and the fix was always on their side rather than here: a
// fixture that no walk could see would prove nothing about a walk.
// ---------------------------------------------------------------------------

interface DotDirFixture {
  /** A .ts file directly inside the dot-directory: the one the option is about. */
  file: string;
  /** Inside a nested node_modules — never returned, whatever the option says. */
  vendored: string;
  /** Inside a nested .git — likewise. */
  git: string;
}

function withDotDirFixture<T>(run: (fixture: DotDirFixture) => T): T {
  // mkdtemp, not a fixed name: two runners on one checkout must not collide, and a
  // leftover from a crashed run must not be mistaken for a real directory.
  const abs = mkdtempSync(srcPath("lib/test-support/.walk-fixture-"));
  const dir = `lib/test-support/${basename(abs)}`;
  try {
    // Named route.ts because that is the file the destructive-route sweep hunts: the
    // fixture stands in for app/.well-known/<x>/route.ts, which Next serves.
    writeFileSync(join(abs, "route.ts"), "export {};\n");
    mkdirSync(join(abs, "node_modules"));
    writeFileSync(join(abs, "node_modules", "route.ts"), "export {};\n");
    mkdirSync(join(abs, ".git"));
    writeFileSync(join(abs, ".git", "route.ts"), "export {};\n");
    return run({
      file: `${dir}/route.ts`,
      vendored: `${dir}/node_modules/route.ts`,
      git: `${dir}/.git/route.ts`,
    });
  } finally {
    rmSync(abs, { recursive: true, force: true });
  }
}

describe("dot-directories, which the app router serves and this walk hides", () => {
  // MUTATION: accept `includeDotDirs` and then ignore it — read it into a variable and
  // never pass it to skipDirectory. Every sweep in the suite stays green, the two
  // security sweeps go on printing their claims, and the option is decoration. This is
  // the assertion that fails, because it is the only one with a dot-directory to find.
  it("are hidden by default and returned when the caller asks", () => {
    withDotDirFixture(({ file }) => {
      expect(
        walkSrc(),
        "the default must stay narrow: a nested checkout is the dot-directory a whole-src walk actually meets",
      ).not.toContain(file);
      expect(
        walkSrc({ includeDotDirs: true }),
        "includeDotDirs changed nothing, so it is not wired to the skip",
      ).toContain(file);
    });
  });

  it("stay out of a subdirectory walk that does not reach them", () => {
    withDotDirFixture(({ file }) => {
      expect(walkSrc({ subdir: "app", includeDotDirs: true })).not.toContain(file);
      expect(walkSrc({ subdir: "lib", includeDotDirs: true })).toContain(file);
    });
  });

  // node_modules and .git are NOT part of the judgement call: an option that let one
  // through would have a sweep report a vendored package's declarations as ours.
  it("never reach into node_modules or .git, whatever the option says", () => {
    withDotDirFixture(({ vendored, git }) => {
      const everything = walkSrc({ includeDotDirs: true, includeTests: true, extensions: null });
      expect(everything).not.toContain(vendored);
      expect(everything).not.toContain(git);
    });
  });

  it("leave nothing behind: the fixture exists only inside the assertion", () => {
    const seen = withDotDirFixture(({ file }) => {
      expect(walkSrc({ includeDotDirs: true })).toContain(file);
      return file;
    });
    expect(walkSrc({ includeDotDirs: true }), "the fixture outlived its test").not.toContain(seen);
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
