import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ===========================================================================
// EVERY TEST FILE THIS MODULE'S COMMENTS NAME HAS TO EXIST.
//
// This codebase records its calibrations where they are used: a comment saying
// "the two are pinned equal by `register-bound.test.ts`" is not decoration, it
// is the argument for why a `server-only` constant is duplicated in a pure
// module at all, and it is the first thing the next person reads before touching
// the number. When the named file does not exist, that reader greps, finds
// nothing, and concludes the pin was removed — so they either duplicate it or
// drop the constant out of sync, which is the exact drift the comment was
// written to prevent. The likelier outcome is quieter and worse: they delete the
// "stale" citation, and with it the only pointer to where the real check lives.
//
// THREE LIVE INSTANCES SHIPPED IN THIS MODULE and none of them was a lie about
// behaviour — the rules were all genuinely pinned, under other names.
// `types.ts` and `repository.ts` both named `register-bound.test.ts` for the
// REGISTER_READ_CAP/ASSET_ROW_CAP pin, which actually lives in `prompt.test.ts`;
// `chunk.ts` named `chunk.test.ts` for the chunker-over-the-fixture-PDF run,
// which actually lives in `ingest.test.ts`. Neither file has ever existed.
// Programme ruling W3/17: comments naming tests that do not exist are corrected
// or the test is written. This sweep is what stops the fourth one.
//
// SCOPED TO THIS MODULE ON PURPOSE. The same class exists elsewhere in the tree
// (four citations outside `git diff 6b93b40` that predate this programme), and a
// sweep committed tree-wide would go red on work this lane may not touch. Those
// are on the ledger; widening the glob below is the fix when they are.
// ===========================================================================

const DIR = "src/lib/equipment";

/**
 * A `*.test.ts` named in prose. Deliberately matches the bare filename rather
 * than a path: that is how the comments write it, and a citation nobody can
 * resolve is the defect whether or not it carries a directory.
 */
const CITATION = /([a-z0-9][a-z0-9-]*\.test\.ts)/g;

/** Where a cited test may live. A citation resolves if the name exists in any of them. */
const SEARCH_ROOTS = [
  DIR,
  "src/lib/home",
  "src/lib/copilot",
  "src/lib/desk",
  "src/lib/os-scenarios",
  "src/components/client/reports",
  "src/components/client/equipment",
  "src/app/api/equipment/[action]",
];

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(DIR, f));
}

describe("every test file this module's comments name resolves to a file on disk", () => {
  it("finds citations at all, so the sweep cannot pass by scanning nothing", () => {
    // The guard that stops this whole file becoming an always-true assertion the
    // day somebody changes the directory or the extension (W3/17 again).
    const files = sourceFiles();
    expect(files.length, "no non-test sources found — the directory scan went stale").toBeGreaterThan(5);
    const all = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(CITATION)].map((m) => m[1]));
    expect(all.length, "no test citations found — the citation pattern went stale").toBeGreaterThan(3);
  });

  it.each(sourceFiles())("%s cites only tests that exist", (file) => {
    const cited = new Set([...readFileSync(file, "utf8").matchAll(CITATION)].map((m) => m[1]));
    const missing = [...cited].filter(
      (name) => !SEARCH_ROOTS.some((root) => existsSync(join(root, name))),
    );
    expect(missing, `${file} names a test file that does not exist`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AND THE NAME HALF: A CITATION THAT QUOTES A TEST NAME QUOTES A REAL ONE.
//
// The sweep above proves the FILE is there, which is the cheap half. The
// expensive half is the quoted name — "pinned by prompt.test.ts, 'the prompt's
// bound is the REPOSITORY's bound'" — because that is what an auditor reads to
// decide a property is proven without opening anything. A file that exists under
// a citation whose named test has been renamed away is the worse defect of the
// two: the grep succeeds, the reader relaxes, and the pin is gone.
//
// THE THREE ARE NAMED HERE RATHER THAN PARSED OUT, deliberately. Every quoted
// name in this module is WRAPPED across lines — in a `*` block comment in
// types.ts and repository.ts, in a `//` block in chunk.ts — so a same-line regex
// (the shape src/lib/copilot/cited-tests-resolve.test.ts uses, where the
// citations really do sit on one line) would match NOTHING here and pass while
// proving nothing: an always-true guard, which is the other half of ruling
// W3/17. Three explicit assertions that go red on a rename beat a generic walk
// that cannot see its subject.
// ---------------------------------------------------------------------------

/**
 * A comment block as one line. Both comment styles this module uses wrap their
 * prose, and a quoted test name is routinely split across the wrap — so the
 * leading `*` or `//` of a continuation line is punctuation here, not a word
 * boundary, and a matcher that does not fold it away can never see the name.
 */
function flatten(path: string): string {
  return readFileSync(path, "utf8").replace(/\s*\n\s*(?:\*|\/\/)\s*/g, " ");
}

describe("a citation that quotes a test's NAME quotes one that is really in that file", () => {
  it("the register bound's two signposts name the tests that read it as text", () => {
    // REGISTER_READ_CAP (pure) and ASSET_ROW_CAP (server-only) are the same
    // number written twice, and the only thing holding them equal is a pair of
    // source scans. Both citations must land.
    const quoted = "the prompt's bound is the REPOSITORY's bound, read out of its source";
    expect(flatten(join(DIR, "types.ts"))).toContain(quoted);
    expect(flatten(join(DIR, "repository.ts"))).toContain(quoted);
    expect(readFileSync(join(DIR, "prompt.test.ts"), "utf8")).toContain(quoted);
  });

  it("the repository's second signpost names the home band's own drift check", () => {
    const quoted = "the mock's bound drifted from the repository's";
    expect(flatten(join(DIR, "repository.ts"))).toContain(quoted);
    expect(readFileSync(join("src/lib/home", "os-band.test.ts"), "utf8")).toContain(quoted);
  });

  it("the chunker's purity claim names the test that really drives it over the fixture PDF", () => {
    // `chunk.ts` says it is pure so `ingest.test.ts` can run the real chunker
    // over the real fixture. If that stopped being true the claim would be the
    // last thing to notice, so the fixture run is asserted, not just the name.
    expect(flatten(join(DIR, "chunk.ts"))).toContain("`ingest.test.ts` drives the real chunker");
    const ingest = readFileSync(join(DIR, "ingest.test.ts"), "utf8");
    expect(ingest).toContain("chunkManualPages");
    expect(ingest).toContain("fixtures/steripro-22b-manual.pdf");
  });
});
