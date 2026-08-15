// THE EDIT RULES. What "add a question here", "remove this step" and "point this
// answer somewhere else" actually DO to a funnel graph.
//
// WHY THIS IS NOT IN THE BUILDER COMPONENT. Same reason as flow-layout.ts, and it
// matters more here: these are RULES, not rendering. vitest collects only
// src/**\/*.test.ts in a node environment, so a rule written inside flow-builder.tsx
// is a rule no test can reach - and the specific rule "removing a step re-routes
// everything that pointed at it" is exactly the kind that looks right in a demo and
// silently strands a branch on the seventh edit. Every function here is pure, takes
// a graph and returns a NEW one, and never mutates its input (React state depends
// on that; so does undo).
//
// THE PICKER RULE IS THE VALIDATOR. `insertableQuestions` does not re-implement
// "which questions are still unused on this path". It builds the candidate graph
// and asks validateFlow, keeping only the questions that introduce NO NEW KIND OF
// FAILURE. That gets rule 8 (never ask the same thing twice), rule 9 (never ask an
// implant question of a whitening enquiry) and rule 4b (never exceed the length
// cap) for free and, more importantly, for ever: a rule added to flow-validate.ts
// tomorrow tightens this picker the same day, with no second copy to forget.
//
// EVERY REFUSAL CARRIES A REASON, in words an owner can read. A silently-ignored
// click is the worst outcome available here: the owner believes the funnel changed.

import {
  FLOW_BANDS,
  FLOW_LIMITS,
  edgesFrom,
  isFlowBand,
  nodeMap,
  type FlowBand,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { validateFlow } from "./flow-validate";
import { QUIZ_QUESTIONS, questionById } from "./quiz";

export type FlowEditResult =
  | { ok: true; graph: FlowGraph }
  /** Refused, with a line the builder can show. The graph is unchanged. */
  | { ok: false; reason: string };

const ok = (graph: FlowGraph): FlowEditResult => ({ ok: true, graph });
const no = (reason: string): FlowEditResult => ({ ok: false, reason });

/** A fresh graph with the same identity, so React sees a new object every edit. */
function withParts(graph: FlowGraph, nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { schemaVersion: graph.schemaVersion, entry: graph.entry, nodes, edges };
}

// ---------------------------------------------------------------------------
// Ids.
// ---------------------------------------------------------------------------

/**
 * A readable, stable, unused node id for a question. Readable because it is what a
 * validation failure names back to the owner ("location is not answered on every
 * path to contact"), so "q-location" beats a uuid every time.
 */
export function nextNodeId(graph: FlowGraph, questionId: string): string {
  const taken = new Set(graph.nodes.map((n) => n.id));
  const base = `q-${questionId}`.slice(0, FLOW_LIMITS.nodeId);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, FLOW_LIMITS.nodeId);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${graph.nodes.length + 1}`.slice(0, FLOW_LIMITS.nodeId);
}

// ---------------------------------------------------------------------------
// Reading the graph (the inspector's questions).
// ---------------------------------------------------------------------------

/**
 * Where a step sends anyone it has no specific route for: its default edge, or -
 * failing that - its first edge. This is what an incoming wire is re-pointed at
 * when the step is deleted, and null means the step is a dead end.
 */
export function defaultTargetOf(graph: FlowGraph, nodeId: string): string | null {
  const out = edgesFrom(graph, nodeId);
  const fallback = out.find((e) => e.answer === null);
  return (fallback ?? out[0])?.to ?? null;
}

/**
 * Options of a question step that no wire covers, with no default edge to catch
 * them. Rule 3 fails on exactly these; the inspector lists them so the owner can
 * see WHICH answer leads nowhere rather than only that one does.
 */
export function uncoveredOptions(graph: FlowGraph, nodeId: string): { value: string; label: string }[] {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return [];
  const q = questionById(node.questionId);
  if (!q) return [];
  const out = edgesFrom(graph, nodeId);
  if (out.some((e) => e.answer === null)) return [];
  const claimed = new Set(out.map((e) => e.answer));
  return q.options.filter((o) => !claimed.has(o.value)).map((o) => ({ value: o.value, label: o.label }));
}

/** Question ids already used anywhere in the graph. */
export function usedQuestionIds(graph: FlowGraph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) if (n.kind === "question") out.add(n.questionId);
  return out;
}

/** Stable identity of a validation failure, ignoring WHICH node it landed on. */
function failureKinds(graph: FlowGraph): Set<string> {
  return new Set(validateFlow(graph).failures.map((f) => `${f.rule}:${f.code}`));
}

function introducesNothingNew(before: Set<string>, after: FlowGraph): boolean {
  for (const kind of failureKinds(after)) if (!before.has(kind)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Adding a question.
// ---------------------------------------------------------------------------

/**
 * Splice a question step into an existing wire: A -(answer)-> B becomes
 * A -(answer)-> Q -(anything else)-> B.
 *
 * ON THE WIRE RATHER THAN "AFTER A NODE" on purpose. A step can have several
 * outgoing wires (that is what a branch IS), so "add a question after the
 * treatment question" is ambiguous the moment there is more than one route out of
 * it - and guessing which one the owner meant is how a question silently lands on
 * the implant branch only. The wire is unambiguous, and it is also what the canvas
 * shows, so the click target and the rule agree.
 *
 * The new step inherits a DEFAULT edge to B, so every one of its options is
 * covered from the moment it appears (rule 3) and the funnel is never
 * transiently broken by an insertion.
 */
export function insertQuestionOnEdge(
  graph: FlowGraph,
  edgeIndex: number,
  questionId: string,
): FlowEditResult {
  const original = graph.edges[edgeIndex];
  if (!original) return no("That connection is no longer there. Reopen the funnel and try again.");
  if (!questionById(questionId)) return no(`"${questionId}" is not a question in the bank.`);
  if (graph.nodes.length >= FLOW_LIMITS.nodes) {
    return no(`A funnel can hold at most ${FLOW_LIMITS.nodes} steps.`);
  }
  if (graph.edges.length + 1 > FLOW_LIMITS.edges) {
    return no(`A funnel can hold at most ${FLOW_LIMITS.edges} connections.`);
  }

  const id = nextNodeId(graph, questionId);
  const node: FlowNode = { id, kind: "question", questionId };
  const edges = graph.edges.map((e, i) => (i === edgeIndex ? { ...e, to: id } : e));
  // Straight after the wire it was spliced into, so declaration order still reads
  // like the funnel - and declaration order is what makes the walk (flow-runtime)
  // and the layout deterministic.
  edges.splice(edgeIndex + 1, 0, { from: id, to: original.to, answer: null });

  return ok(withParts(graph, [...graph.nodes, node], edges));
}

/**
 * The questions it is safe to splice into this wire: every bank question whose
 * insertion introduces no new KIND of validation failure. See the header - this
 * deliberately asks the validator rather than re-deriving "unused on this path",
 * so the picker can never offer a question that would break the funnel.
 */
export function insertableQuestions(graph: FlowGraph, edgeIndex: number): string[] {
  if (!graph.edges[edgeIndex]) return [];
  const before = failureKinds(graph);
  const out: string[] = [];
  for (const q of QUIZ_QUESTIONS) {
    const candidate = insertQuestionOnEdge(graph, edgeIndex, q.id);
    if (!candidate.ok) continue;
    if (introducesNothingNew(before, candidate.graph)) out.push(q.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Removing a question.
// ---------------------------------------------------------------------------

/**
 * Delete a question step. Everything that pointed AT it is re-pointed at its
 * default target, so no branch is ever left dangling; everything it pointed at is
 * dropped with it.
 *
 * ONLY QUESTION STEPS. The welcome step is the entry, the contact step is the only
 * place a lead is captured (rule 6) and the three results are what every path has
 * to end at (rule 7) - deleting any of them makes a funnel that cannot be
 * published, so the honest answer is to say so rather than to let the owner do it
 * and then show them a wall of red.
 */
export function removeNode(graph: FlowGraph, nodeId: string): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node) return no("That step is no longer there.");
  if (nodeId === graph.entry) return no("The opening step cannot be removed.");
  if (node.kind === "contact") {
    return no("The contact step is where the enquiry is captured, so it cannot be removed.");
  }
  if (node.kind === "outcome") {
    return no("Every funnel needs all three result steps, so this one cannot be removed.");
  }
  if (node.kind === "welcome") return no("The welcome step cannot be removed.");

  const target = defaultTargetOf(graph, nodeId);
  if (!target) {
    return no("This step leads nowhere yet, so there is nothing to re-route to. Connect it first.");
  }

  const nodes = graph.nodes.filter((n) => n.id !== nodeId);
  const rerouted: FlowEdge[] = [];
  const claimed = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === nodeId) continue; // its own wires go with it
    const next = e.to === nodeId ? { ...e, to: target } : e;
    // Re-pointing can produce a step that loops to itself, or two wires out of one
    // step claiming the same answer. Both are validation failures; neither is
    // something the owner asked for, so neither is created.
    if (next.from === next.to) continue;
    const key = `${next.from} ${next.answer === null ? " " : next.answer}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    rerouted.push(next);
  }

  return ok(withParts(graph, nodes, rerouted));
}

// ---------------------------------------------------------------------------
// Editing wires.
// ---------------------------------------------------------------------------

export function setEdgeTarget(graph: FlowGraph, edgeIndex: number, to: string): FlowEditResult {
  const e = graph.edges[edgeIndex];
  if (!e) return no("That connection is no longer there.");
  if (!nodeMap(graph).has(to)) return no("That step is no longer there.");
  if (e.from === to) return no("A step cannot lead to itself.");
  if (e.to === to) return ok(graph);
  return ok(withParts(graph, graph.nodes, graph.edges.map((x, i) => (i === edgeIndex ? { ...x, to } : x))));
}

/**
 * Change which answer a wire carries. null makes it the default ("anything else")
 * route. Refuses to create two wires out of one step claiming the same answer,
 * because the second one would be dead: routeFor (flow-runtime.ts:64) takes the
 * first match in declaration order, so the funnel would quietly never use it.
 */
export function setEdgeAnswer(
  graph: FlowGraph,
  edgeIndex: number,
  answer: string | null,
): FlowEditResult {
  const e = graph.edges[edgeIndex];
  if (!e) return no("That connection is no longer there.");
  if (e.answer === answer) return ok(graph);
  const clash = graph.edges.some((x, i) => i !== edgeIndex && x.from === e.from && x.answer === answer);
  if (clash) {
    return no(
      answer === null
        ? "This step already has an “anything else” route."
        : `This step already routes “${answer}” somewhere.`,
    );
  }
  return ok(
    withParts(graph, graph.nodes, graph.edges.map((x, i) => (i === edgeIndex ? { ...x, answer } : x))),
  );
}

export function addEdge(
  graph: FlowGraph,
  from: string,
  to: string,
  answer: string | null,
): FlowEditResult {
  const byId = nodeMap(graph);
  if (!byId.has(from) || !byId.has(to)) return no("That step is no longer there.");
  if (from === to) return no("A step cannot lead to itself.");
  if (graph.edges.length >= FLOW_LIMITS.edges) {
    return no(`A funnel can hold at most ${FLOW_LIMITS.edges} connections.`);
  }
  if (graph.edges.some((e) => e.from === from && e.answer === answer)) {
    return no(
      answer === null
        ? "That step already has an “anything else” route."
        : `That step already routes “${answer}” somewhere.`,
    );
  }
  return ok(withParts(graph, graph.nodes, [...graph.edges, { from, to, answer }]));
}

export function removeEdge(graph: FlowGraph, edgeIndex: number): FlowEditResult {
  if (!graph.edges[edgeIndex]) return no("That connection is no longer there.");
  return ok(withParts(graph, graph.nodes, graph.edges.filter((_, i) => i !== edgeIndex)));
}

// ---------------------------------------------------------------------------
// Editing copy.
//
// Every setter here writes PATIENT-FACING text. It is capped for length and
// blank-normalised (a cleared field becomes absent, so it can never render as an
// empty line) - and that is ALL it can do. Whether the words are ALLOWED is a
// compliance judgement made at WRITE time on the server, with scanBannedText plus
// the NHS/private regexes, exactly as flow.ts CUT 3 spells out. Nothing on the
// client may be trusted to have made it.
// ---------------------------------------------------------------------------

function trimmed(value: string, max: number): string | undefined {
  const s = value.trim().slice(0, max);
  return s === "" ? undefined : s;
}

function replaceNode(graph: FlowGraph, nodeId: string, next: FlowNode): FlowGraph {
  return withParts(
    graph,
    graph.nodes.map((n) => (n.id === nodeId ? next : n)),
    graph.edges,
  );
}

export function setQuestionTransition(graph: FlowGraph, nodeId: string, text: string): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return no("That step is no longer there.");
  const transition = trimmed(text, FLOW_LIMITS.transition);
  const next: FlowNode = { id: node.id, kind: "question", questionId: node.questionId };
  if (transition) next.transition = transition;
  return ok(replaceNode(graph, nodeId, next));
}

export function setEdgeTransition(graph: FlowGraph, edgeIndex: number, text: string): FlowEditResult {
  const e = graph.edges[edgeIndex];
  if (!e) return no("That connection is no longer there.");
  const transition = trimmed(text, FLOW_LIMITS.transition);
  const next: FlowEdge = { from: e.from, to: e.to, answer: e.answer };
  if (transition) next.transition = transition;
  return ok(withParts(graph, graph.nodes, graph.edges.map((x, i) => (i === edgeIndex ? next : x))));
}

export function setOutcomeHeadline(graph: FlowGraph, nodeId: string, text: string): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "outcome") return no("That result step is no longer there.");
  const headline = trimmed(text, FLOW_LIMITS.headline);
  const next: FlowNode = { id: node.id, kind: "outcome", band: node.band };
  if (headline) next.headline = headline;
  return ok(replaceNode(graph, nodeId, next));
}

export function setWelcomeCopy(
  graph: FlowGraph,
  nodeId: string,
  headline: string,
  intro: string,
): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "welcome") return no("That step is no longer there.");
  const next: FlowNode = { id: node.id, kind: "welcome" };
  const h = trimmed(headline, FLOW_LIMITS.headline);
  const i = trimmed(intro, FLOW_LIMITS.intro);
  if (h) next.headline = h;
  if (i) next.intro = i;
  return ok(replaceNode(graph, nodeId, next));
}

// ---------------------------------------------------------------------------
// WHAT A CARD SAYS.
//
// The bank-aware half of the builder, and it lives HERE rather than in
// flow-canvas.tsx for the same reason everything else does: vitest collects no
// .tsx, so a lookup written in JSX is a lookup no test can hold. It is small, but
// "which option labels belong to this question" and "what does the wire out of the
// contact step mean" are exactly the kind of mapping that gets transposed once and
// then mislabels every branch on the canvas.
//
// It is also the reason flow-layout.ts imports nothing but flow.ts: the geometry
// is handed finished strings, so it never needs the question bank, and the two
// concerns cannot drift into each other.
//
// OWNER-FACING WORDS ONLY. Nothing produced below is ever shown to a patient - it
// is the builder's own labelling. The patient-facing strings on a graph are the
// authored `transition`, `headline` and `intro` fields, and they are the ones the
// server compliance-scans at write time.
// ---------------------------------------------------------------------------

const BAND_TITLE: Record<FlowBand, string> = {
  high: "Ready to get started",
  medium: "Worth following up",
  low: "Early enquiry",
};

const BAND_SHORT: Record<FlowBand, string> = {
  high: "High intent",
  medium: "Medium",
  low: "Low",
};

export const FLOW_BAND_TITLES = BAND_TITLE;
export const FLOW_BAND_LABELS = BAND_SHORT;

export interface FlowCardText {
  eyebrow: string;
  title: string;
  options: string[];
}

/** The card for one step: what it is, what it asks, and what it offers. */
export function describeNode(node: FlowNode): FlowCardText {
  switch (node.kind) {
    case "welcome":
      return { eyebrow: "Start", title: node.headline ?? "Welcome screen", options: [] };
    case "contact":
      return { eyebrow: "Capture", title: "Contact details", options: [] };
    case "outcome":
      return {
        eyebrow: `Result · ${BAND_SHORT[node.band]}`,
        title: node.headline ?? BAND_TITLE[node.band],
        options: [],
      };
    case "question": {
      const q = questionById(node.questionId);
      // A question that has left the bank is a rule-2 failure. Naming it on the
      // card is how the owner finds the step the banner is complaining about.
      if (!q) {
        return { eyebrow: "Question", title: `Unknown question “${node.questionId}”`, options: [] };
      }
      return { eyebrow: "Question", title: q.prompt, options: q.options.map((o) => o.label) };
    }
  }
}

/** The wire label: what answer takes a patient down it. */
export function describeEdge(edge: FlowEdge, from: FlowNode): string | undefined {
  if (from.kind === "welcome") return undefined;
  if (edge.answer === null) return "Anything else";
  if (from.kind === "contact") {
    return isFlowBand(edge.answer) ? BAND_SHORT[edge.answer] : `Not a result (${edge.answer})`;
  }
  if (from.kind === "question") {
    const option = questionById(from.questionId)?.options.find((o) => o.value === edge.answer);
    return option ? option.label : `Not an option (${edge.answer})`;
  }
  return edge.answer;
}

/** The answers a step can route on, for the inspector's answer picker. */
export function routableAnswers(from: FlowNode): { value: string; label: string }[] {
  if (from.kind === "contact") {
    return FLOW_BANDS.map((b) => ({ value: b, label: BAND_SHORT[b] }));
  }
  if (from.kind === "question") {
    const q = questionById(from.questionId);
    return (q?.options ?? []).map((o) => ({ value: o.value, label: o.label }));
  }
  return [];
}
