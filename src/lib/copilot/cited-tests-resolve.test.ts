import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * EVERY TEST THIS MODULE'S COMMENTS CITE ACTUALLY EXISTS (ruling W3/17).
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
 * SCOPE IS src/lib/copilot ON PURPOSE, and the limit is worth stating rather
 * than leaving as an accident. The equipment instances this paragraph used to
 * name are GONE: register-bound.test.ts now exists
 * (src/components/client/equipment/register-bound.test.ts) and that module wrote
 * a sweep of its own (src/lib/equipment/citations.test.ts), so the wave-1 hole
 * is closed from both ends.
 *
 * WHAT STILL STOPS THE WIDENING is six citations in files no co-pilot lane may
 * edit, every one of them older than this programme's diff. Run the same two
 * rules over src/ and they are what comes back:
 *   - src/components/platform/copilot-prose.tsx cites "copilot-markdown.test.ts";
 *     the renderer really is driven against hostile input by this directory's
 *     markdown.test.ts and zz-xss-probe.test.ts.
 *   - src/lib/collection/types.ts cites "collection-no-autosend.test.ts".
 *   - src/lib/reports/report-window.ts cites "reports-view.test.ts".
 *   - src/lib/smile-assessment/funnel-progress-beacon.ts cites
 *     "funnel-progress-beacon.test.ts".
 *   - src/lib/agent-wiring/roster.ts quotes roster.test.ts, "the pre-visit
 *     summary is verified where it is rendered", which is not in that file.
 *   - src/lib/equipment/citations.test.ts NAMES "chunk.test.ts" in its own
 *     header, as the historical instance it was written about — the same shape
 *     as the SELF exemption below, and the reason a tree-wide sweep needs a rule
 *     for sweep headers before it is honest.
 * They are a HANDOFF, not a hole here. Widening this sweep to the whole tree is
 * the right move once all six are corrected, and the walk it would need already
 * exists directly below (testFilesByName recurses from SRC_DIR).
 */
const COPILOT_DIR = join(process.cwd(), "src", "lib", "copilot");
const SRC_DIR = join(process.cwd(), "src");

/** Every `*.test.ts` under src/, indexed by bare filename (several may share one). */
function testFilesByName(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
        const list = out.get(entry);
        if (list) list.push(path);
        else out.set(entry, [path]);
      }
    }
  };
  walk(SRC_DIR);
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
 * THIS FILE IS EXCLUDED FROM ITS OWN SWEEP, by name and for one reason: the
 * header above names the dangling citations it is handing to another lane
 * (register-bound, chunk), and a sweep that read its own handoff note would
 * report the note as the defect. Nothing else is exempt.
 */
const SELF = "cited-tests-resolve.test.ts";

function citationsIn(dir: string): Citation[] {
  const out: Citation[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === SELF) continue;
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    for (const match of source.matchAll(CITATION)) {
      // A file citing itself is not a signpost, it is a header. Skip it.
      if (match[1] === entry) continue;
      out.push({ from: entry, file: match[1], name: match[2] ?? null });
    }
  }
  return out;
}

describe("the tests the co-pilot's comments cite", () => {
  const known = testFilesByName();
  const citations = citationsIn(COPILOT_DIR);

  it("there are citations to check, so a silent zero cannot pass this suite", () => {
    // A sweep that finds nothing passes for the wrong reason. This module leans
    // on cross-file citations heavily (clearance, scope, the write gate, the
    // agent run loop), so a collapse to zero means the walk broke, not that the
    // comments stopped pointing anywhere.
    expect(citations.length).toBeGreaterThanOrEqual(20);
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
    const battery = readFileSync(join(COPILOT_DIR, "battery.test.ts"), "utf8");
    expect(battery).not.toMatch(/diary-write-tool\.test\.ts/);
    expect(battery).toMatch(/w2a-tools\.test\.ts, "A SAME-TURN CONFIRM NEVER REACHES THE DISPATCH"/);
    const w2a = readFileSync(join(COPILOT_DIR, "w2a-tools.test.ts"), "utf8");
    expect(w2a).toMatch(/A SAME-TURN CONFIRM NEVER REACHES THE DISPATCH/);
  });
});
