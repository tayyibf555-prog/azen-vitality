// The screens a funnel's steps resolve to. What is held here is that every word
// on a mini is a word the RUNTIME says (verbatim, checked against its source),
// that the option VALUES survive (the icons are chosen by them) while the option
// WEIGHTS do not, that the builder's own vocabulary never leaks onto a drawing of
// a patient's screen, and that a step which cannot be drawn says so loudly rather
// than rendering an empty phone.
//
// Each assertion names the MUTATION it would catch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";
import { FLOW_TEMPLATES, buildScratchFlow, templateForGoal } from "./flow-templates";
import { questionById } from "./quiz";
import { resultCopy } from "./result-copy";
import { screenFor, type PhoneScreen } from "./flow-phone-screen";

const HERE = fileURLToPath(new URL("./", import.meta.url));

/**
 * The component these screens are a picture of. Read as source, because vitest
 * collects no .tsx: the only way to hold "this is what the patient sees" is to
 * check the words against the file that says them.
 *
 * Two normalisations, both of them things JSX does to the text on its way to the
 * screen: &apos; is folded back to an apostrophe, and every run of whitespace
 * collapses to one space (a sentence wrapped across two source lines renders as
 * one line, and it is the rendered line that must match).
 */
const QUIZ_SOURCE = readFileSync(
  `${HERE}../../components/assess/deterministic-assessment-quiz.tsx`,
  "utf8",
)
  .replace(/&apos;/g, "'")
  .replace(/\s+/g, " ");

function graph(nodes: FlowNode[], edges: FlowEdge[], entry = nodes[0]!.id): FlowGraph {
  return { schemaVersion: FLOW_SCHEMA_VERSION, entry, nodes, edges };
}

const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

/** welcome -> treatment -> timeline -> contact -> one result. */
function linear(): FlowGraph {
  return graph(
    [
      { id: "w", kind: "welcome" },
      { id: "q1", kind: "question", questionId: "treatment_interest" },
      { id: "q2", kind: "question", questionId: "timeline", transition: "Good to know." },
      { id: "c", kind: "contact" },
      { id: "r", kind: "outcome", band: "high" },
    ],
    [edge("w", "q1"), edge("q1", "q2"), edge("q2", "c"), edge("c", "r", "high")],
  );
}

function nodeOf(g: FlowGraph, id: string): FlowNode {
  return g.nodes.find((n) => n.id === id)!;
}

/* ---------------------------------------------------------------------------
 * A question screen.
 * ------------------------------------------------------------------------- */

describe("a question step draws its question", () => {
  // MUTATION: resolve the copy through describeNode (flow-edit.ts:455) and the
  // option VALUES are gone - every answer row then draws the same fallback icon,
  // because iconFor is keyed on the value.
  it("carries the bank's prompt and every option, value and label", () => {
    const g = linear();
    const screen = screenFor(nodeOf(g, "q2"), g, {}, 2);
    const bank = questionById("timeline")!;

    expect(screen.kind).toBe("question");
    if (screen.kind !== "question") return;
    expect(screen.questionId).toBe("timeline");
    expect(screen.prompt).toBe(bank.prompt);
    expect(screen.options).toEqual(bank.options.map((o) => ({ value: o.value, label: o.label })));
    expect(screen.options.length).toBeGreaterThan(1);
  });

  // MUTATION: drop the transition and the warm lead-in an owner wrote for that
  // step disappears from the preview while still showing in the funnel.
  it("carries the step's own lead-in, and null when it has none", () => {
    const g = linear();
    const withLine = screenFor(nodeOf(g, "q2"), g, {}, 2);
    expect(withLine.kind === "question" && withLine.transition).toBe("Good to know.");

    const noLine = screenFor(
      { id: "x", kind: "question", questionId: "motivation" },
      g,
      {},
      3,
    );
    expect(noLine.kind === "question" && noLine.transition).toBeNull();
  });

  // MUTATION: format the chip as `Step N`, or drop the "nearly there" branch, and
  // the preview stops matching deterministic-assessment-quiz.tsx:545.
  it("numbers the chip, and adds the nudge from the third question on", () => {
    const g = linear();
    const chipAt = (step: number): string => {
      const screen: PhoneScreen = screenFor(nodeOf(g, "q2"), g, {}, step);
      return screen.kind === "question" ? screen.chip : "";
    };
    expect(chipAt(2)).toBe("Question 2");
    expect(chipAt(3)).toBe("Question 3 · nearly there");
    expect(chipAt(9)).toBe("Question 9 · nearly there");
    expect(QUIZ_SOURCE).toContain("· nearly there");
  });

  // MUTATION: show the Back link on the first screen and the preview offers a
  // control the runtime does not draw (:531-543 renders an empty span there).
  it("has a Back link on every screen after the first", () => {
    const g = linear();
    expect(screenFor(nodeOf(g, "q2"), g, {}, 1).kind === "question").toBe(true);
    const first = screenFor(nodeOf(g, "q2"), g, {}, 1);
    const later = screenFor(nodeOf(g, "q2"), g, {}, 2);
    expect(first.kind === "question" && first.canGoBack).toBe(false);
    expect(later.kind === "question" && later.canGoBack).toBe(true);
  });

  // MUTATION: fill the bar from the node count instead of the step, and a
  // six-question funnel shows every screen at the same progress.
  it("fills the progress bar the way the runtime does, and fills it at the end", () => {
    const g = linear();
    const p = (step: number): number => {
      const s = screenFor(nodeOf(g, "q2"), g, {}, step);
      return s.kind === "question" ? s.progress : -1;
    };
    expect(p(1)).toBe(17); // Math.min(0.9, 1/6) * 100, to a whole percent
    expect(p(3)).toBe(50);
    expect(p(6)).toBe(90);
    expect(p(12)).toBe(90); // capped, exactly as :215 caps it
    expect(screenFor(nodeOf(g, "c"), g).progress).toBe(100);
    expect(screenFor(nodeOf(g, "r"), g).progress).toBe(100);
  });
});

/* ---------------------------------------------------------------------------
 * The first screen. There is no welcome SCREEN and no start button in the
 * runtime: the hero copy sits above the first question's prompt.
 * ------------------------------------------------------------------------- */

describe("a welcome step draws the first question, with the hero above it", () => {
  // MUTATION: draw a standalone welcome screen with a "Start" button and the
  // preview is a picture of a screen that does not exist - the funnel would jump
  // from the hero straight past a control nobody ever taps.
  it("is the first question's screen, prompt and answers and all", () => {
    const g = linear();
    const screen = screenFor(nodeOf(g, "w"), g, {}, 1);
    const bank = questionById("treatment_interest")!;

    expect(screen.kind).toBe("welcome-question");
    if (screen.kind !== "welcome-question") return;
    expect(screen.nodeId).toBe("w"); // the box it is drawn in is the welcome step's
    expect(screen.questionId).toBe("treatment_interest");
    expect(screen.prompt).toBe(bank.prompt);
    expect(screen.options).toEqual(bank.options.map((o) => ({ value: o.value, label: o.label })));
    expect(screen.chip).toBe("Question 1");
    expect(JSON.stringify(screen)).not.toMatch(/\bstart\b|\bbegin\b|get going/i);
  });

  // MUTATION: read the first question off graph.nodes order (or off the bank's
  // FIRST_QUESTION_ID, which is what the deleted mockup did) and a funnel that
  // opens on any other question previews the wrong screen entirely.
  it("asks the question the runtime's own walk asks first", () => {
    const g = graph(
      [
        { id: "w", kind: "welcome" },
        { id: "q1", kind: "question", questionId: "motivation" },
        { id: "q0", kind: "question", questionId: "treatment_interest" },
        { id: "c", kind: "contact" },
      ],
      [edge("w", "q1"), edge("q1", "c")],
      "w",
    );
    const screen = screenFor(nodeOf(g, "w"), g, {}, 1);
    expect(screen.kind === "welcome-question" && screen.questionId).toBe("motivation");
  });

  // MUTATION: prefer the campaign's copy over the step's and an owner who wrote
  // an opening line on the funnel sees the campaign's instead (:206-212 says the
  // step's line wins).
  it("prefers the step's own hero copy, then the campaign's, then the runtime's", () => {
    const g = linear();
    const campaign = { headline: "Campaign headline", intro: "Campaign intro" };

    const own = screenFor(
      { id: "w", kind: "welcome", headline: "Funnel headline", intro: "Funnel intro" },
      graph(
        [
          { id: "w", kind: "welcome", headline: "Funnel headline", intro: "Funnel intro" },
          ...g.nodes.slice(1),
        ],
        g.edges,
        "w",
      ),
      campaign,
      1,
    );
    expect(own.kind === "welcome-question" && own.headline).toBe("Funnel headline");
    expect(own.kind === "welcome-question" && own.intro).toBe("Funnel intro");

    const fromCampaign = screenFor(nodeOf(g, "w"), g, campaign, 1);
    expect(fromCampaign.kind === "welcome-question" && fromCampaign.headline).toBe(
      "Campaign headline",
    );
    expect(fromCampaign.kind === "welcome-question" && fromCampaign.intro).toBe("Campaign intro");

    const bare = screenFor(nodeOf(g, "w"), g, {}, 1);
    expect(bare.kind === "welcome-question" && bare.headline).toBeNull();
    expect(bare.kind === "welcome-question" && bare.intro).toBe(
      "Find the right next step for your smile. About 30 seconds, no wrong answers.",
    );
    expect(QUIZ_SOURCE).toContain(
      "Find the right next step for your smile. About 30 seconds, no wrong answers.",
    );
  });

  // MUTATION: treat a blank field as copy and the mini prints an empty headline
  // line where a sentence used to be - the runtime prints nothing at all (:551).
  it("treats a cleared line as absent, not as an empty line", () => {
    const g = linear();
    const screen = screenFor(nodeOf(g, "w"), g, { headline: "   ", intro: "" }, 1);
    expect(screen.kind === "welcome-question" && screen.headline).toBeNull();
    expect(screen.kind === "welcome-question" && screen.intro).not.toBe("");
  });

  // MUTATION: key the hero block off "there is a welcome step" instead of "this
  // is the first screen" and a funnel that opens straight on a question loses its
  // headline and intro in the preview while keeping them in the funnel (:515,549).
  it("draws the hero on the first screen even when there is no welcome step", () => {
    const g = graph(
      [
        { id: "q1", kind: "question", questionId: "treatment_interest" },
        { id: "c", kind: "contact" },
      ],
      [edge("q1", "c")],
      "q1",
    );
    const screen = screenFor(nodeOf(g, "q1"), g, { headline: "Straighter teeth" }, 1);
    expect(screen.kind).toBe("welcome-question");
    expect(screen.kind === "welcome-question" && screen.headline).toBe("Straighter teeth");
  });
});

/* ---------------------------------------------------------------------------
 * Loud when it cannot be drawn.
 * ------------------------------------------------------------------------- */

describe("a step that cannot be drawn says why, on the step", () => {
  // MUTATION: return an empty screen (or fall back to the bank's first question)
  // for an unknown id and a rule-2 failure previews as a working funnel, which is
  // the one thing the validation banner exists to prevent.
  it("names the missing question rather than drawing a blank phone", () => {
    const g = linear();
    const screen = screenFor({ id: "q9", kind: "question", questionId: "not_a_question" }, g, {}, 2);
    expect(screen.kind).toBe("error");
    if (screen.kind !== "error") return;
    expect(screen.detail).toContain("not_a_question");
    expect(screen.title.length).toBeGreaterThan(0);
    // Nothing to render as a question: no prompt and no options got through.
    expect(Object.keys(screen).sort()).toEqual(["detail", "kind", "nodeId", "progress", "title"]);
  });

  // MUTATION: draw a welcome step's copy wherever it sits, and an owner keeps
  // editing a headline no patient will ever read (welcomeNode returns the ENTRY
  // only - flow-runtime.ts:54-57).
  it("says so when a welcome step is not the one the funnel opens on", () => {
    const g = linear();
    const stray: FlowNode = { id: "w2", kind: "welcome", headline: "Second welcome" };
    const withStray = graph([...g.nodes, stray], g.edges, "w");
    const screen = screenFor(stray, withStray, {}, 1);
    expect(screen.kind).toBe("error");
    expect(screen.kind === "error" && screen.detail).toContain("w");
    expect(JSON.stringify(screen)).not.toContain("Second welcome");
  });

  // MUTATION: fall through to the contact screen and the welcome step previews as
  // a screen whose heading comes from somewhere else entirely.
  it("says so when there is no first question to sit above", () => {
    const g = graph(
      [
        { id: "w", kind: "welcome" },
        { id: "c", kind: "contact" },
        { id: "r", kind: "outcome", band: "low" },
      ],
      [edge("w", "c"), edge("c", "r", "low")],
      "w",
    );
    const screen = screenFor(nodeOf(g, "w"), g, {}, 1);
    expect(screen.kind).toBe("error");
    expect(screen.kind === "error" && screen.detail).toMatch(/contact step/i);
  });

  // MUTATION: swallow the walk's reason and a funnel that leads nowhere previews
  // as a blank screen with nothing to say which wire is missing.
  it("passes the walk's own reason through when the funnel stops dead", () => {
    const g = graph([{ id: "w", kind: "welcome" }], [], "w");
    const screen = screenFor(nodeOf(g, "w"), g, {}, 1);
    expect(screen.kind).toBe("error");
    expect(screen.kind === "error" && screen.detail).toContain("w");
  });

  // MUTATION: let the error screen claim any progress and a broken step draws a
  // full progress bar, reading as a finished funnel.
  it("shows no progress on a step that cannot be drawn", () => {
    const g = linear();
    const screen = screenFor({ id: "q9", kind: "question", questionId: "nope" }, g, {}, 2);
    expect(screen.progress).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * The contact and result screens: copy the runtime owns, mirrored exactly.
 * ------------------------------------------------------------------------- */

describe("the contact step draws the form the funnel actually asks", () => {
  const screen = screenFor({ id: "c", kind: "contact" }, linear());

  // MUTATION: invent a field (a surname, a preferred time) or drop the channel
  // row, and the preview promises a form the funnel does not show (:697-796).
  it("asks for a first name, how to reply, and the address that channel needs", () => {
    expect(screen.kind).toBe("contact");
    if (screen.kind !== "contact") return;
    expect(screen.nameField).toEqual({ key: "first-name", label: "First name", type: "text" });
    expect(screen.addressField).toEqual({ key: "mobile", label: "Mobile number", type: "tel" });
    expect(screen.channels.map((c) => c.label)).toEqual(["Text", "Email"]);
  });

  // MUTATION: add WhatsApp back to the channel row and the preview offers a
  // channel the practice cannot send on until its sender is connected (:666-671).
  it("does not offer WhatsApp, exactly as the runtime does not", () => {
    expect(JSON.stringify(screen)).not.toMatch(/whatsapp/i);
    expect(QUIZ_SOURCE).toMatch(/WhatsApp stays hidden/);
  });

  // MUTATION: reword any of these and the preview stops being a preview. Every
  // string is checked against the component's own source, so a change there goes
  // red here rather than drifting quietly.
  it("uses the runtime's words, verbatim", () => {
    if (screen.kind !== "contact") return;
    for (const line of [
      screen.eyebrow,
      screen.heading,
      screen.helper,
      screen.channelLegend,
      screen.nameField.label,
      screen.addressField.label,
      screen.submitLabel,
      screen.consent,
    ]) {
      expect(QUIZ_SOURCE, line).toContain(line);
    }
  });
});

describe("a result step draws the thank-you screen for its band", () => {
  // MUTATION: pick a different convention (a lead that was never created, or a
  // booking link the practice has not switched on) and the preview promises the
  // patient something the funnel will not do.
  it("uses the default path of result-copy: hot is contacted, no booking link", () => {
    const g = linear();
    for (const band of ["high", "medium", "low"] as const) {
      const screen = screenFor({ id: `r-${band}`, kind: "outcome", band }, g);
      expect(screen.kind).toBe("outcome");
      if (screen.kind !== "outcome") continue;
      expect(screen.band).toBe(band);
      expect(screen.body).toBe(resultCopy(band, band === "high", false));
    }
    // The three bands genuinely differ, so the convention is not flattening them.
    const bodies = (["high", "medium", "low"] as const).map((band) => {
      const s = screenFor({ id: "r", kind: "outcome", band }, linear());
      return s.kind === "outcome" ? s.body : "";
    });
    // Three bands, three different next steps: contacted, book yourself, come
    // back when you are ready (result-copy.ts:27-41).
    expect(new Set(bodies).size).toBe(3);
  });

  // MUTATION: ignore the authored headline and an owner's own result line never
  // shows; drop the fallback and a step with no headline draws a blank heading.
  it("prefers the step's headline and falls back to the runtime's", () => {
    const g = linear();
    const authored = screenFor(
      { id: "r", kind: "outcome", band: "high", headline: "Great news" },
      g,
    );
    expect(authored.kind === "outcome" && authored.headline).toBe("Great news");

    const bare = screenFor({ id: "r", kind: "outcome", band: "low" }, g);
    expect(bare.kind === "outcome" && bare.headline).toBe("Thank you");
    expect(QUIZ_SOURCE).toContain('"Thank you"');
  });
});

/* ---------------------------------------------------------------------------
 * What must never reach a mini.
 * ------------------------------------------------------------------------- */

describe("what a screen is not allowed to carry", () => {
  const EVERY_SCREEN = [
    ...FLOW_TEMPLATES.map((t) => t.build()),
    buildScratchFlow(),
  ].flatMap((g) => g.nodes.map((n, i) => ({ id: n.id, screen: screenFor(n, g, {}, i + 1) })));

  // MUTATION: map the bank's options straight through (`options: q.options`) and
  // every answer row ships the practice's scoring model in the page source.
  it("carries no option weights: the scoring model stays out of the DOM", () => {
    for (const { id, screen } of EVERY_SCREEN) {
      expect(JSON.stringify(screen), id).not.toMatch(/"weight"/);
      if (screen.kind === "question" || screen.kind === "welcome-question") {
        for (const o of screen.options) expect(Object.keys(o).sort(), id).toEqual(["label", "value"]);
      }
    }
  });

  // MUTATION: resolve the copy through describeNode and the builder's own
  // vocabulary - written for a card ABOUT a step - is printed on a drawing of the
  // patient's screen (flow-edit.ts:410-434,455-482).
  it("carries none of the builder's card copy", () => {
    const BUILDER_ONLY = [
      "Sits above the first question",
      "Uses the assessment",
      "Contacted straight away",
      "Followed up by the team",
      "Kept on the list for later",
      "Contact details",
      "Welcome screen",
      "Result ·",
      "Capture",
    ];
    for (const { id, screen } of EVERY_SCREEN) {
      const json = JSON.stringify(screen);
      for (const phrase of BUILDER_ONLY) expect(json, `${id} / ${phrase}`).not.toContain(phrase);
    }
  });

  // MUTATION: let one kind fall through to `undefined` (an easy switch to break)
  // and a mini renders nothing at all, in the middle of the strip.
  it("resolves every step of every template to a screen, and none of them to an error", () => {
    expect(EVERY_SCREEN.length).toBeGreaterThan(60);
    for (const { id, screen } of EVERY_SCREEN) {
      expect(screen, id).toBeTruthy();
      expect(screen.kind, id).not.toBe("error");
      expect(screen.nodeId, id).toBe(id);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Purity.
 * ------------------------------------------------------------------------- */

describe("resolving a screen changes nothing", () => {
  // MUTATION: cache a screen on the node (or sort the graph's nodes to find the
  // first question) and the second call sees a different graph from the first.
  it("does not mutate the graph, and returns the same screen twice", () => {
    const g = templateForGoal("invisalign").build();
    const before = JSON.stringify(g);
    const first = g.nodes.map((n, i) => JSON.stringify(screenFor(n, g, {}, i + 1)));
    expect(JSON.stringify(g)).toBe(before);
    expect(g.nodes.map((n, i) => JSON.stringify(screenFor(n, g, {}, i + 1)))).toEqual(first);
  });

  // MUTATION: hand the caller the module's own constant objects and one caller
  // sorting the channel row reorders it for every other mini on the strip.
  it("hands out copies of the contact step's field and channel objects", () => {
    const g = linear();
    const a = screenFor(nodeOf(g, "c"), g);
    const b = screenFor(nodeOf(g, "c"), g);
    if (a.kind !== "contact" || b.kind !== "contact") return;
    expect(a.channels).not.toBe(b.channels);
    expect(a.channels[0]).not.toBe(b.channels[0]);
    expect(a.nameField).not.toBe(b.nameField);
    a.channels.reverse();
    expect(b.channels.map((c) => c.key)).toEqual(["sms", "email"]);
  });
});

/* ---------------------------------------------------------------------------
 * The boundary.
 * ------------------------------------------------------------------------- */

describe("what the screen model is allowed to import", () => {
  const IMPORTS = /^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm;
  const SOURCE = readFileSync(`${HERE}flow-phone-screen.ts`, "utf8");

  // MUTATION: import flow-edit "just for describeNode" and the builder strings
  // are one keystroke away from the patient's screen again; import React and the
  // copy rules stop being testable in a node environment at all.
  it("imports the graph, the runtime walk, the bank and the result copy - nothing else", () => {
    const specifiers = [...SOURCE.matchAll(IMPORTS)].map((m) => m[1]!);
    expect(specifiers.sort()).toEqual(["./flow", "./flow-runtime", "./quiz", "./result-copy"]);
  });

  // MUTATION: pull in a server module and the builder panel - a "use client"
  // component - stops building.
  it("pulls in nothing server-only, because its caller runs in the browser", () => {
    expect(SOURCE).not.toContain("server-only");
    expect(SOURCE).not.toContain("next/headers");
  });
});
