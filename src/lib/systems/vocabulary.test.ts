import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { AGENTS } from "@/lib/agent-wiring/roster";
import { SYSTEMS, SYSTEM_SLUGS } from "./catalog";
import { FIRST_STEPS, firstStepFor } from "./first-steps";
import { AUTHORED_VOCABULARY_SLUGS, SYSTEM_VOCABULARY, vocabularyFor } from "./vocabulary";

// ===========================================================================
// THE SWITCH-ON SENTENCE ON THE SCREEN IS THE SWITCH-ON SENTENCE IN THE RUNBOOK.
//
// The control panel now answers "what does switching this on start", which is
// the question an owner holding the switch is actually asking. That sentence
// already existed twice — in the agent roster and, written out from it, in
// docs/runbooks/agent-switch-on.md — and a third copy typed into a React
// component would have been the one that goes stale without anybody noticing,
// because it is the only one a practice reads.
//
// So this suite proves there is no third copy that can survive. For every
// system that is an agent, `starts` is asserted EQUAL to the roster's own
// `firstTick`, one system at a time: a rewritten agent rewrites the screen, and
// a screen rewritten on its own goes red. (String primitives have no object
// identity to pin, so this is value equality over the whole set rather than a
// reference check over one — the property that matters is the same: the two
// cannot differ.) The runbook is held to the roster by roster.test.ts, which
// fails when an agent loses its section there.
//
// Ten systems are not agents. Those are authored, marked `source: "module"`, and
// the split is asserted exactly rather than by "everything has something".
// ===========================================================================

const RUNBOOK_PATH = "docs/runbooks/agent-switch-on.md";

describe("the switch-on vocabulary is derived, not retyped", () => {
  it("every controllable system has a sentence", () => {
    const missing = SYSTEM_SLUGS.filter((s) => vocabularyFor(s) === null);
    expect(
      missing,
      `systems with no switch-on sentence: ${missing.join(", ")}. Add an agent to the ` +
        `roster or an entry to MODULE_VOCABULARY — never a placeholder.`,
    ).toEqual([]);
  });

  it("a rostered system's sentence EQUALS the roster's, for every one of them", () => {
    const rostered = AGENTS.filter((a) => a.slug !== null && SYSTEM_SLUGS.includes(a.slug));
    // Sanity: the join is not empty, or every assertion below is vacuous.
    expect(rostered.length).toBeGreaterThan(15);
    for (const agent of rostered) {
      const vocab = vocabularyFor(agent.slug as string);
      expect(vocab?.source, `${agent.slug} should be roster-derived`).toBe("roster");
      // Asserted for EVERY rostered system rather than for a sample: a copy
      // pasted into vocabulary.ts passes on the day it is pasted and fails the
      // day the agent's sentence moves, which is the day it would otherwise
      // have started lying to a practice.
      expect(vocab?.starts, `${agent.slug} starts-sentence drifted from the roster`).toBe(
        agent.firstTick,
      );
      expect(vocab?.needsFirst, `${agent.slug} needs-first drifted from the roster`).toBe(
        agent.needs,
      );
    }
  });

  it("the authored ten are exactly the systems that are not agents", () => {
    const rosterSlugs = new Set(AGENTS.map((a) => a.slug).filter((s): s is string => s !== null));
    const notAgents = SYSTEM_SLUGS.filter((s) => !rosterSlugs.has(s)).sort();
    expect([...AUTHORED_VOCABULARY_SLUGS].sort()).toEqual(notAgents);
    for (const slug of AUTHORED_VOCABULARY_SLUGS) {
      expect(vocabularyFor(slug)?.source, `${slug} should be authored`).toBe("module");
    }
  });

  it("no system whose sentence is authored is also an agent (no shadowing)", () => {
    // If both existed the roster would win silently, and the authored sentence
    // would sit in the file looking like the one on the screen.
    const rosterSlugs = new Set(AGENTS.map((a) => a.slug).filter((s): s is string => s !== null));
    for (const slug of AUTHORED_VOCABULARY_SLUGS) {
      expect(rosterSlugs.has(slug), `${slug} is authored AND rostered`).toBe(false);
    }
  });

  it("every rostered system still has its section in the switch-on runbook", () => {
    // The other half of "cannot drift from the runbook": the roster is the
    // runbook's source, and a system whose agent has no runbook section has a
    // sentence on screen with nothing behind it.
    const runbook = readFileSync(join(process.cwd(), RUNBOOK_PATH), "utf8");
    const missing = AGENTS.filter((a) => a.slug !== null && SYSTEM_SLUGS.includes(a.slug))
      .filter((a) => !runbook.includes(`\`${a.key}\``))
      .map((a) => a.key);
    expect(missing, `rostered systems with no runbook mention: ${missing.join(", ")}`).toEqual([]);
  });

  it("every sentence is a sentence, not a slug or a stub", () => {
    for (const slug of SYSTEM_SLUGS) {
      const vocab = SYSTEM_VOCABULARY[slug];
      expect(vocab.starts.length, `${slug} sentence is too short to be one`).toBeGreaterThan(40);
      expect(vocab.starts.trim().endsWith("."), `${slug} sentence does not end in a stop`).toBe(true);
      // No exclamation marks anywhere: PRODUCT.md's tone section, and the one
      // punctuation rule that is easy to break in a hurry.
      expect(vocab.starts).not.toContain("!");
    }
  });
});

describe("the first step is written once and shared", () => {
  it("every surface that has a first step has a real sentence and a real name", () => {
    for (const [key, step] of Object.entries(FIRST_STEPS)) {
      expect(step.key).toBe(key);
      expect(step.surface.length).toBeGreaterThan(2);
      expect(step.step.length).toBeGreaterThan(40);
      expect(step.step).not.toContain("!");
      // The practice's vocabulary, never the slug. "pre-visit-triage" is an
      // internal name; "Pre-visit questions" is what the practice calls it.
      expect(step.surface).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    }
  });

  it("every wave-1 surface has one", () => {
    for (const key of ["equipment", "it-desk", "pre-visit-triage", "dentally-write-back", "authorities"]) {
      expect(firstStepFor(key), `${key} has no first step`).toBeTruthy();
    }
  });

  it("the vocabulary carries the same first step, not a second copy of it", () => {
    for (const system of SYSTEMS) {
      const step = firstStepFor(system.slug);
      expect(SYSTEM_VOCABULARY[system.slug].firstStep).toBe(step ? step.step : null);
    }
  });

  it("an unknown surface has none rather than an invented one", () => {
    expect(firstStepFor("no-such-surface")).toBeNull();
  });
});
