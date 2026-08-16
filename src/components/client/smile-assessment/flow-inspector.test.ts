// CLICK THE SCREEN, EDIT THE SCREEN (A1), held at the seams a pure test cannot
// reach: that picking a screen opens THAT screen's editable surface, that the
// strip says which one is picked, and that the rail decides nothing on its way to
// the save.
//
// TECHNIQUE, and the split. vitest runs environment:"node" and collects only
// src/**\/*.test.ts, so this is renderToStaticMarkup for what the rail and the
// strip PAINT, plus the component sources read as text for what a static render
// cannot show: what a handler does, what the file imports, and where the one
// "use client" boundary is. Same split as flow-phone-mini.test.ts and
// campaign-recolour.test.ts.
//
// WHAT IS HELD ELSEWHERE and not restated here: what an edit does to a graph
// (flow-edit.test.ts), what a control MEANS and where a failure belongs
// (flow-inspect.test.ts), and every string on a mini (flow-phone-screen.test.ts).
// This suite is the wiring between them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowGraph } from "@/lib/smile-assessment/flow";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { FLOW_TEMPLATES, templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { insertionPoints, phoneFlowLayout } from "@/lib/smile-assessment/flow-phone-layout";
import { screenFor, type PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import { questionById } from "@/lib/smile-assessment/quiz";
import {
  describeEdge,
  insertableQuestionsAfter,
  swappableQuestions,
} from "@/lib/smile-assessment/flow-edit";
import type { FlowSelection } from "@/lib/smile-assessment/flow-inspect";
import { FlowInspector } from "./flow-inspector";
import { FlowPhoneCanvas } from "./flow-phone-canvas";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(HERE, name), "utf8");

const inspectorSource = read("flow-inspector.tsx");
const builderSource = read("flow-builder.tsx");
const phoneCanvasSource = read("flow-phone-canvas.tsx");
const miniSource = read("flow-phone-mini.tsx");
const panelSource = read("campaigns-panel.tsx");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** React escapes its way out; asserting on raw copy passes only by luck. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const invisalign = (): FlowGraph => templateForGoal("invisalign").build();

function nodeOf(graph: FlowGraph, id: string) {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/**
 * The question picker's own markup.
 *
 * SCOPED, and it has to be: every "then go to" row lists EVERY step in the funnel
 * by title, so a whole-document search for a question's prompt finds it whether or
 * not the picker offers it - and a test that cannot fail is worse than no test.
 */
function picker(html: string, nodeId: string): string {
  const at = html.indexOf(`<select id="q-${nodeId}"`);
  expect(at, `no question picker for ${nodeId}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</select>", at));
}

function rail(graph: FlowGraph, selection: FlowSelection | null): string {
  return renderToStaticMarkup(
    createElement(FlowInspector, {
      graph,
      selection,
      failures: validateFlow(graph).failures,
      onEdit: () => {},
      onSelect: () => {},
    }),
  );
}

function strip(
  graph: FlowGraph,
  extra: {
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    faultyNodeIds?: ReadonlySet<string>;
    selectLabels?: ReadonlyMap<string, string>;
    onAddAfter?: (id: string) => void;
    addLabels?: ReadonlyMap<string, string>;
  } = {},
): string {
  const layout = phoneFlowLayout(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const screens = new Map<string, PhoneScreen>();
  for (const n of layout.nodes) {
    const node = byId.get(n.id);
    if (node) screens.set(n.id, screenFor(node, graph, {}, n.step));
  }
  return renderToStaticMarkup(
    createElement(FlowPhoneCanvas, { layout, screens, idPrefix: "t", ...extra }),
  );
}

/* ---------------------------------------------------------------------------
 * 1. SELECTION: the rail shows the screen that was picked.
 * ------------------------------------------------------------------------- */

describe("the rail opens on the step that was selected", () => {
  // MUTATION: draw the rail off the first question node, or off a copy of the
  // selection held inside it, and every screen on the strip opens the same
  // inspector - which is the one bug a click-to-edit builder cannot survive.
  it("shows THAT step's question, and not another step's", () => {
    const g = invisalign();
    const smile = rail(g, { kind: "node", id: "q-smile_concern" });
    const timeline = rail(g, { kind: "node", id: "q-timeline" });

    // The head names the step, and the picker is set to its question.
    expect(smile).toContain(esc(questionById("smile_concern")!.prompt));
    expect(picker(smile, "q-smile_concern")).toContain(
      `<option value="smile_concern" selected="">`,
    );
    expect(smile).not.toContain('<select id="q-q-timeline"');

    expect(picker(timeline, "q-timeline")).toContain(`<option value="timeline" selected="">`);
    expect(timeline).not.toContain('<select id="q-q-smile_concern"');
    // Its own lead-in line, not the other step's.
    expect(smile).toContain('id="tr-q-smile_concern"');
    expect(smile).not.toContain('id="tr-q-timeline"');
  });

  // MUTATION: hand the picker the whole bank. The list is swappableQuestions,
  // which asks the validator - so a question already asked on this path, or one
  // about another treatment, is not on it.
  it("offers exactly the swaps the validator allows, and marks the current one", () => {
    const g = invisalign();
    const options = picker(rail(g, { kind: "node", id: "q-smile_concern" }), "q-smile_concern");
    const choices = swappableQuestions(g, "q-smile_concern");
    expect(choices.length).toBeGreaterThan(1);
    for (const id of choices) {
      expect(options, `${id} missing from the picker`).toContain(esc(questionById(id)!.prompt));
    }
    // ...and NOTHING else in the bank: one option per allowed swap.
    expect(occurrences(options, "<option")).toBe(choices.length);
    // treatment_interest is asked earlier on this path, so offering it here would
    // ask the same thing twice (rule 8).
    expect(options).not.toContain('value="treatment_interest"');
    expect(options).toContain('<option value="smile_concern" selected="">');
  });

  // MUTATION: leave the picker enabled on a branched step and every choice on it
  // refuses - a control that looks live and does nothing.
  it("locks the picker on a step whose answers are routed one by one, and says why", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-treatment_interest" });
    expect(html).toContain("disabled=");
    expect(html).toContain(esc("Point them the same way below"));
  });

  it("shows the copy fields each kind of screen actually has", () => {
    const g = invisalign();
    const welcome = rail(g, { kind: "node", id: "welcome" });
    expect(welcome).toContain('id="wh-welcome"');
    expect(welcome).toContain('id="wi-welcome"');

    const result = rail(g, { kind: "node", id: "result-high" });
    expect(result).toContain('id="hl-result-high"');
    // A result screen has no opening line and no question to pick.
    expect(result).not.toContain('id="wi-');
    expect(result).not.toContain('<select id="q-');
  });

  it("says so plainly when nothing is selected", () => {
    expect(rail(invisalign(), null)).toContain("Nothing selected");
  });
});

/* ---------------------------------------------------------------------------
 * 2. THE BRANCH LIST: where each answer goes, on the step it leaves.
 * ------------------------------------------------------------------------- */

describe("the rail lists where each answer goes", () => {
  // MUTATION: draw the rows off `edgesFrom` and re-derive the index, and two
  // answers pointed at the same screen become one row that edits the other's wire
  // (outgoingEdges exists for exactly this - flow-edit.test.ts holds the rule).
  it("draws one row per outgoing wire, each with its own destination picker", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-treatment_interest" });
    // Two wires out of the treatment step: the Invisalign branch and the rest.
    expect(occurrences(html, 'aria-label="Where ')).toBe(2);
    // Named by the ANSWER a patient taps, off the question bank - not by the
    // node id the wire happens to point at.
    const branchLabel = questionById("treatment_interest")!.options.find(
      (o) => o.value === "invisalign",
    )!.label;
    expect(html).toContain(esc(`Where “${branchLabel}” goes`));
    expect(html).toContain(esc("Where “Anything else” goes"));
  });

  it("shows the three band routes on the contact step", () => {
    const html = rail(invisalign(), { kind: "node", id: "contact" });
    expect(occurrences(html, 'aria-label="Where ')).toBe(3);
    expect(html).toContain("High intent");
  });

  // MUTATION: drop the uncovered-answer list and the one failure an owner cannot
  // diagnose from the picture - an answer that leads nowhere - has no control.
  it("lists the answers that lead nowhere, with a way to route them", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline" && e.answer === null);
    const narrowed: FlowGraph = {
      ...g,
      edges: g.edges.map((e, i) => (i === index ? { ...e, answer: "asap" } : e)),
    };
    const html = rail(narrowed, { kind: "node", id: "q-timeline" });
    expect(html).toContain("Answers that lead nowhere");
    expect(html).toContain("Route it");
  });

  /**
   * THE CONTACT STEP'S BANDS ARE ANSWERS TOO. Rule 3 reports an unrouted band the
   * same way it reports an unrouted option, and before A1's parity pass the rail
   * knew only about options - so a band route deleted with the Trash button in
   * this very list could not be put back from anywhere in the builder.
   *
   * MUTATION: narrow uncoveredAnswers to question steps and this goes red while
   * every other test stays green (a contact step with all three routes shows
   * nothing either way - that is the trap).
   */
  it("offers the repair for a band route deleted off the contact step", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      edges: g.edges.filter((e) => !(e.from === "contact" && e.answer === "high")),
    };
    expect(validateFlow(broken).failures.some((f) => f.code === "band_uncovered")).toBe(true);

    const html = rail(broken, { kind: "node", id: "contact" });
    expect(html).toContain("Answers that lead nowhere");
    expect(html).toContain("High intent");
    expect(html).toContain("Route it");
  });

  /**
   * A STEP THAT LEADS NOWHERE. The empty branch list used to say "add a connection
   * on the wiring view below" - and the wiring view could not add one either. The
   * copy pointed at the component this pass retired, which is how the hole was
   * found; the control is what made retiring it honest.
   */
  it("connects a step that has no route out, from the rail itself", () => {
    const g = invisalign();
    const stranded: FlowGraph = { ...g, edges: g.edges.filter((e) => e.from !== "welcome") };
    const html = rail(stranded, { kind: "node", id: "welcome" });

    expect(html).toContain("This step leads nowhere");
    expect(html).not.toContain("wiring view");
    expect(html).toContain("Connect this step to");
    expect(html).toContain('id="link-welcome"');
    // Every other screen is offered, and never itself.
    const at = html.indexOf('id="link-welcome"');
    const picker = html.slice(at, html.indexOf("</select>", at));
    expect(occurrences(picker, "<option")).toBe(g.nodes.length); // the placeholder + n-1
    expect(picker).not.toContain('value="welcome"');

    // ...and it is not offered on a step that already leads somewhere, nor on a
    // result step, which is terminal by rule 7 and correct as a dead end.
    expect(rail(g, { kind: "node", id: "welcome" })).not.toContain("Connect this step to");
    expect(rail(g, { kind: "node", id: "result-high" })).not.toContain("Connect this step to");
  });

  // MUTATION: leave the order of the branches to the shape of the graph. It is the
  // order they are DRAWN in, and on a step with no "anything else" wire it is also
  // the route a deleted predecessor re-points to (defaultEdgeOf).
  it("puts the branch order on the rows, and only where there is an order", () => {
    const g = invisalign();
    const branched = rail(g, { kind: "node", id: "q-treatment_interest" });
    expect(occurrences(branched, 'aria-label="Move ')).toBe(4); // two rows, up and down
    expect(branched).toContain(esc("” up"));
    expect(branched).toContain(esc("” down"));

    // One wire out: nothing to reorder, so no controls at all.
    expect(rail(g, { kind: "node", id: "q-timeline" })).not.toContain('aria-label="Move ');
  });

  /**
   * ADD A SCREEN, FROM THE STEP. The + on the strip does this in one click; the
   * rail is where the question is CHOSEN, and it is the only one of the two that
   * exists at phone width, where the strip has no gutters to put a + in.
   */
  it("offers the questions that may follow this step, and none that may not", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-timeline" });
    expect(html).toContain("Add a screen after this one");

    const at = html.indexOf('id="add-q-timeline"');
    expect(at, "no add-a-screen picker").toBeGreaterThan(-1);
    const picker = html.slice(at, html.indexOf("</select>", at));
    const offered = insertableQuestionsAfter(g, "q-timeline");
    expect(offered.length).toBeGreaterThan(0);
    for (const id of offered) {
      expect(picker, `${id} is not offered`).toContain(esc(questionById(id)!.prompt));
    }
    // Rule 8: the question this step already asks is not on the list.
    expect(picker).not.toContain(esc(questionById("timeline")!.prompt));

    // A terminal step has no wire to splice into, so the control is absent rather
    // than present and permanently refusing.
    expect(rail(g, { kind: "node", id: "result-high" })).not.toContain(
      "Add a screen after this one",
    );
  });
});

/* ---------------------------------------------------------------------------
 * 3. VALIDATION, BESIDE THE FIELD IT IS ABOUT.
 * ------------------------------------------------------------------------- */

describe("a failure is printed next to the control that fixes it", () => {
  // MUTATION: leave the failures to the banner alone. The banner is above the
  // canvas and lists everything; the owner fixing one step is looking at the rail.
  it("prints an uncovered answer under the branch list, in the rail", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline" && e.answer === null);
    const narrowed: FlowGraph = {
      ...g,
      edges: g.edges.map((e, i) => (i === index ? { ...e, answer: "asap" } : e)),
    };
    const failures = validateFlow(narrowed).failures;
    const uncovered = failures.find((f) => f.code === "option_uncovered");
    expect(uncovered).toBeTruthy();
    expect(rail(narrowed, { kind: "node", id: "q-timeline" })).toContain(esc(uncovered!.message));
  });

  it("prints a step with no question under its picker", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-timeline" ? { id: n.id, kind: "question", questionId: "not_a_question" } : n,
      ),
    };
    const html = rail(broken, { kind: "node", id: "q-timeline" });
    expect(html).toContain("not in the question bank");
    // ...and the picker still names what the step is set to, or it would render
    // as somebody else's question.
    expect(html).toContain(esc("Not in the question bank: “not_a_question”"));
  });
});

/* ---------------------------------------------------------------------------
 * 4. THE STRIP: selectable, and only when it is meant to be.
 * ------------------------------------------------------------------------- */

describe("the phone strip carries the selection", () => {
  // MUTATION: ring every screen, or none. The ring is the answer to "which screen
  // am I editing" and there is exactly one answer.
  it("rings exactly the selected screen, in both renderings", () => {
    const g = invisalign();
    const html = strip(g, { selectedId: "q-timeline", onSelect: () => {} });
    const nodes = phoneFlowLayout(g).nodes.length;
    // One button per screen, twice over: the strip and the small-screen list.
    expect(occurrences(html, "<button")).toBe(nodes * 2);
    expect(occurrences(html, 'aria-pressed="true"')).toBe(2);
    expect(occurrences(html, 'aria-pressed="false"')).toBe((nodes - 1) * 2);
    expect(html).toContain("ring-blue-royal");
  });

  // MUTATION: mark a broken step with the selection ring and the two states -
  // "this is the one I am editing" and "this one is broken" - stop being
  // distinguishable.
  it("rings a step a failure named in the danger colour, and selection still wins", () => {
    const g = invisalign();
    const faulty = strip(g, { onSelect: () => {}, faultyNodeIds: new Set(["q-timeline"]) });
    expect(occurrences(faulty, "ring-danger")).toBe(2);

    const both = strip(g, {
      selectedId: "q-timeline",
      onSelect: () => {},
      faultyNodeIds: new Set(["q-timeline"]),
    });
    expect(occurrences(both, "ring-danger")).toBe(0);
    expect(occurrences(both, 'aria-pressed="true"')).toBe(2);
  });

  // MUTATION: name the buttons in the strip and it has to read the question bank -
  // the import flow-phone-mini.test.ts bans, and the reason describeNode's
  // owner-facing words are computed by the builder and passed in as data.
  it("wears the labels it is handed, and writes none of its own", () => {
    const html = strip(invisalign(), {
      onSelect: () => {},
      selectLabels: new Map([["q-timeline", "Question: When would you like to start?"]]),
    });
    expect(html).toContain('aria-label="Question: When would you like to start?"');
    expect(codeOnly(phoneCanvasSource)).not.toContain("describeNode");
    expect(codeOnly(phoneCanvasSource)).not.toContain("questionById");
  });

  // MUTATION: leave the wrapper role="img" once it holds buttons. A control
  // inside an image role is a control no screen reader can reach.
  it("stops being a picture the moment it becomes editable", () => {
    expect(strip(invisalign(), { onSelect: () => {} })).toContain('role="group"');
    expect(strip(invisalign())).toContain('role="img"');
  });

  // MUTATION: position the minis inside the button and the wires - drawn at the
  // layout's coordinates on a layer that knows nothing about selection - stop
  // meeting the screens' edges.
  it("leaves the positioning to the layout, with the button inside it", () => {
    const g = invisalign();
    const html = strip(g, { onSelect: () => {} });
    for (const n of phoneFlowLayout(g).nodes) {
      expect(html).toContain(`left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`);
    }
    expect(html).not.toContain("transform");
  });

  /* ---------------------------------------------------------------------------
   * THE + BETWEEN THE SCREENS: A1's add-a-screen affordance on the canvas itself.
   * ------------------------------------------------------------------------- */

  // MUTATION: place the + by hand ("x + w + 44") and the arithmetic leaves the
  // module a test can reach. Every number below is insertionPoints'.
  it("draws a + in the gutter after every screen that has a wire out", () => {
    const g = invisalign();
    const points = insertionPoints(phoneFlowLayout(g));
    const html = strip(g, { onSelect: () => {}, onAddAfter: () => {} });

    for (const p of points) {
      expect(html, `no + after ${p.nodeId}`).toContain(
        `left:${p.x}px;top:${p.y}px;width:${p.size}px;height:${p.size}px`,
      );
    }
    // One on the strip and one in the small-screen list, per screen that gets one
    // (each carries the same words twice over, as its name and as its tooltip).
    expect(occurrences(html, 'aria-label="Add a screen after')).toBe(points.length * 2);
    // ...and none on a result step, which is terminal and has nothing to add to.
    expect(points.some((p) => p.nodeId === "result-high")).toBe(false);
  });

  // MUTATION: make the + unconditional and the wizard's stage-2 preview - a funnel
  // with no campaign to be saved against - grows an editing control per screen.
  it("has no + at all without a callback for it", () => {
    const g = invisalign();
    const html = strip(g, { onSelect: () => {} });
    expect(html).not.toContain("Add a screen after");
    const nodes = phoneFlowLayout(g).nodes.length;
    expect(occurrences(html, "<button")).toBe(nodes * 2);
  });

  // MUTATION: name every + the same and the a11y tree has nine identical "add"
  // buttons on a nine-step funnel. The name is the builder's, off describeNode -
  // this file may not read the question bank (flow-phone-mini.test.ts pins it).
  it("wears the + labels it is handed", () => {
    const html = strip(invisalign(), {
      onSelect: () => {},
      onAddAfter: () => {},
      addLabels: new Map([["welcome", "Add a screen after “Welcome screen”"]]),
    });
    expect(html).toContain(esc('Add a screen after “Welcome screen”'));
    // Anything unnamed still says what it does.
    expect(html).toContain("Add a screen after this one");
  });
});

/* ---------------------------------------------------------------------------
 * 5. THE WIRING: one selection, two canvases, one save.
 * ------------------------------------------------------------------------- */

describe("the builder holds the selection and the graph", () => {
  const code = codeOnly(builderSource);

  // MUTATION: give the strip its own selection state and the ring on the phone and
  // the rail beside it become two answers to "what am I editing".
  //
  // PIN CHANGED: this used to require "<FlowCanvas" and its `selectedNodeId` here
  // too, when the builder mounted both canvases off one selection. One canvas is
  // left; what still has to hold is that the strip and the rail read the SAME
  // selection, which is what the two remaining assertions say.
  it("drives the strip and the rail from ONE selection", () => {
    expect(occurrences(code, "useState<FlowSelection | null>(null)")).toBe(1);
    expect(code).toContain("<FlowPhoneCanvas");
    expect(code).toContain("selectedId={selected?.kind === \"node\" ? selected.id : null}");
    expect(code).toContain("selection={selected}");
  });

  /**
   * THE RETIREMENT, held as the thing it actually turned on.
   *
   * PIN REPLACED. Its predecessor said "keeps the wiring canvas mounted and
   * selectable", on the argument that the cards were the only place a CONNECTION
   * could be picked. That was true of the drawing and false of the builder: every
   * wire out of a step is a row in that step's rail, and every step is a button on
   * the strip. So the claim worth pinning is not "the canvas is mounted" but
   * "nothing became unreachable when it came down" - which is checkable, per
   * connection, against a real funnel.
   *
   * MUTATION: drop the "Edit" button off a branch row (or draw the rows off
   * `edgesFrom` instead of `outgoingEdges`, losing the index) and a connection
   * becomes uneditable, with the drawing that used to reach it gone.
   */
  it("leaves every connection reachable from the strip, with the cards gone", () => {
    expect(code).not.toContain("<FlowCanvas");
    expect(builderSource).not.toContain("./flow-canvas");
    expect(code).toContain("onSelect={(id) => select({ kind: \"node\", id })}");

    const g = invisalign();
    const onStrip = new Set(phoneFlowLayout(g).nodes.map((n) => n.id));
    for (const node of g.nodes) {
      expect(onStrip, `${node.id} is not on the strip`).toContain(node.id);
    }

    // ...INCLUDING A STEP NOTHING LEADS TO. Rule 5 names it in the banner, and a
    // step the banner names has to be selectable or the failure is unfixable. The
    // layout parks a stranded node rather than dropping it, so the strip carries
    // it exactly as the card canvas did.
    const orphaned: FlowGraph = {
      ...g,
      edges: g.edges.filter((e) => !(e.from === "contact" && e.answer === "high")),
    };
    const orphanFailure = validateFlow(orphaned).failures.find((f) => f.code === "orphan");
    expect(orphanFailure?.where).toBe("result-high");
    expect(phoneFlowLayout(orphaned).nodes.map((n) => n.id)).toContain("result-high");
    expect(rail(orphaned, { kind: "node", id: "result-high" })).toContain('id="hl-result-high"');
    // ...and each of its wires is a row, with the index that addresses it, in the
    // rail of the step it leaves.
    g.edges.forEach((edge, index) => {
      const html = rail(g, { kind: "node", id: edge.from });
      expect(html, `edge ${index} (${edge.from} -> ${edge.to}) has no row`).toContain(
        `Where “${esc(describeEdge(edge, nodeOf(g, edge.from)) ?? "Straight on")}” goes`,
      );
      // Opening that connection's own rail from the row is what replaces clicking
      // the wire on the retired canvas.
      expect(rail(g, { kind: "edge", index })).toContain("Taken when the answer is");
    });
  });

  // MUTATION: have the + select the screen and open something, or add the screen
  // in the strip. It is one intent, through the one channel every other control
  // uses, so its refusal ("nothing left to add on this route") surfaces in the
  // same banner - and a + that cannot act SAYS so rather than doing nothing.
  it("turns the strip's + into the same edit intent as everything else", () => {
    expect(code).toContain('onAddAfter={(id) => onEdit({ kind: "add-screen", nodeId: id })}');
    expect(code).toContain("addLabels={addLabels}");
    // Named off the same card the selection label is: one description per step.
    expect(code).toContain("add.set(n.id, `Add a screen after “${card.title}”`)");
  });

  // MUTATION: apply the intent in the rail. The rail would then need the graph,
  // the ops and the refusal channel - which is the whole of the builder, moved
  // into a file no test can drive.
  it("turns a rail intent into a pure edit result, and nothing else", () => {
    expect(code).toContain("const result = applyInspectorEdit(graph, selected, edit);");
    expect(code).toContain("onEdit={onEdit}");
    // The refusal is shown, never swallowed: `apply` is the one channel.
    expect(code).toContain("setRefusal(result.reason)");
  });

  // MUTATION: the one this cost a rewrite. Clearing the selection alongside a
  // destructive edit clears the REFUSAL with it (moving the selection resets it),
  // so "connect it first" never reaches the screen and the button reads as dead.
  // PIN CHANGED: selectionAfterEdit now takes the PRE-EDIT graph as well, so an
  // insertion can be answered with the step it just made. Handing it `result.graph`
  // would make the planner name a step against a funnel that already holds it.
  it("moves the selection only when the edit landed, and never from the rail", () => {
    expect(code).toContain(
      "if (result.ok) setSelected((current) => selectionAfterEdit(current, edit, graph));",
    );
    // The rail fires the edit and nothing else: no destructive button clears the
    // selection on its own.
    const railCode = codeOnly(inspectorSource);
    for (const kind of ["remove-node", "remove-edge", "insert-question"]) {
      const at = railCode.indexOf(`kind: "${kind}"`);
      expect(at, `${kind} is not fired from the rail`).toBeGreaterThan(-1);
      // ...and the next 120 characters of that handler do not clear the selection.
      expect(railCode.slice(at, at + 120)).not.toContain("onSelect(null)");
    }
  });

  // MUTATION: send the draft graph anywhere but the one PUT route with its
  // expectedVersion, and the compliance scan, the server-side validation and the
  // version bump are all bypassed.
  it("saves the edited draft through the one flow route, with its version check", () => {
    expect(code).toContain("flow: graph,");
    expect(code).toContain("expectedVersion: version");
    expect(code).toContain('method: "PUT"');
    expect(occurrences(code, "await fetch(")).toBe(1);
    expect(code).toContain(
      "/api/smile-assessment/campaign/${encodeURIComponent(campaignSlug)}/flow?client=${encodeURIComponent(clientSlug)}",
    );
  });

  // MUTATION: put the Escape handler on `document` and a builder inside a dialog
  // swallows that dialog's Escape. MUTATION: drop it and the only way out of a
  // selection is the mouse.
  it("deselects on Escape, from the container, only when something is selected", () => {
    expect(code).toContain('if (event.key !== "Escape" || selected === null) return;');
    expect(code).toContain("select(null);");
    expect(code).not.toContain("document.addEventListener");
    expect(code).not.toContain("window.addEventListener");
  });

  // The bonus: arrows walk the strip. MUTATION: put this handler on the builder
  // and an arrow key inside a text field in the rail moves the selection instead
  // of the cursor.
  it("walks the strip with the arrow keys, scoped to the strip", () => {
    expect(code).toContain('event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0');
    expect(code).toContain("stepAfter(");
    const handlerAt = code.indexOf("ArrowRight");
    const stripAt = code.indexOf("<FlowPhoneCanvas");
    const railAt = code.indexOf("<FlowInspector");
    expect(handlerAt).toBeLessThan(stripAt);
    expect(handlerAt).toBeLessThan(railAt);
  });
});

/* ---------------------------------------------------------------------------
 * 6. THE DOCTRINE: rules in pure modules, components dumb - and the RSC boundary.
 * ------------------------------------------------------------------------- */

describe("the rail decides nothing", () => {
  const code = codeOnly(inspectorSource);

  // MUTATION: call setWelcomeCopy (or addEdge, or removeNode) from a handler in
  // the rail. Every one of those calls carries a rule - which field to re-send,
  // where an unrouted answer goes - into a file vitest collects nothing from.
  it("imports only READ helpers from flow-edit: not one write op", () => {
    for (const op of [
      "setWelcomeCopy",
      "setOutcomeHeadline",
      "setQuestionTransition",
      "setNodeQuestion",
      "setEdgeAnswer",
      "setEdgeTarget",
      "setEdgeTransition",
      "addEdge",
      "removeEdge",
      "removeNode",
      "insertQuestionOnEdge",
    ]) {
      expect(code, `the rail calls ${op}`).not.toContain(op);
    }
    // ...and it applies nothing either: the builder owns the draft graph.
    expect(code).not.toContain("applyInspectorEdit");
    expect(code).not.toContain("setGraph");
    expect(code).not.toContain("fetch(");
  });

  // MUTATION: build the choices, the uncovered answers or the branch rows by
  // hand here and each becomes a second copy of a rule that already exists.
  // PIN CHANGED: `uncoveredOptions` is now `uncoveredAnswers` - the same rule,
  // generalised off routableAnswers so it covers the contact step's bands as well
  // as a question's options, which is what rule 3 has always reported. The list
  // grew by the helpers A1's parity pass added.
  it("reads its lists from the pure layer", () => {
    for (const helper of [
      "swappableQuestions",
      "insertableQuestions",
      "insertableQuestionsAfter",
      "outgoingEdges",
      "uncoveredAnswers",
      "connectableTargets",
      "routableAnswers",
      "routedAnswers",
      "nodeIssues",
      "edgeIssues",
    ]) {
      expect(code, `${helper} is not read from the pure layer`).toContain(helper);
    }
    // The destination pickers all read the same list: three copies of
    // `.filter((n) => n.id !== ...)` is three chances to offer a self-loop.
    expect(code).not.toContain("graph.nodes.filter");
  });

  // THE RSC CLIENT-BOUNDARY TRAP (memory: rsc-client-boundary-datatable-tabs). A
  // component with FUNCTION props that declares "use client" of its own becomes a
  // boundary: a server parent then passes functions across it and the page throws
  // at render, with a build that passed. The whole funnel-builder subtree takes
  // callbacks, so not one file in it may declare the directive - the panel above
  // them is the single boundary, and every one of them is reached only through it.
  it("puts the only 'use client' on the panel, above every component that takes a callback", () => {
    const CLIENT = /^\s*["']use client["']/m;
    expect(CLIENT.test(panelSource), "the panel must be the boundary").toBe(true);
    for (const [name, source] of [
      ["flow-inspector.tsx", inspectorSource],
      ["flow-builder.tsx", builderSource],
      ["flow-phone-canvas.tsx", phoneCanvasSource],
      ["flow-phone-mini.tsx", miniSource],
      ["flow-canvas.tsx", read("flow-canvas.tsx")],
    ] as const) {
      expect(CLIENT.test(source), `${name} declares 'use client' and becomes a boundary`).toBe(
        false,
      );
    }
  });

  // MUTATION: mount the strip from a server component "because it is only a
  // picture". It takes an onSelect now; the two importers are the panel (a client
  // module) and the builder underneath it.
  it("is reached only from the client subtree", () => {
    for (const [name, source] of [
      ["campaigns-panel.tsx", panelSource],
      ["flow-builder.tsx", builderSource],
    ] as const) {
      expect(source, `${name} should import the strip`).toContain("./flow-phone-canvas");
    }
    // The panel's own preview stays read-only: no campaign, nothing to save to.
    const panelStrip = panelSource.slice(
      panelSource.indexOf("<FlowPhoneCanvas"),
      panelSource.indexOf("/>", panelSource.indexOf("<FlowPhoneCanvas")),
    );
    expect(panelStrip).not.toContain("onSelect");
  });
});

/* ---------------------------------------------------------------------------
 * 7. THE PARITY CHECKLIST, as one inventory.
 *
 * The abstract card canvas came down in this pass. What justified that is not an
 * argument about drawings - it is that every operation the builder offers is
 * reachable by picking a SCREEN on the strip and using its rail. This walks every
 * step of every template and asserts the controls that step's kind must carry, so
 * a kind that renders an empty rail (or loses one control on one kind) goes red
 * here rather than being discovered by an owner with a broken funnel.
 * ------------------------------------------------------------------------- */

describe("every operation is reachable from a screen", () => {
  const EVERY = FLOW_TEMPLATES.map((t) => ({ key: t.key, graph: t.build() }));

  it("covers the templates it thinks it covers", () => {
    expect(EVERY.length).toBeGreaterThan(1);
    for (const { key, graph } of EVERY) {
      expect(validateFlow(graph).ok, `${key} does not validate`).toBe(true);
      for (const kind of ["welcome", "question", "contact", "outcome"]) {
        expect(graph.nodes.some((n) => n.kind === kind), `${key} has no ${kind}`).toBe(true);
      }
    }
  });

  it.each(EVERY.map((e) => e.key))("%s: every step's rail carries its own controls", (key) => {
    const graph = EVERY.find((e) => e.key === key)!.graph;

    for (const node of graph.nodes) {
      const html = rail(graph, { kind: "node", id: node.id });
      const has = (needle: string, what: string) =>
        expect(html, `${node.id} (${node.kind}): no ${what}`).toContain(needle);

      // Every rail names the step it opened on and can be closed.
      has("Close the inspector", "way out");

      if (node.kind === "question") {
        has(`id="q-${node.id}"`, "question picker");
        has(`id="tr-${node.id}"`, "lead-in field");
        has("Remove this question", "remove control");
        has("Add a screen after this one", "add-a-screen control");
      }
      if (node.kind === "welcome") {
        has(`id="wh-${node.id}"`, "headline field");
        has(`id="wi-${node.id}"`, "intro field");
        has("Add a screen after this one", "add-a-screen control");
        // The entry is not removable, and the rail does not pretend otherwise.
        expect(html, "the welcome step offers a remove").not.toContain("Remove this question");
      }
      if (node.kind === "outcome") {
        has(`id="hl-${node.id}"`, "result headline field");
        // Terminal by rule 7: no branches, nothing to add after it.
        expect(html).not.toContain("Add a screen after this one");
      }

      // Everything that routes shows where each answer goes, with a destination
      // picker and a way into the connection's own rail per wire.
      const wires = graph.edges.filter((e) => e.from === node.id);
      if (wires.length > 0) {
        has("Where each answer goes", "branch list");
        expect(occurrences(html, 'aria-label="Where '), `${node.id}: a row per wire`).toBe(
          wires.length,
        );
        expect(occurrences(html, ">Edit</button>"), `${node.id}: a way into each wire`).toBe(
          wires.length,
        );
        expect(
          occurrences(html, 'aria-label="Remove the connection'),
          `${node.id}: a way to remove each wire`,
        ).toBe(wires.length);
        expect(occurrences(html, 'aria-label="Move '), `${node.id}: reorder controls`).toBe(
          wires.length > 1 ? wires.length * 2 : 0,
        );
      }
    }

    // ...and every connection's own rail carries its three fields plus the
    // splice-a-question control the retired canvas used to be the way into.
    graph.edges.forEach((_, index) => {
      const html = rail(graph, { kind: "edge", index });
      for (const needle of [
        "Taken when the answer is",
        "Then go to",
        `id="etr-${index}"`,
        "Add a question here",
        "Remove this connection",
      ]) {
        expect(html, `edge ${index}: no ${needle}`).toContain(needle);
      }
    });
  });
});
