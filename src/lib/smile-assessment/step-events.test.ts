// THE DROP-OFF RULES, tested where they live: what a public caller is allowed to
// say, and what a pile of raw rows means once it is said.
//
// WHY THIS FILE IS LONG AND THE MODULE IS SHORT. Everything here is fed by an
// UNAUTHENTICATED endpoint, so "what does this reject" is not a detail of the
// implementation, it is the security posture. And the aggregation is the number an
// owner will rewrite a funnel because of, so every arithmetic edge — a replayed
// nonce, a branch that gains sessions, a step nobody reached — has to be a decided
// answer rather than whatever the loop happened to do.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MAX_EVENTS_PER_BATCH,
  MAX_FLOW_VERSION,
  MAX_STEP_INDEX,
  NONCE_MAX_LENGTH,
  NONCE_MIN_LENGTH,
  aggregateStepEvents,
  isValidFlowVersion,
  isValidNonce,
  isValidStepIndex,
  parseStepEventBatch,
  type StepEventRow,
} from "./step-events";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "step-events.ts"), "utf8");

/**
 * Source with comments stripped: what the file DOES, not what it explains. The
 * house idiom (flow-phone-mini.test.ts:45). Needed here specifically because this
 * module's header EXPLAINS why it must not import serviceClient — a raw-text scan
 * would fail on the sentence forbidding the thing.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = codeOnly(SOURCE);

/** A nonce of the shape the beacon mints (crypto.randomUUID). */
const NONCE = "8f14e45f-ceea-467a-9c73-e0c1c8e1f2ab";

function rows(...pairs: Array<[number, string]>): StepEventRow[] {
  return pairs.map(([stepIndex, nonce]) => ({ stepIndex, nonce }));
}

/** n distinct sessions all reaching every step in `steps`. */
function sessions(n: number, steps: number[]): StepEventRow[] {
  const out: StepEventRow[] = [];
  for (let i = 0; i < n; i++) {
    for (const stepIndex of steps) out.push({ stepIndex, nonce: `session-${i}` });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 1. Purity. This module is imported by a browser bundle's sibling and by a
 *    server route; it must stay importable by both.
 * ------------------------------------------------------------------------- */

describe("the rules module is pure", () => {
  // MUTATION: reach for serviceClient here "just to save a file". The beacon
  // helper sits beside this module and the public quiz imports that; one server
  // import in the same graph is how a service-role key ends up in a page bundle.
  it("imports nothing at all", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports).toEqual([]);
  });

  it("touches no I/O and no globals a bundle would have to polyfill", () => {
    for (const banned of ["serviceClient", "server-only", "fetch(", "process.env", "crypto."]) {
      expect(CODE, `found ${banned}`).not.toContain(banned);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The field validators, one at a time.
 * ------------------------------------------------------------------------- */

describe("a step index is a small, non-negative, whole ordinal", () => {
  it("accepts the ends of the range", () => {
    expect(isValidStepIndex(0)).toBe(true);
    expect(isValidStepIndex(MAX_STEP_INDEX)).toBe(true);
  });

  // MUTATION: bound the index with `< 1000` or not at all. step_index is an int
  // column fed by an anonymous caller; an unbounded ordinal is an unbounded number
  // of buckets in the aggregation and an unbounded x-axis on the chart.
  it("refuses anything past the top of the range", () => {
    expect(isValidStepIndex(MAX_STEP_INDEX + 1)).toBe(false);
    expect(isValidStepIndex(1e9)).toBe(false);
  });

  // MUTATION: use `>= 0` on a float and step 2.5 becomes its own bucket forever.
  it("refuses negatives, fractions and the non-numbers", () => {
    for (const v of [-1, 0.5, NaN, Infinity, -Infinity, "1", null, undefined, {}, []]) {
      expect(isValidStepIndex(v), `accepted ${String(v)}`).toBe(false);
    }
  });
});

describe("a flow version is the campaign's own monotonic counter", () => {
  it("accepts 0, which is what an un-authored campaign carries", () => {
    // 0078: flow_version defaults to 0 and only ever increases. Refusing 0 would
    // silently drop every event from a campaign that has never been saved.
    expect(isValidFlowVersion(0)).toBe(true);
    expect(isValidFlowVersion(7)).toBe(true);
    expect(isValidFlowVersion(MAX_FLOW_VERSION)).toBe(true);
  });

  it("refuses negatives, fractions and absurd versions", () => {
    for (const v of [-1, 1.5, MAX_FLOW_VERSION + 1, NaN, "3", null, undefined]) {
      expect(isValidFlowVersion(v), `accepted ${String(v)}`).toBe(false);
    }
  });
});

describe("a session nonce is opaque, bounded and unprintable-free", () => {
  it("accepts the shape the beacon mints", () => {
    expect(isValidNonce(NONCE)).toBe(true);
    expect(isValidNonce("a".repeat(NONCE_MIN_LENGTH))).toBe(true);
    expect(isValidNonce("a".repeat(NONCE_MAX_LENGTH))).toBe(true);
  });

  // MUTATION: accept any non-empty string. THIS is the field that decides whether
  // the table can hold PII: it is the only caller-chosen string that lands in it.
  // A closed charset means an email address, a name or a sentence cannot be stored
  // in it even if every other check upstream were removed.
  it("refuses anything that could carry a person in it", () => {
    for (const v of [
      "patient@example.com",
      "Jane Smith",
      "07700 900123",
      "a b",
      "nonce!",
      "nonce.with.dots",
      "<script>",
      "nonce\n",
      // Control characters, written as escapes: source-hygiene.test.ts fails the
      // whole tree on a raw control byte anywhere in a source file.
      "nonce\\t",
      "nonce-with-a-trailing-space ",
      "café-session-1234",
    ]) {
      expect(isValidNonce(v), `accepted ${JSON.stringify(v)}`).toBe(false);
    }
  });

  // MUTATION: drop the minimum and a one-character nonce collides across sessions,
  // which silently under-counts every step.
  it("refuses nonces that are too short to be a session and too long to be a nonce", () => {
    expect(isValidNonce("a".repeat(NONCE_MIN_LENGTH - 1))).toBe(false);
    expect(isValidNonce("a".repeat(NONCE_MAX_LENGTH + 1))).toBe(false);
    expect(isValidNonce("")).toBe(false);
  });

  it("refuses the non-strings", () => {
    for (const v of [null, undefined, 12345678, {}, [NONCE]]) {
      expect(isValidNonce(v), `accepted ${String(v)}`).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. The batch: closed fields, bounded, deduped.
 * ------------------------------------------------------------------------- */

describe("a posted batch is read as exactly four fields and nothing else", () => {
  it("reads a well-formed batch", () => {
    const batch = parseStepEventBatch({ flowVersion: 3, nonce: NONCE, steps: [0, 1, 2] });
    expect(batch).toEqual({ flowVersion: 3, nonce: NONCE, steps: [0, 1, 2] });
  });

  // MUTATION: spread the caller's object into the result "to keep it flexible".
  // funnel_event's `meta` bag is sanitised by a FUNCTION; this table's guarantee is
  // that there is no bag at all, and it starts here — an unknown key must not
  // survive the parse, whatever the route later does with it.
  it("carries no key the caller invented, whatever they call it", () => {
    const batch = parseStepEventBatch({
      flowVersion: 1,
      nonce: NONCE,
      steps: [0],
      email: "patient@example.com",
      name: "Jane Smith",
      meta: { phone: "07700 900123" },
      clientId: "someone-elses-practice",
    });
    expect(batch).not.toBeNull();
    expect(Object.keys(batch!).sort()).toEqual(["flowVersion", "nonce", "steps"]);
    expect(JSON.stringify(batch)).not.toContain("example.com");
    expect(JSON.stringify(batch)).not.toContain("Jane");
    expect(JSON.stringify(batch)).not.toContain("900123");
  });

  it("refuses a batch missing any required field", () => {
    expect(parseStepEventBatch({ nonce: NONCE, steps: [0] })).toBeNull();
    expect(parseStepEventBatch({ flowVersion: 1, steps: [0] })).toBeNull();
    expect(parseStepEventBatch({ flowVersion: 1, nonce: NONCE })).toBeNull();
  });

  it("refuses a batch that is not an object at all", () => {
    for (const v of [null, undefined, "steps", 3, [], true]) {
      expect(parseStepEventBatch(v), `accepted ${String(v)}`).toBeNull();
    }
  });

  // MUTATION: let one bad ordinal fail the whole batch, or let it through. Dropping
  // the entry and keeping the rest is what makes the beacon survivable across a
  // funnel edit mid-session; keeping it would put an unbounded ordinal in the table.
  it("drops the out-of-range steps and keeps the rest", () => {
    const batch = parseStepEventBatch({
      flowVersion: 1,
      nonce: NONCE,
      steps: [0, -1, 2, MAX_STEP_INDEX + 1, 4.5, "3", null, 5],
    });
    expect(batch?.steps).toEqual([0, 2, 5]);
  });

  it("refuses a batch with no usable step left", () => {
    expect(parseStepEventBatch({ flowVersion: 1, nonce: NONCE, steps: [] })).toBeNull();
    expect(parseStepEventBatch({ flowVersion: 1, nonce: NONCE, steps: [-1, 999] })).toBeNull();
    expect(parseStepEventBatch({ flowVersion: 1, nonce: NONCE, steps: "0,1,2" })).toBeNull();
  });

  // MUTATION: trust the caller's array length. One post is one INSERT of N rows;
  // without a cap, a single request writes as many rows as it likes.
  it("bounds the batch however many steps were sent", () => {
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH * 10 }, (_, i) => i % (MAX_STEP_INDEX + 1));
    const batch = parseStepEventBatch({ flowVersion: 1, nonce: NONCE, steps: many });
    expect(batch!.steps.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
  });

  // MUTATION: keep the duplicates and a session that re-renders step 3 six times
  // writes six rows for it. The aggregation would still be right (it dedups), and
  // the table would be six times the size for the same answer.
  it("collapses a repeated step inside one batch and sorts what is left", () => {
    const batch = parseStepEventBatch({ flowVersion: 1, nonce: NONCE, steps: [3, 1, 3, 0, 1, 3] });
    expect(batch?.steps).toEqual([0, 1, 3]);
  });

  it("refuses a batch whose version or nonce is not allowed", () => {
    expect(parseStepEventBatch({ flowVersion: -1, nonce: NONCE, steps: [0] })).toBeNull();
    expect(parseStepEventBatch({ flowVersion: 1, nonce: "Jane Smith", steps: [0] })).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 4. The aggregation. This is the number a funnel gets rewritten because of.
 * ------------------------------------------------------------------------- */

describe("an empty table is an empty funnel, not a crash and not a zero", () => {
  // MUTATION: divide by steps[0].views on an empty list and the owner's first ever
  // visit to the panel is a 500. MUTATION: report completion as 0% and a campaign
  // that has never been opened reads as one everybody abandoned.
  it("says nothing rather than something false", () => {
    expect(aggregateStepEvents([])).toEqual({ steps: [], sessions: 0, completionPct: null });
  });
});

describe("one step is one bar, and no drop-off at all", () => {
  it("has nothing before it to have dropped from", () => {
    const funnel = aggregateStepEvents(sessions(4, [0]));
    expect(funnel.steps).toEqual([{ stepIndex: 0, views: 4, dropOffPct: null, reachedPct: 100 }]);
    expect(funnel.sessions).toBe(4);
    // Everyone who started finished, because starting IS finishing here.
    expect(funnel.completionPct).toBe(100);
  });
});

describe("a straight funnel loses people between consecutive steps", () => {
  // 10 start, 8 reach step 1, 2 reach step 2.
  const funnel = aggregateStepEvents([
    ...sessions(2, [0, 1, 2]),
    ...rows([0, "a"], [1, "a"], [0, "b"], [1, "b"], [0, "c"], [1, "c"], [0, "d"], [1, "d"]),
    ...rows([0, "e"], [0, "f"], [0, "g"], [0, "h"]),
  ]);

  it("counts distinct sessions per step, in step order", () => {
    expect(funnel.steps.map((s) => [s.stepIndex, s.views])).toEqual([
      [0, 10],
      [1, 6],
      [2, 2],
    ]);
    expect(funnel.sessions).toBe(10);
  });

  // MUTATION: report the drop against the FIRST step instead of the previous one.
  // Then every later step reads as a bigger loss than it is, and the one screen
  // that is actually bleeding people is indistinguishable from the ones after it.
  it("measures each step's loss against the step immediately before it", () => {
    expect(funnel.steps[0].dropOffPct).toBeNull();
    expect(funnel.steps[1].dropOffPct).toBe(40); // 10 -> 6
    expect(funnel.steps[2].dropOffPct).toBeCloseTo(66.7, 1); // 6 -> 2
  });

  // MUTATION: conflate reachedPct with dropOffPct. They answer different questions
  // — "how many are still here" versus "how many did THIS screen cost me" — and a
  // chart showing one labelled as the other is worse than a chart showing neither.
  it("also says how much of the original traffic is still on each step", () => {
    expect(funnel.steps.map((s) => s.reachedPct)).toEqual([100, 60, 20]);
    expect(funnel.completionPct).toBe(20);
  });
});

describe("a session is counted once per step however many times it says so", () => {
  // MUTATION: count rows. A beacon that retries, a browser that restores the page
  // from bfcache, or a React re-render all fire again — and a render counter
  // dressed as a funnel would show the busiest step as the most popular.
  it("ignores a replayed nonce on the same step", () => {
    const funnel = aggregateStepEvents(
      rows([0, "a"], [0, "a"], [0, "a"], [1, "a"], [0, "b"], [1, "b"], [1, "b"]),
    );
    expect(funnel.steps).toEqual([
      { stepIndex: 0, views: 2, dropOffPct: null, reachedPct: 100 },
      { stepIndex: 1, views: 2, dropOffPct: 0, reachedPct: 100 },
    ]);
    expect(funnel.sessions).toBe(2);
  });

  it("still counts the same nonce once per DISTINCT step", () => {
    const funnel = aggregateStepEvents(rows([0, "a"], [1, "a"], [2, "a"]));
    expect(funnel.steps.map((s) => s.views)).toEqual([1, 1, 1]);
    expect(funnel.sessions).toBe(1);
  });
});

describe("rows arrive in whatever order the database hands them over", () => {
  // MUTATION: trust insertion order. created_at ordering is by TIME, and a session
  // that backs up to a previous screen emits a lower step index later — so the raw
  // rows are genuinely unsorted by step, always.
  it("sorts by step index, not by arrival", () => {
    const funnel = aggregateStepEvents(rows([2, "a"], [0, "a"], [1, "b"], [0, "b"], [1, "a"]));
    expect(funnel.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    expect(funnel.steps.map((s) => s.views)).toEqual([2, 2, 1]);
  });
});

describe("a branch can send MORE people to a later screen than an earlier one", () => {
  // A funnel is a graph, not a queue: a branch can skip step 1 entirely, so step 2
  // legitimately outnumbers it.
  const funnel = aggregateStepEvents([
    ...rows([0, "a"], [1, "a"], [2, "a"]),
    ...rows([0, "b"], [2, "b"]),
    ...rows([0, "c"], [2, "c"]),
  ]);

  // MUTATION: report the raw signed percentage and the chart draws a NEGATIVE
  // drop-off bar — a screen that "gained" 200% of the people who left it, which is
  // not a sentence about anybody leaving.
  it("reports no drop-off rather than a negative one", () => {
    expect(funnel.steps.map((s) => s.views)).toEqual([3, 1, 3]);
    expect(funnel.steps[1].dropOffPct).toBeCloseTo(66.7, 1);
    expect(funnel.steps[2].dropOffPct).toBe(0);
  });

  it("keeps reachedPct honest even so", () => {
    expect(funnel.steps.map((s) => s.reachedPct)).toEqual([100, 33.3, 100]);
  });
});

describe("a step nobody reached is a hole, and the caller decides how to show it", () => {
  // MUTATION: silently renumber the observed steps 0,1,2. Then a funnel where
  // question 2 is unreachable draws as though it does not exist, which is exactly
  // the bug an owner opened this panel to find.
  it("reports only the steps it has rows for, keeping their real ordinals", () => {
    const funnel = aggregateStepEvents(rows([0, "a"], [3, "a"], [0, "b"], [3, "b"]));
    expect(funnel.steps.map((s) => s.stepIndex)).toEqual([0, 3]);
    expect(funnel.steps[1].dropOffPct).toBe(0);
  });

  // MUTATION: make stepCount mandatory, or ignore it. The route knows the funnel's
  // length; the aggregation does not, and inventing one would be a lie.
  it("fills the gaps with zero when told how long the funnel is", () => {
    const funnel = aggregateStepEvents(rows([0, "a"], [0, "b"], [2, "a"]), { stepCount: 4 });
    expect(funnel.steps.map((s) => [s.stepIndex, s.views])).toEqual([
      [0, 2],
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    // 2 -> 0 is a total loss, and so is 1 -> 0. But 0 -> 1 has nothing to have
    // dropped FROM, so it is not a percentage of anything and must not read as 0%.
    expect(funnel.steps[1].dropOffPct).toBe(100);
    expect(funnel.steps[2].dropOffPct).toBeNull();
    expect(funnel.steps[3].dropOffPct).toBe(100);
    expect(funnel.steps.map((s) => s.reachedPct)).toEqual([100, 0, 50, 0]);
    expect(funnel.completionPct).toBe(0);
  });

  it("never drops a step it has rows for, even past the stated length", () => {
    // A funnel edited mid-flight: rows exist for an ordinal the new graph no longer
    // has. Losing them would make the tally quietly disagree with the table.
    const funnel = aggregateStepEvents(rows([0, "a"], [5, "a"]), { stepCount: 2 });
    expect(funnel.steps.map((s) => s.stepIndex)).toEqual([0, 1, 5]);
  });

  it("says nothing about completion when nobody reached the first step", () => {
    const funnel = aggregateStepEvents(rows([2, "a"]), { stepCount: 3 });
    expect(funnel.steps[0].views).toBe(0);
    expect(funnel.steps.every((s) => s.reachedPct === 0)).toBe(true);
    expect(funnel.completionPct).toBeNull();
  });
});

describe("the percentages are rounded once, where they are computed", () => {
  // MUTATION: round in the component. Two surfaces reading the same funnel would
  // then disagree in the third decimal, and a screenshot would stop matching a CSV.
  it("gives one decimal place and never a floating-point tail", () => {
    const funnel = aggregateStepEvents([...sessions(3, [0]), ...sessions(1, [1])]);
    // 3 -> 1 is 66.666...%
    expect(funnel.steps[1].dropOffPct).toBe(66.7);
    expect(funnel.steps[1].reachedPct).toBe(33.3);
    for (const s of funnel.steps) {
      if (s.dropOffPct !== null) expect(Number.isFinite(s.dropOffPct)).toBe(true);
      expect(String(s.reachedPct)).not.toMatch(/\.\d{2,}/);
    }
  });

  it("never reports more than a total loss or less than none", () => {
    const funnel = aggregateStepEvents(rows([0, "a"], [0, "b"], [0, "c"], [1, "a"]));
    for (const s of funnel.steps) {
      if (s.dropOffPct === null) continue;
      expect(s.dropOffPct).toBeGreaterThanOrEqual(0);
      expect(s.dropOffPct).toBeLessThanOrEqual(100);
    }
  });
});

describe("the aggregation does not mutate what it was handed", () => {
  // MUTATION: sort the caller's array in place. The route passes rows it may well
  // reuse, and an in-place sort of a shared array is the kind of bug that only ever
  // shows up under load.
  it("leaves the input rows in their original order", () => {
    const input = rows([2, "a"], [0, "a"], [1, "a"]);
    const before = input.map((r) => r.stepIndex);
    aggregateStepEvents(input);
    expect(input.map((r) => r.stepIndex)).toEqual(before);
  });
});
