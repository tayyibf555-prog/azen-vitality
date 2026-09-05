import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ===========================================================================
// EVERY TEST THIS DIRECTORY'S COMMENTS NAME HAS TO EXIST (ruling W3/17).
//
// The shell components under src/components/platform are read far more often
// than they are edited, and three of them defer a property to a test somewhere
// else: "the page cannot reach the thread, and copilot-page-chat.test.ts pins
// it", "the escaping is proved against hostile input over there". That deferral
// is the whole argument for why the property is not asserted here — a reader
// auditing the co-pilot's XSS story follows the name, and a later lane deciding
// whether the ban on dangerouslySetInnerHTML is actually enforced trusts it.
//
// IT WAS WRONG HERE. copilot-prose.tsx's security paragraph named a co-pilot
// markdown test that has never existed in this tree, while the real proof sat in
// src/lib/copilot/markdown.test.ts and its adversarial sibling zz-xss-probe.
// Nothing about the behaviour was a lie: the renderer really is driven against
// hostile input, and the file really is read as source for the innerHTML ban.
// Only the signpost pointed into thin air. The bad direction is not the auditor
// who greps and finds nothing — it is the auditor who takes the comment at face
// value and records an unproven property as proven, or the tidier who deletes
// the "stale" citation and with it the only pointer to where the check lives.
//
// SO THE SIGNPOSTS ARE CHECKED BY A TEST, not by the next reader. Scoped to this
// directory because that is the directory this lane may edit; the same sweep
// exists for src/lib/copilot (cited-tests-resolve.test.ts) and src/lib/equipment
// (citations.test.ts), and the three are meant to converge into one tree-wide
// walk once the remaining pre-programme citations elsewhere are corrected.
// ===========================================================================

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(DIR, "..", "..");

/**
 * THIS FILE IS EXCLUDED FROM ITS OWN SWEEP, and for one reason: the header above
 * describes the dangling citation it was written about, so a sweep that read its
 * own history note would report the note as the defect. Nothing else is exempt.
 */
const SELF = "platform-citations.test.ts";

/**
 * A citation is a `*.test.ts` filename appearing anywhere in the source — a
 * comment, a string, a path. Deliberately matched as a bare filename rather than
 * a path, because that is how the comments write it, and a name nobody can
 * resolve is the defect whether or not it carries a directory.
 */
const CITATION = /([A-Za-z0-9_.-]+\.test\.tsx?)/g;

/** Every `*.test.ts(x)` under src/, indexed by bare filename (several may share one). */
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
  /** The file doing the citing, e.g. "copilot-prose.tsx". */
  from: string;
  /** The bare filename cited, e.g. "markdown.test.ts". */
  file: string;
}

function citationsHere(): Citation[] {
  const out: Citation[] = [];
  for (const entry of readdirSync(DIR)) {
    if (entry === SELF) continue;
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    const source = readFileSync(join(DIR, entry), "utf8");
    for (const match of source.matchAll(CITATION)) {
      // A test file naming itself is a header, not a signpost. Skip it.
      if (match[1] === entry) continue;
      out.push({ from: entry, file: match[1] });
    }
  }
  return out;
}

describe("the tests this directory's comments cite", () => {
  const known = testFilesByName();
  const citations = citationsHere();

  it("every signpost this directory ships is still standing", () => {
    // A sweep that finds nothing passes for the wrong reason, and a floor set
    // loosely below the real count passes for a subtler one: deleting a citation
    // is the exact failure mode this file exists to catch, so the floor is the
    // count itself. FIVE citations across THREE files as this ships —
    // copilot-conversation.tsx and copilot-page-chat.tsx each defer the
    // page/thread split to copilot-page-chat.test.ts, and copilot-prose.tsx
    // names markdown.test.ts, zz-xss-probe.test.ts and this sweep. Adding a
    // sixth is fine; dropping to four means either the walk broke or a pointer
    // was quietly tidied away.
    expect(citations.length).toBeGreaterThanOrEqual(5);
    expect(new Set(citations.map((c) => c.from)).size).toBeGreaterThanOrEqual(3);
  });

  it("EVERY cited test file exists somewhere under src/", () => {
    const dangling = citations
      .filter((c) => !known.has(c.file))
      .map((c) => `${c.from} cites ${c.file}, which does not exist`);
    expect(dangling).toEqual([]);
  });

  it("the prose renderer's XSS signpost points at the tests that really pin it", () => {
    // The instance that failed, named so a regression is a red test with a
    // sentence rather than a line number. copilot-prose.tsx cannot assert its
    // own escaping (vitest collects .test.ts in the node environment, so the
    // renderer is exercised from a .ts test that imports it), which is exactly
    // why the comment defers — and the deferral has to land somewhere real.
    const prose = readFileSync(join(DIR, "copilot-prose.tsx"), "utf8");
    expect(prose).toMatch(/markdown\.test\.ts/);
    expect(prose).toMatch(/zz-xss-probe\.test\.ts/);

    const cited = ["markdown.test.ts", "zz-xss-probe.test.ts"];
    for (const name of cited) {
      const paths = known.get(name) ?? [];
      const rendersProse = paths.some((p) => {
        const source = readFileSync(p, "utf8");
        return source.includes("copilot-prose") && source.includes("renderToStaticMarkup");
      });
      expect(rendersProse, `${name} does not render copilot-prose with react-dom/server`).toBe(true);
    }

    // AND THE QUOTED TEST NAMES ARE REAL TOO. A citation that quotes the test it
    // means is the most useful kind and the easiest to falsify, because renaming
    // a test breaks nothing that runs. Two shapes have to be handled: only the
    // HEADER is prose (the body below it is full of quoted Tailwind class
    // strings, which are not citations of anything), and comment wrapping has to
    // be undone, because the quoted sentence spans two `//` lines and a scan that
    // did not rejoin them would find nothing and pass for the wrong reason.
    const header = prose
      .slice(0, prose.indexOf("function Inline"))
      .split("\n")
      .filter((line) => line.trimStart().startsWith("//"))
      .map((line) => line.trimStart().replace(/^\/\/\s?/, ""))
      .join(" ");
    const quoted = [...header.matchAll(/"([^"\n]+)"/g)]
      .map((m) => m[1])
      // Short quotes in this header are payload examples ("<script>") and
      // directives ("use client"), not test names.
      .filter((q) => q.length >= 20);
    expect(quoted.length, "the header stopped quoting the tests it defers to").toBeGreaterThanOrEqual(2);

    const bodies = cited.flatMap((name) => (known.get(name) ?? []).map((p) => readFileSync(p, "utf8")));
    const missing = quoted.filter((q) => !bodies.some((b) => b.includes(q)));
    expect(missing, "quoted in copilot-prose.tsx but in neither cited test").toEqual([]);
  });
});
