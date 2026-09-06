import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { srcPath, walkSrc } from "@/lib/test-support/walk-src";

/**
 * EVERY TEST THIS CODEBASE'S COMMENTS CITE ACTUALLY EXISTS (ruling W3/17).
 *
 * This codebase records its calibrations where they are used, so a comment IS
 * the contract (charter §0/1), and a comment that defers a property to another
 * test — "that gate has its own test, over there" — is load-bearing twice over:
 * a reader auditing coverage follows it, and a later lane deciding whether a
 * property is proven trusts it.
 *
 * IT WAS WRONG ONCE. `battery.test.ts` deferred the same-turn-confirm half of
 * the diary two-step to "diary-write-tool.test.ts", a file that has never
 * existed in this tree. The property WAS pinned — w2a-tools.test.ts, "A
 * SAME-TURN CONFIRM NEVER REACHES THE DISPATCH", which drives `diary_write`
 * with `confirm: true` through the real run.ts commit gate — so the code was
 * sound and only the signpost pointed into thin air. The bad direction is not
 * the auditor who checks and finds nothing; it is the auditor who takes the
 * comment at face value and records an unproven property as proven, which is
 * the exact shape W3/17 was written to close.
 *
 * SO THE SIGNPOSTS ARE CHECKED BY A TEST, not by the next reader. Two rules:
 * a cited `*.test.ts` must exist somewhere under src/, and where the citation
 * also quotes the test's name, that name must appear in one of the files it
 * could mean.
 *
 * IT COVERS THE WHOLE TREE (ruling W3/17, widened 5 September 2026). It was
 * scoped to src/lib/copilot for one round — not because the rule is a co-pilot
 * rule, but because running it over src/ went red on six citations in files no
 * co-pilot lane was allowed to edit, every one of them older than this
 * programme's diff. All six are now settled, in the two ways W3/17 allows: five
 * signposts were repointed at the test that really pins the property
 * (copilot-prose.tsx → markdown.test.ts and zz-xss-probe.test.ts;
 * src/lib/collection/types.ts → gating.test.ts; src/lib/reports/report-window.ts
 * → rsc-value-import.test.ts; src/lib/smile-assessment/funnel-progress-beacon.ts
 * → funnel-progress-wiring.test.ts; src/lib/agent-wiring/roster.ts's quoted
 * roster.test.ts name), and the sixth was the sweep-header case below.
 *
 * WIDENING IS THE WHOLE POINT of a rule like this. A directory-scoped sweep
 * proves the comments a lane happened to own; the defect it exists to catch —
 * an auditor recording an unproven property as proven — is worst exactly where
 * nobody is looking. Some 740 citations are checked here, against roughly 30
 * when this file was written.
 *
 * TWO SISTER SWEEPS SURVIVE AND ARE NOT REDUNDANT: src/lib/equipment/
 * citations.test.ts additionally requires an equipment citation to resolve
 * inside a named list of directories (stricter than "somewhere under src"), and
 * src/components/platform/platform-citations.test.ts holds the shell's own
 * comments. Both are subsets of this walk in the file-exists rule and supersets
 * of it in their own.
 *
 * IT LIVES IN src/lib/copilot for a reason that is now historical: this is where
 * the failing citation was found and where the rule was written. Moving it would
 * be a rename with no behaviour in it, and the two floors below name the whole
 * tree explicitly, so nothing about the scope is inferred from the path.
 */
// ---------------------------------------------------------------------------
// THE WALK IS THE SHARED ONE (src/lib/test-support/walk-src.ts), and that is a
// correctness fix rather than a tidy-up.
//
// This sweep used to hand-roll two recursive walks rooted at `process.cwd()`,
// descending into every directory and skipping nothing. Two things were wrong
// with that, and the second one bit:
//
//   * cwd IS THE RUNNER'S DIRECTORY, NOT THIS FILE'S. Agent work in this repo
//     happens in .claude/worktrees/<name>/, a complete second checkout, so a run
//     started in one tree could sweep the other and report a clean ~740-citation
//     guarantee about source it never opened. `srcPath`/`walkSrc` resolve from
//     this module's own URL and cannot be pointed at the wrong tree.
//   * IT RACED A REAL FIXTURE. walk-src.test.ts creates an actual dot-directory
//     under src/lib/test-support/ (`mkdtempSync(".walk-fixture-")`, holding
//     route.ts, node_modules/route.ts and .git/route.ts) and deletes it
//     milliseconds later. A walk that descends dot-directories opens files that
//     are vanishing underneath it, and this file threw
//     `ENOENT ... .walk-fixture-XXXX/.git/route.ts` twice in about fifty full
//     runs during the wave-3 review. The throw happens while the describe body
//     is being COLLECTED, so none of the assertions below run at all: the run
//     goes red for a reason unrelated to any citation, which is how a real red
//     later gets waved through as "the flaky one". walk-src.test.ts names this
//     file as one of the remaining racers; the fix is here, as it says.
//
// The default `includeDotDirs: false` is what closes the race, and it costs this
// sweep nothing: a citation inside a dot-directory would be inside a nested
// checkout, and every declaration in it is already checked in its own tree.
// ---------------------------------------------------------------------------

/** Every `.ts`/`.tsx` under src/, tests included, as posix paths relative to src/. */
const SRC_FILES = walkSrc({ includeTests: true });

/** Every `*.test.ts` under src/, indexed by bare filename (several may share one). */
function testFilesByName(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of SRC_FILES) {
    if (!rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx")) continue;
    const entry = rel.slice(rel.lastIndexOf("/") + 1);
    const list = out.get(entry);
    if (list) list.push(srcPath(rel));
    else out.set(entry, [srcPath(rel)]);
  }
  return out;
}

interface Citation {
  /** The file doing the citing, e.g. "battery.test.ts". */
  from: string;
  /** The bare filename cited, e.g. "w2a-tools.test.ts". */
  file: string;
  /** The test name quoted alongside it, when the citation quotes one. */
  name: string | null;
}

/**
 * A citation is a `*.test.ts` filename anywhere in the source — a comment, a
 * string, a path. The optional quoted name must be on the SAME LINE: a comma
 * and a quote hunted across newlines would happily bind the next paragraph's
 * quoted sentence to a bare filename and invent a rule nobody wrote.
 */
const CITATION = /([A-Za-z0-9_.-]+\.test\.tsx?)(?:[ \t]*,[ \t]*"([^"\n]+)")?/g;

/**
 * THE CITATION SWEEPS ARE EXEMPT FROM THEIR OWN SCAN, and they are the only
 * exemption in this file.
 *
 * A sweep of this kind explains itself by NAMING the dangling citation it was
 * written about — this file's header still names `diary-write-tool.test.ts`,
 * the deferral that pointed into thin air and started all three — because a
 * rule with no worked example is a rule the next reader rewrites. A sweep that
 * read its own history note would report the note as the defect, and the fix
 * would be to delete the example, which is the one thing that makes the rule
 * legible. That is the rule the tree-wide widening needed before it was honest
 * (wave-3b handoff B136).
 *
 * LISTED BY PATH, NOT MATCHED BY PATTERN. "Any file whose name contains
 * citations" would let a fourth file opt itself out of the sweep by choosing a
 * name, which is exactly the escape hatch this rule must not have. Adding to
 * this list is a deliberate act, and the floor below checks that each entry
 * really is a citation sweep and that the exemption is still earning its place.
 */
const SWEEP_HEADERS: readonly string[] = [
  "src/lib/copilot/cited-tests-resolve.test.ts",
  "src/lib/equipment/citations.test.ts",
  "src/components/platform/platform-citations.test.ts",
];

/**
 * Every `.ts`/`.tsx` file under src/, as a repo-relative path.
 *
 * Repo-relative rather than src-relative because that is what SWEEP_HEADERS and
 * every failure message read like, and a path in a red test should be one a
 * person can paste into an editor. `readSource` is the matching reader: the path
 * is a LABEL, and the bytes come from `srcPath` so the wrong checkout cannot
 * answer.
 */
function sourceFiles(): string[] {
  return SRC_FILES.map((rel) => `src/${rel}`);
}

/** Read a repo-relative `src/...` path from THIS file's tree, never the runner's. */
function readSource(repoRelative: string): string {
  return readFileSync(srcPath(repoRelative.replace(/^src\//, "")), "utf8");
}

function citationsIn(files: string[]): Citation[] {
  const out: Citation[] = [];
  for (const file of files) {
    if (SWEEP_HEADERS.includes(file)) continue;
    const entry = file.slice(file.lastIndexOf("/") + 1);
    const source = readSource(file);
    for (const match of source.matchAll(CITATION)) {
      // A file citing itself is not a signpost, it is a header. Skip it.
      if (match[1] === entry) continue;
      out.push({ from: file, file: match[1], name: match[2] ?? null });
    }
  }
  return out;
}

describe("the tests this codebase's comments cite", () => {
  const known = testFilesByName();
  const files = sourceFiles();
  const citations = citationsIn(files);

  it("there are citations to check, so a silent zero cannot pass this suite", () => {
    // A sweep that finds nothing passes for the wrong reason. Two floors,
    // because the walk broke in two different ways while this was being written:
    // the whole tree, and the directory that leans on cross-file citations
    // hardest (clearance, scope, the write gate, the agent run loop). A recursion
    // that stopped at the first directory would still clear one of them.
    expect(files.length, "the source walk collapsed").toBeGreaterThanOrEqual(500);
    expect(citations.length).toBeGreaterThanOrEqual(400);
    expect(
      citations.filter((c) => c.from.startsWith("src/lib/copilot/")).length,
      "the walk no longer reaches src/lib/copilot",
    ).toBeGreaterThanOrEqual(20);
  });

  it("walks through the shared helper, so it cannot race the fixture or sweep the wrong tree", () => {
    // THE PIN FOR THE MIGRATION ABOVE, and it has to be a source assertion: a
    // hand-rolled walk rooted at cwd returns exactly the same list on a normal
    // run in the trunk, so there is no output to assert against. What separates
    // the two is WHERE they start and WHAT they descend into, and both of those
    // are visible only in the code. Same shape, and the same reason, as
    // walk-src.test.ts's own "walks through this module, not a copy of it".
    // THE NEEDLES ARE SPLIT because this sweep is reading ITSELF: written whole,
    // `"readdirSync"` would be in the very line asserting its absence and the
    // test could never pass. walk-src.test.ts does not have this problem because
    // it reads other files.
    const banned = [["readdir", "Sync"], ["process", ".cwd"]].map((parts) => parts.join(""));
    const self = readSource("src/lib/copilot/cited-tests-resolve.test.ts");
    const code = self.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "the citation sweep no longer calls walkSrc").toContain("walkSrc(");
    for (const needle of banned) {
      expect(code, `the citation sweep has gone back to ${needle}`).not.toContain(needle);
    }

    // ...and the consequence that was actually failing: nothing under a
    // dot-directory is opened, so walk-src.test.ts's `.walk-fixture-XXXX/` —
    // created and deleted a few milliseconds apart while this suite runs — is
    // never a file this sweep is halfway through reading.
    for (const file of files) {
      expect(
        file.split("/").some((segment) => segment.startsWith(".")),
        `${file} is inside a dot-directory`,
      ).toBe(false);
    }
  });

  it("exempts nothing but the citation sweeps, and each really is one", () => {
    // The exemption's floor, in both directions. Each exempt file must exist and
    // must itself be a sweep of this kind; and at least one of them must still
    // name a citation that does not resolve — the day none does, the exemption
    // has stopped protecting anything and belongs in a diff, not in a comment.
    const dangling: string[] = [];
    for (const file of SWEEP_HEADERS) {
      const source = readSource(file);
      // A sweep of this kind is recognisable by the one thing it must have: a
      // pattern for finding `*.test.ts` names in prose.
      expect(source, `${file} is exempt but is not a citation sweep`).toContain("const CITATION");
      const entry = file.slice(file.lastIndexOf("/") + 1);
      for (const match of source.matchAll(CITATION)) {
        if (match[1] === entry) continue;
        if (!known.has(match[1])) dangling.push(`${file} names ${match[1]}`);
      }
    }
    expect(
      dangling.length,
      "no sweep header names a dangling citation any more; drop SWEEP_HEADERS",
    ).toBeGreaterThan(0);
  });

  it("EVERY cited test file exists somewhere under src/", () => {
    const dangling = citations
      .filter((c) => !known.has(c.file))
      .map((c) => `${c.from} cites ${c.file}, which does not exist`);
    expect(dangling).toEqual([]);
  });

  it("EVERY citation that quotes a test name quotes one that is really there", () => {
    const wrong: string[] = [];
    for (const c of citations) {
      if (!c.name) continue;
      const paths = known.get(c.file) ?? [];
      const found = paths.some((p) =>
        readFileSync(p, "utf8").toLowerCase().includes(c.name!.toLowerCase()),
      );
      if (!found) wrong.push(`${c.from} cites ${c.file}, "${c.name}", which is not in that file`);
    }
    expect(wrong).toEqual([]);
  });

  it("the diary two-step's own signpost points at the test that really pins it", () => {
    // The instance that failed, named so a regression is a red test with a
    // sentence rather than a line number: the battery cannot assert the
    // same-turn-confirm path itself (the commit gate in run.ts stops the call
    // before the dispatch, hiding the clearance refusal that scenario exists to
    // prove), so it defers — and the deferral must land somewhere real.
    const battery = readFileSync(join(srcPath("lib/copilot"), "battery.test.ts"), "utf8");
    expect(battery).not.toMatch(/diary-write-tool\.test\.ts/);
    expect(battery).toMatch(/w2a-tools\.test\.ts, "A SAME-TURN CONFIRM NEVER REACHES THE DISPATCH"/);
    const w2a = readFileSync(join(srcPath("lib/copilot"), "w2a-tools.test.ts"), "utf8");
    expect(w2a).toMatch(/A SAME-TURN CONFIRM NEVER REACHES THE DISPATCH/);
  });
});
