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
  acceptsBlockKind,
  acceptsBlocks,
  blockCopyFields,
  blockKindsForScreen,
  blocksOf,
  cloneFlowBlock,
  edgesFrom,
  isFlowBand,
  isFlowBlockKind,
  nodeMap,
  optionImagesOf,
  withRequiredSchemaVersion,
  type FlowBand,
  type FlowBlock,
  type FlowBlockKind,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowOptionImage,
} from "./flow";
import { validateFlow } from "./flow-validate";
import { QUIZ_QUESTIONS, questionById } from "./quiz";
import { assessImage, assessImagesForSlot } from "@/lib/assess/image-library";

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

/** One outgoing wire, WITH the index every edge editor here is addressed by. */
export interface FlowEdgeRef {
  index: number;
  edge: FlowEdge;
}

/**
 * The wires out of a step, in declaration order, each carrying its index into
 * `graph.edges`.
 *
 * WHY THE INDEX TRAVELS WITH THE EDGE. Every edit below addresses a wire by its
 * INDEX (setEdgeTarget, setEdgeAnswer, removeEdge), while everything that draws a
 * step's branches wants the wires OUT OF ONE NODE - `edgesFrom` (flow.ts), which
 * drops the index on the way. Re-deriving it in the component with a second
 * `findIndex` is the transposition that quietly re-points the wrong branch the
 * first time two wires out of one step share a target, so the pairing is made
 * once, here, where a test can hold it.
 */
export function outgoingEdges(graph: FlowGraph, nodeId: string): FlowEdgeRef[] {
  const out: FlowEdgeRef[] = [];
  graph.edges.forEach((edge, index) => {
    if (edge.from === nodeId) out.push({ index, edge });
  });
  return out;
}

/**
 * The wires out of a step that carry a SPECIFIC answer rather than the default -
 * i.e. the branch this step actually makes.
 *
 * ONE PREDICATE, TWO READERS, and that is the whole point of it being here. It is
 * what makes setNodeQuestion refuse (those wires name option values of the question
 * being swapped away), and it is what the inspector shows the owner as the REASON
 * the question is fixed. Two copies of "is this step branched" is two answers to
 * the same question the moment either is edited.
 */
export function routedAnswers(graph: FlowGraph, nodeId: string): FlowEdgeRef[] {
  return outgoingEdges(graph, nodeId).filter(({ edge }) => edge.answer !== null);
}

/**
 * The wire a step falls back to: its default ("anything else") edge, or - failing
 * that - the first one declared. Null means the step is a dead end.
 *
 * WHY THE WIRE AND NOT THE TARGET, when every caller before A1 wanted the target.
 * "Add a screen after this one" has to splice into a WIRE (insertQuestionOnEdge is
 * addressed by edge index, for the reason its own header gives), and it must land
 * on the same wire that removeNode would re-point to and that "route this answer"
 * would follow - or the + on the strip adds a screen somewhere other than where
 * the funnel actually goes next. So the fallback rule is stated ONCE, here, and
 * defaultTargetOf is a reading of it rather than a second copy.
 */
export function defaultEdgeOf(graph: FlowGraph, nodeId: string): FlowEdgeRef | null {
  const out = outgoingEdges(graph, nodeId);
  return out.find(({ edge }) => edge.answer === null) ?? out[0] ?? null;
}

/**
 * Where a step sends anyone it has no specific route for. This is what an incoming
 * wire is re-pointed at when the step is deleted, and null means it is a dead end.
 */
export function defaultTargetOf(graph: FlowGraph, nodeId: string): string | null {
  return defaultEdgeOf(graph, nodeId)?.edge.to ?? null;
}

/**
 * Answers of a step that no wire covers, with no default edge to catch them.
 *
 * IT IS RULE 3, READ BACK. The validator fails on exactly these, and it does so in
 * two places with one shape: a question's OPTIONS (flow-validate.ts:444-455) and
 * the contact step's three BANDS (:470-476) - unclaimed, and no default edge to
 * catch them. This returns the same set for both kinds off routableAnswers, which
 * is already the "what can this step route on" rule.
 *
 * IT USED TO BE QUESTION-ONLY, and that was a hole with no floor under it: delete
 * the "high" wire out of the contact step and rule 3 said so in the banner while
 * the rail offered nothing to put it back - no uncovered answer to route, and the
 * question picker does not apply to a contact step. The funnel could not be
 * published and could not be repaired, from a Trash button two clicks away.
 */
export function uncoveredAnswers(graph: FlowGraph, nodeId: string): { value: string; label: string }[] {
  const node = nodeMap(graph).get(nodeId);
  if (!node) return [];
  const answers = routableAnswers(node);
  if (answers.length === 0) return [];
  const out = edgesFrom(graph, nodeId);
  if (out.some((e) => e.answer === null)) return [];
  const claimed = new Set(out.map((e) => e.answer));
  return answers.filter((a) => !claimed.has(a.value));
}

/**
 * The steps a wire out of this one may point at: every other step.
 *
 * Trivial, and here anyway, because it is drawn in THREE pickers (a branch row's
 * destination, a connection's own destination, and the connect control on a dead
 * end) and the day one of them forgets the `!== from` filter is the day a funnel
 * grows a step that leads to itself - which setEdgeTarget then refuses, from a
 * control that had offered it.
 */
export function connectableTargets(graph: FlowGraph, nodeId: string): FlowNode[] {
  return graph.nodes.filter((n) => n.id !== nodeId);
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

/**
 * The questions "add a screen after this one" could add: insertableQuestions on
 * the wire that step actually falls back to. Empty when the step is a dead end -
 * there is no wire to splice into - which is also what planScreenInsertion says in
 * words.
 */
export function insertableQuestionsAfter(graph: FlowGraph, nodeId: string): string[] {
  const ref = defaultEdgeOf(graph, nodeId);
  return ref ? insertableQuestions(graph, ref.index) : [];
}

/**
 * WHERE A "+" ON THE STRIP LANDS. The one resolution of "add a screen after this
 * screen" into the three facts the insertion needs: which wire, which question,
 * and what the new step will be called.
 *
 * WHY THE ID IS PART OF THE PLAN and not read off the graph afterwards. A screen
 * you have just added should be the screen you are now standing on - otherwise the
 * one-click + drops a question of its own choosing into the funnel and leaves the
 * owner to hunt for it. The builder needs that id BEFORE the edit is applied (it
 * moves the selection on success), and the only honest way to have it in both
 * places is to resolve it ONCE here: `nextNodeId` on the pre-edit graph is exactly
 * what insertQuestionOnEdge will call on the same graph a moment later. Two
 * derivations would be two answers the first time a funnel already holds a
 * `q-timeline`.
 *
 * THE QUESTION IS OPTIONAL because the two callers differ and must not diverge:
 * the + on the canvas takes what it is offered first (one click, then change it in
 * the rail, where the picker is), the rail's own control names one. Both come
 * through here, so both are checked against the same insertable list - the
 * validator's list, which is what keeps rule 8 (never twice), rule 9 (never
 * off-branch), rule 10 (the core three) and the length cap on a control that has
 * no picker to show them in.
 */
export type ScreenInsertion =
  | { ok: true; edgeIndex: number; questionId: string; nodeId: string }
  | { ok: false; reason: string };

export function planScreenInsertion(
  graph: FlowGraph,
  nodeId: string,
  questionId?: string,
): ScreenInsertion {
  const node = nodeMap(graph).get(nodeId);
  if (!node) return { ok: false, reason: "That step is no longer there." };

  const ref = defaultEdgeOf(graph, nodeId);
  if (!ref) {
    return {
      ok: false,
      reason:
        "This step leads nowhere yet, so there is nothing to add a screen to. Connect it first.",
    };
  }

  const offered = insertableQuestions(graph, ref.index);
  const chosen = questionId ?? offered[0];
  if (chosen === undefined) {
    return {
      ok: false,
      reason:
        "Nothing left to add after this screen: every remaining question is either already asked on this route, is about a different treatment, or would make the funnel too long.",
    };
  }
  if (!offered.includes(chosen)) {
    return {
      ok: false,
      reason: questionById(chosen)
        ? `“${questionById(chosen)!.prompt}” cannot be added here: it is either already asked on this route, is about a different treatment, or would make the funnel too long.`
        : `"${chosen}" is not a question in the bank.`,
    };
  }

  return { ok: true, edgeIndex: ref.index, questionId: chosen, nodeId: nextNodeId(graph, chosen) };
}

// ---------------------------------------------------------------------------
// Changing the question a step asks.
// ---------------------------------------------------------------------------

/**
 * Point an existing question step at a DIFFERENT bank question. The screen keeps
 * its place in the funnel, its lead-in line and every wire into it; only the ask
 * changes.
 *
 * WHY THIS IS AN EDIT AND NOT "REMOVE THEN ADD". Removing a step re-points
 * everything that led to it and drops everything it led to (removeNode above), so
 * the remove/add pair loses the branch shape around the screen the owner was
 * standing on - which, in a click-to-edit inspector, is the ONE thing they were
 * not asking to change.
 *
 * IT REFUSES ON A BRANCHED STEP, deliberately, and this is the load-bearing part.
 * A wire out of a question carries an OPTION VALUE of that question (flow.ts,
 * FlowEdge.answer). Swap the question underneath it and every one of those values
 * belongs to a question this step no longer asks: rule 2
 * (`edge_answer_not_an_option`) fails, and the honest repairs - dropping those
 * wires, or collapsing them onto one target - both silently destroy routing the
 * owner spent time on. So a branched step says what has to happen first, in words,
 * and changes nothing.
 *
 * ANSWER-CARD PICTURES GO WITH THE OLD QUESTION, because they name its option
 * values (flow.ts, FlowOptionImage) and rule 14 would fail on every one of them.
 * The lead-in line is kept: it is about where the patient IS in the funnel, not
 * about which question is on the screen.
 */
export function setNodeQuestion(
  graph: FlowGraph,
  nodeId: string,
  questionId: string,
): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return no("That question step is no longer there.");
  if (!questionById(questionId)) return no(`"${questionId}" is not a question in the bank.`);
  if (node.questionId === questionId) return ok(graph);

  const routed = routedAnswers(graph, nodeId);
  if (routed.length > 0) {
    return no(
      routed.length === 1
        ? "One of this step’s answers is routed on its own, and that route belongs to the question it asks now. Point it the same way as the rest, then change the question."
        : `${routed.length} of this step’s answers are routed on their own, and those routes belong to the question it asks now. Point them the same way as the rest, then change the question.`,
    );
  }

  const next: FlowNode = { id: node.id, kind: "question", questionId };
  if (node.transition) next.transition = node.transition;
  return ok(replaceNode(graph, nodeId, next));
}

/**
 * The questions this step could ask instead: every bank question whose swap
 * introduces no new KIND of validation failure, plus the one it already asks.
 *
 * Same doctrine as insertableQuestions - the VALIDATOR is the picker's rule, never
 * a second copy of "unused on this path" - so rule 8 (never twice), rule 9 (never
 * off-branch) and rule 10 (the core three) all reach this list the day they change.
 * The current question is always in it: a picker whose own value is missing from
 * its options renders as blank, or as somebody else's question.
 */
export function swappableQuestions(graph: FlowGraph, nodeId: string): string[] {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return [];
  const before = failureKinds(graph);
  const out: string[] = [];
  for (const q of QUIZ_QUESTIONS) {
    const candidate = setNodeQuestion(graph, nodeId, q.id);
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

/**
 * Move a wire up or down among the OTHER wires out of the same step.
 *
 * WHAT IT CHANGES, EXACTLY, because the honest answer is smaller than it looks and
 * the dishonest answer would be a bug: it does NOT change which route a patient
 * takes. routeFor (flow-runtime.ts:64-70) matches the answer EXACTLY first and
 * falls back to the default, so two wires carrying different answers are found the
 * same way whatever order they sit in - and two wires carrying the SAME answer are
 * refused outright by setEdgeAnswer and addEdge. Order carries meaning in two
 * places only, and both are real:
 *
 *   THE PICTURE. Declaration order is what the layout's row ordering ties break on,
 *   so it is the order the branches are drawn in and the order the rail lists them.
 *   A funnel whose "researching" branch is drawn above its "asap" one reads
 *   backwards, and re-pointing wires to fix that is how routing gets broken.
 *
 *   THE FALLBACK. defaultEdgeOf takes the FIRST wire when there is no "anything
 *   else" one, so on a step with no default route the order decides where a deleted
 *   predecessor re-points to and where "add a screen after this one" lands.
 *
 * IT SWAPS TWO ENTRIES rather than splicing the array, so no wire out of any OTHER
 * step moves - a splice would shift every index after it and quietly re-address
 * edits queued against them.
 */
export function moveEdge(graph: FlowGraph, edgeIndex: number, delta: number): FlowEditResult {
  const edge = graph.edges[edgeIndex];
  if (!edge) return no("That connection is no longer there.");
  if (delta === 0) return ok(graph);

  const siblings = outgoingEdges(graph, edge.from);
  const at = siblings.findIndex((s) => s.index === edgeIndex);
  const to = at + (delta > 0 ? 1 : -1);
  if (to < 0) return no("That answer is already the first route out of this step.");
  if (to >= siblings.length) return no("That answer is already the last route out of this step.");

  const other = siblings[to]!.index;
  const edges = graph.edges.map((e, i) =>
    i === edgeIndex ? graph.edges[other]! : i === other ? edge : e,
  );
  return ok(withParts(graph, graph.nodes, edges));
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
  if (node.optionImages) {
    next.optionImages = node.optionImages.map((o) => ({ value: o.value, image: o.image }));
  }
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

// EVERY EDITOR BELOW REBUILDS ITS NODE FIELD BY FIELD rather than spreading, so
// that a field removed from the type cannot survive in a stored row. The cost of
// that choice is that a field ADDED to the type is silently dropped by every
// editor that does not carry it, which for A2's `blocks` would mean: an owner adds
// a testimonial, later fixes a typo in the same screen's headline, and the
// testimonial is gone with the save reporting success. So the carry is explicit.

export function setOutcomeHeadline(graph: FlowGraph, nodeId: string, text: string): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "outcome") return no("That result step is no longer there.");
  const headline = trimmed(text, FLOW_LIMITS.headline);
  const next: FlowNode = { id: node.id, kind: "outcome", band: node.band };
  if (headline) next.headline = headline;
  if (node.blocks) next.blocks = node.blocks.map(cloneFlowBlock);
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
  if (node.blocks) next.blocks = node.blocks.map(cloneFlowBlock);
  return ok(replaceNode(graph, nodeId, next));
}

// ---------------------------------------------------------------------------
// CONTENT BLOCKS, AS EDITS (A2's builder half).
//
// The model landed with A2; nothing could put a block on a screen but the
// generator and a hand-written fixture. These are the ops the rail drives, and
// every one of them holds a rule that is wrong the first time it is written in
// JSX instead:
//
//   A GRAPH THESE OPS BUILT IS ALWAYS READABLE. normaliseFlow is all-or-nothing
//   (flow.ts:343-357): ONE blank string anywhere in a block and the whole funnel
//   comes back from the save as "the funnel could not be read as a graph", which
//   is a message about nothing an owner can find. So a block field is never
//   allowed to become empty here - clearing one is REFUSED, in words, naming the
//   remedy (remove the block). Rule 12's block_text_empty stays as the floor for
//   graphs that did not come through here (the generator, a stored row, an
//   importer); it is not the primary defence for an owner typing in a box.
//
//   ADDING CONTENT BUMPS THE SCHEMA VERSION. A funnel drawn before A2 is stored
//   at v1. Put a block on it without bumping and rule 1 refuses the save with
//   `schema_version_too_old` - the graph is fine, the version line is not. Every
//   writer below ends in withRequiredSchemaVersion for that reason, and it never
//   walks back down (flow.ts:223-232).
//
//   NOTHING HERE INVENTS A TESTIMONIAL. `starterBlock` returns null for the
//   testimonial kind, on purpose and permanently: there is no honest default for
//   a quote a practice has not given us. The rail asks for the words; this layer
//   refuses to make a block without them (flow-inspect.ts). That is the charter
//   rule made structural rather than remembered.
//
//   AND NOTHING HERE INVENTS A CLAIM. The starter copy for the other kinds is
//   deliberately about the FUNNEL ("about 30 seconds", "the practice replies
//   about your enquiry"), never about the practice: seeding "Open Saturdays" is
//   the same failure as seeding a quote, one save away from being published
//   untrue. The picture starter is the manifest's own alt text, which is a
//   description of a file we ship.
// ---------------------------------------------------------------------------

/** Owner-facing names for the four kinds. Used in refusals and by the picker. */
export const BLOCK_LABELS: Readonly<Record<FlowBlockKind, string>> = {
  "trust-strip": "trust strip",
  testimonial: "testimonial",
  faq: "questions and answers",
  image: "picture",
  booking: "book an appointment",
};

/**
 * Rule 12's own minimums, restated because FLOW_LIMITS carries caps only
 * (flow-validate.ts:189,199 hold the floors). flow-edit.test.ts pins both against
 * validateFlow itself, so a change there goes red here rather than letting the
 * rail remove a chip the validator then refuses to publish.
 */
const MIN_CHIPS = 1;
const MIN_FAQ_ITEMS = 2;

/** The starter trust strip's one chip. About the funnel, never about the practice. */
const STARTER_CHIP = "Takes about 30 seconds";

/**
 * The starter faq. Both answers are true of every funnel on this platform: the
 * length is the assessment's own intro line (flow-phone-screen.ts:199) and the
 * follow-up is its consent line (:234). Neither says anything about a practice
 * that a practice has not said.
 */
/**
 * The starter booking invitation. The headline is the words already on the
 * thank-you screen's link today (deterministic-assessment-quiz.tsx), so an owner
 * who adds the block and changes nothing gets the button they already had, now
 * opening in place. The blurb says only what the screen behind it does.
 */
const BOOKING_HEADLINE = "Book your appointment now";
const BOOKING_BLURB = "Pick a time that suits you and we will hold it for you.";

const STARTER_FAQ: readonly { q: string; a: string }[] = [
  { q: "How long does this take?", a: "About 30 seconds. A few quick questions, then where to send your answer." },
  { q: "What happens after I send it?", a: "The practice gets in touch about your enquiry, using the details you leave." },
];

type BlockSite =
  | { ok: true; node: FlowNode; blocks: FlowBlock[] }
  | { ok: false; reason: string };

/**
 * The screen's blocks as a COPY, or why it cannot carry any. The copy matters:
 * every writer below edits the list it is handed, and handing back the stored
 * array would make an edit mutate the draft graph in place.
 */
function blockSite(graph: FlowGraph, nodeId: string): BlockSite {
  const node = nodeMap(graph).get(nodeId);
  if (!node) return { ok: false, reason: "That step is no longer there." };
  if (!acceptsBlocks(node.kind)) {
    return {
      ok: false,
      reason:
        node.kind === "question"
          ? "A question screen’s job is the one question, so it carries no content blocks. Put them on the opening screen or a result screen."
          : "The contact screen’s job is the form, so it carries no content blocks. Put them on the opening screen or a result screen.",
    };
  }
  return { ok: true, node, blocks: blocksOf(node).map(cloneFlowBlock) };
}

/** The screen rebuilt around a new block list. Field by field, per the note above. */
function withBlocks(graph: FlowGraph, node: FlowNode, blocks: FlowBlock[]): FlowGraph {
  if (node.kind === "welcome") {
    const next: FlowNode = { id: node.id, kind: "welcome" };
    if (node.headline) next.headline = node.headline;
    if (node.intro) next.intro = node.intro;
    if (blocks.length > 0) next.blocks = blocks;
    return withRequiredSchemaVersion(replaceNode(graph, node.id, next));
  }
  if (node.kind === "outcome") {
    const next: FlowNode = { id: node.id, kind: "outcome", band: node.band };
    if (node.headline) next.headline = node.headline;
    if (blocks.length > 0) next.blocks = blocks;
    return withRequiredSchemaVersion(replaceNode(graph, node.id, next));
  }
  return graph; // unreachable: blockSite has already refused every other kind
}

/**
 * The content a NEW block of this kind starts with, or null when there is no
 * honest one. Null is not an error state: it is the answer for a testimonial
 * (nobody but the practice may write a quote) and for a trust strip whose
 * practice name we were not given.
 */
export function starterBlock(kind: FlowBlockKind, practiceName?: string): FlowBlock | null {
  switch (kind) {
    case "trust-strip": {
      const name = (practiceName ?? "").trim().slice(0, FLOW_LIMITS.practiceName);
      return name ? { kind: "trust-strip", practiceName: name, chips: [STARTER_CHIP] } : null;
    }
    case "testimonial":
      return null;
    case "faq":
      return { kind: "faq", items: STARTER_FAQ.map((i) => ({ q: i.q, a: i.a })) };
    case "image": {
      // The manifest's first screen picture, with the manifest's own alt: a
      // description of a file we ship, so it is true before it is edited.
      const first = assessImagesForSlot("hero")[0];
      return first ? { kind: "image", image: first.key, alt: first.alt } : null;
    }
    case "booking":
      // The ONLY starter that describes a mechanism rather than a practice, which
      // is why it is allowed to be a starter at all: it says what the button does
      // (opens the practice's own diary and holds a time), and it promises nothing
      // about when a time will be free, what the appointment involves or what it
      // costs. An owner rewording it is editing an invitation, not a claim.
      return { kind: "booking", headline: BOOKING_HEADLINE, blurb: BOOKING_BLURB };
  }
}

/**
 * The kinds this screen could still take: the ones it may carry at all, minus the
 * ones it already has. Empty for a screen that cannot carry blocks, and for one at
 * the cap.
 *
 * IT IS RULE 12 READ BACK, not a second copy of it: block_duplicate_kind is the
 * failure this list makes unreachable from the rail, blocksPerNode is the second,
 * and block_kind_wrong_screen is the third - which is why the source list is
 * blockKindsForScreen and not FLOW_BLOCK_KINDS. A picker that offered `booking` on
 * the opening screen would be offering a button the validator then refuses to
 * publish, and a picker that offers a kind addBlock would refuse is a picker that
 * lies.
 */
export function addableBlockKinds(graph: FlowGraph, nodeId: string): FlowBlockKind[] {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return [];
  if (site.blocks.length >= FLOW_LIMITS.blocksPerNode) return [];
  const taken = new Set(site.blocks.map((b) => b.kind));
  return blockKindsForScreen(site.node.kind).filter((k) => !taken.has(k));
}

export function addBlock(graph: FlowGraph, nodeId: string, block: FlowBlock): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  if (!isFlowBlockKind(block.kind)) {
    return no(`“${String(block.kind)}” is not a content block this build can render.`);
  }
  // Rule 12's block_kind_wrong_screen, refused before the row is built rather than
  // after the save comes back. `booking` is the only kind this can fire for today:
  // an invitation to book on the OPENING screen is a button asking the visitor to
  // skip the funnel the practice paid for the click on.
  if (!acceptsBlockKind(site.node.kind, block.kind)) {
    return no(
      `A ${BLOCK_LABELS[block.kind]} block belongs on a result screen, not on the opening screen. Add it to the screen a patient sees after they leave their details.`,
    );
  }
  if (site.blocks.some((b) => b.kind === block.kind)) {
    return no(
      `This screen already has a ${BLOCK_LABELS[block.kind]} block. Change the one it has, or remove it first.`,
    );
  }
  if (site.blocks.length >= FLOW_LIMITS.blocksPerNode) {
    return no(`A screen can hold at most ${FLOW_LIMITS.blocksPerNode} content blocks.`);
  }
  // Blank copy would make the SAVE unreadable rather than merely invalid, so the
  // block is checked here as well as by rule 12. A caller assembling one by hand
  // (the rail's testimonial form) gets told which line is missing.
  for (const f of blockCopyFields(block)) {
    if (f.text.trim() === "") return no(`A ${BLOCK_LABELS[block.kind]} needs its ${f.field} filled in.`);
  }
  return ok(withBlocks(graph, site.node, [...site.blocks, cloneFlowBlock(block)]));
}

export function removeBlock(graph: FlowGraph, nodeId: string, index: number): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  if (!site.blocks[index]) return no("That block is no longer on this screen.");
  return ok(withBlocks(graph, site.node, site.blocks.filter((_, i) => i !== index)));
}

/**
 * Move a block up or down the screen. Authored order IS render order - blockViews
 * keeps it (flow-block-view.ts:129) and both the public quiz and the phone minis
 * map over what it returns - so this is the only control that decides whether the
 * trust strip sits above the faq or below it.
 *
 * Refuses at the ends rather than wrapping, and says which end, for the same
 * reason moveEdge does: a button that silently does nothing reads as broken.
 */
export function moveBlock(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  delta: number,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");
  if (delta === 0) return ok(graph);
  const to = index + (delta > 0 ? 1 : -1);
  if (to < 0) return no("That block is already at the top of this screen.");
  if (to >= site.blocks.length) return no("That block is already at the bottom of this screen.");
  const blocks = site.blocks.map((b, i) => (i === index ? site.blocks[to]! : i === to ? block : b));
  return ok(withBlocks(graph, site.node, blocks));
}

/** A `chips[2]`-style path, as its index. Null when the path is not that list. */
function listIndex(field: string, name: string): number | null {
  const m = new RegExp(`^${name}\\[(\\d+)\\]$`).exec(field);
  if (!m) return null;
  const at = Number(m[1]);
  return Number.isInteger(at) ? at : null;
}

/**
 * One authored line of a block, replaced. The field path is blockCopyFields' own
 * (flow.ts:187) - THE list of what a block carries, which rule 12 and the
 * compliance scan already read. A field it does not name cannot be written here,
 * so a line can never reach a patient uncapped or unscanned.
 */
function withBlockField(block: FlowBlock, field: string, value: string): FlowBlock | null {
  switch (block.kind) {
    case "trust-strip": {
      if (field === "practiceName") {
        return { kind: "trust-strip", practiceName: value, chips: [...block.chips] };
      }
      const at = listIndex(field, "chips");
      if (at === null || at >= block.chips.length) return null;
      return {
        kind: "trust-strip",
        practiceName: block.practiceName,
        chips: block.chips.map((c, i) => (i === at ? value : c)),
      };
    }
    case "testimonial":
      if (field === "quote") return { kind: "testimonial", quote: value, attribution: block.attribution };
      if (field === "attribution") return { kind: "testimonial", quote: block.quote, attribution: value };
      return null;
    case "faq": {
      const m = /^items\[(\d+)\]\.([qa])$/.exec(field);
      if (!m) return null;
      const at = Number(m[1]);
      if (!Number.isInteger(at) || at >= block.items.length) return null;
      const which = m[2];
      return {
        kind: "faq",
        items: block.items.map((it, i) =>
          i === at
            ? { q: which === "q" ? value : it.q, a: which === "a" ? value : it.a }
            : { q: it.q, a: it.a },
        ),
      };
    }
    case "image":
      // The picture REFERENCE is not copy (flow.ts:184-186), so it is not writable
      // from here. setBlockImage holds it, against the manifest.
      if (field === "alt") return { kind: "image", image: block.image, alt: value };
      return null;
    case "booking":
      if (field === "headline") return { kind: "booking", headline: value, blurb: block.blurb };
      if (field === "blurb") return { kind: "booking", headline: block.headline, blurb: value };
      return null;
  }
}

export function setBlockText(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  field: string,
  text: string,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");
  const spec = blockCopyFields(block).find((f) => f.field === field);
  if (!spec) return no(`“${field}” is not something a ${BLOCK_LABELS[block.kind]} block carries.`);

  const value = text.trim().slice(0, spec.max);
  if (value === "") {
    return no(
      `Every line of a ${BLOCK_LABELS[block.kind]} block is read by a patient, so none of them can be left empty. Remove the block if it is not wanted.`,
    );
  }
  const next = withBlockField(block, field, value);
  if (!next) return no(`“${field}” is not something a ${BLOCK_LABELS[block.kind]} block carries.`);
  return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
}

/**
 * Point a picture block at a different picture from the curated manifest.
 *
 * THE DESCRIPTION FOLLOWS THE PICTURE, always, and that is a decision rather than
 * a convenience. An alt is a description OF the file; carrying the old one across
 * a swap leaves a screen reader saying "a hygiene appointment at the practice"
 * over a photograph of aligners, which is worse than saying nothing. The owner's
 * own wording is one field away, under the picker, and it is about the picture
 * they can now see.
 */
export function setBlockImage(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  key: string,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");
  if (block.kind !== "image") return no(`A ${BLOCK_LABELS[block.kind]} block has no picture.`);

  const image = assessImage(key);
  if (!image) {
    return no(
      `“${key}” is not a picture in the library. A funnel can only use the curated pictures, never a link.`,
    );
  }
  if (image.slot !== "hero") {
    return no(
      `“${key}” is an answer tile (${image.width}x${image.height}); a screen needs a picture made for a screen.`,
    );
  }
  const next: FlowBlock = { kind: "image", image: image.key, alt: image.alt };
  return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
}

/** One more reassurance chip on a trust strip. The words are the owner's. */
export function addBlockChip(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  text: string,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");
  if (block.kind !== "trust-strip") return no(`A ${BLOCK_LABELS[block.kind]} block has no chips.`);
  const chip = text.trim().slice(0, FLOW_LIMITS.chipLabel);
  if (chip === "") return no("Type the chip before adding it: a blank one renders as a hole in the row.");
  if (block.chips.length >= FLOW_LIMITS.chips) {
    return no(`A trust strip can hold at most ${FLOW_LIMITS.chips} chips.`);
  }
  const next: FlowBlock = {
    kind: "trust-strip",
    practiceName: block.practiceName,
    chips: [...block.chips, chip],
  };
  return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
}

/** One more question-and-answer pair. Both halves are required: half a faq is noise. */
export function addBlockFaqItem(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  q: string,
  a: string,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");
  if (block.kind !== "faq") return no(`A ${BLOCK_LABELS[block.kind]} block has no questions.`);
  const question = q.trim().slice(0, FLOW_LIMITS.faqQuestion);
  const answer = a.trim().slice(0, FLOW_LIMITS.faqAnswer);
  if (question === "" || answer === "") {
    return no("A question needs an answer, and an answer needs a question. Type both, then add it.");
  }
  if (block.items.length >= FLOW_LIMITS.faqItems) {
    return no(`This block can hold at most ${FLOW_LIMITS.faqItems} questions.`);
  }
  const next: FlowBlock = {
    kind: "faq",
    items: [...block.items.map((it) => ({ q: it.q, a: it.a })), { q: question, a: answer }],
  };
  return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
}

/**
 * Drop one chip or one faq pair. It refuses to take the list below rule 12's
 * floor rather than letting the owner make a funnel that cannot be published from
 * a control two rows from the one that would fix it - the same shape as the
 * contact step's missing band route (Branches, flow-inspector.tsx).
 */
export function removeBlockItem(
  graph: FlowGraph,
  nodeId: string,
  index: number,
  at: number,
): FlowEditResult {
  const site = blockSite(graph, nodeId);
  if (!site.ok) return no(site.reason);
  const block = site.blocks[index];
  if (!block) return no("That block is no longer on this screen.");

  if (block.kind === "trust-strip") {
    if (at < 0 || at >= block.chips.length) return no("That chip is no longer there.");
    if (block.chips.length <= MIN_CHIPS) {
      return no("A trust strip needs at least one chip. Remove the whole block instead.");
    }
    const next: FlowBlock = {
      kind: "trust-strip",
      practiceName: block.practiceName,
      chips: block.chips.filter((_, i) => i !== at),
    };
    return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
  }
  if (block.kind === "faq") {
    if (at < 0 || at >= block.items.length) return no("That question is no longer there.");
    if (block.items.length <= MIN_FAQ_ITEMS) {
      return no(
        `A questions-and-answers block needs at least ${MIN_FAQ_ITEMS} questions. Remove the whole block instead.`,
      );
    }
    const next: FlowBlock = {
      kind: "faq",
      items: block.items.filter((_, i) => i !== at).map((it) => ({ q: it.q, a: it.a })),
    };
    return ok(withBlocks(graph, site.node, site.blocks.map((b, i) => (i === index ? next : b))));
  }
  return no(`A ${BLOCK_LABELS[block.kind]} block has no list to remove from.`);
}

// ---------------------------------------------------------------------------
// ANSWER-CARD PICTURES (rule 14's editing half).
// ---------------------------------------------------------------------------

/** One answer of a question step, and the picture on it. The rail's row. */
export interface OptionImageRow {
  value: string;
  label: string;
  /** The manifest key on this answer right now, or null for an unpictured one. */
  image: string | null;
  /**
   * True for the ONE answer rule 14 lets go without a picture: the last one,
   * which is where every escape hatch in the bank is written ("I'm not sure").
   */
  mayGoWithout: boolean;
}

/**
 * Every answer of this step with its picture, in the order the patient sees them.
 * Keyed off the QUESTION rather than off the stored list, so an answer with no
 * picture still has a row to put one on - which is the whole point of the picker.
 *
 * FIRST ENTRY WINS on a repeated value, matching optionImageViews
 * (flow-block-view.ts:148) and nodeMap: a second picture for one answer is a
 * mistake rather than an override, and the drawing and the editor must agree
 * about which of the two is showing.
 */
export function optionImageRows(graph: FlowGraph, nodeId: string): OptionImageRow[] {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return [];
  const answers = routableAnswers(node);
  const byValue = new Map<string, string>();
  for (const o of optionImagesOf(node)) if (!byValue.has(o.value)) byValue.set(o.value, o.image);
  return answers.map((a, i) => ({
    value: a.value,
    label: a.label,
    image: byValue.get(a.value) ?? null,
    mayGoWithout: i === answers.length - 1,
  }));
}

/** The question node rebuilt around a new picture list. Field by field, as ever. */
function withOptionImages(
  graph: FlowGraph,
  node: Extract<FlowNode, { kind: "question" }>,
  images: FlowOptionImage[],
): FlowGraph {
  const next: FlowNode = { id: node.id, kind: "question", questionId: node.questionId };
  if (node.transition) next.transition = node.transition;
  if (images.length > 0) next.optionImages = images;
  return withRequiredSchemaVersion(replaceNode(graph, node.id, next));
}

/**
 * Put a picture on one answer, or change the one it has.
 *
 * IT DOES NOT REFUSE A RAGGED GRID, deliberately. Pictures are assigned one
 * answer at a time, so every grid is ragged on the way to being complete, and a
 * control that refused the first one would refuse all of them. Rule 14 is the
 * judgement, it names the answers still missing one, and the rail shows that
 * message live off validateFlow - so the owner is told what is left rather than
 * stopped from starting.
 */
export function setOptionImage(
  graph: FlowGraph,
  nodeId: string,
  value: string,
  key: string,
): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return no("That question step is no longer there.");
  if (!routableAnswers(node).some((a) => a.value === value)) {
    return no(`“${value}” is not an answer of the question this step asks.`);
  }
  const image = assessImage(key);
  if (!image) {
    return no(
      `“${key}” is not a picture in the library. A funnel can only use the curated pictures, never a link.`,
    );
  }
  if (image.slot !== "answer") {
    return no(
      `“${key}” is a screen picture (${image.width}x${image.height}); an answer card needs a tile made for a card.`,
    );
  }

  const current = optionImagesOf(node);
  const held = current.some((o) => o.value === value);
  if (!held && current.length >= FLOW_LIMITS.optionImages) {
    return no(`A question can carry at most ${FLOW_LIMITS.optionImages} answer pictures.`);
  }
  // Replaced IN PLACE when the answer already had one: the stored order is what
  // rule 14 walks and what the owner just read down the rail.
  const images = held
    ? current.map((o) => (o.value === value ? { value: o.value, image: image.key } : { value: o.value, image: o.image }))
    : [...current.map((o) => ({ value: o.value, image: o.image })), { value, image: image.key }];
  return ok(withOptionImages(graph, node, images));
}

export function removeOptionImage(graph: FlowGraph, nodeId: string, value: string): FlowEditResult {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return no("That question step is no longer there.");
  const current = optionImagesOf(node);
  if (!current.some((o) => o.value === value)) return no("That answer has no picture on it.");
  return ok(
    withOptionImages(
      graph,
      node,
      current.filter((o) => o.value !== value).map((o) => ({ value: o.value, image: o.image })),
    ),
  );
}

/**
 * WHAT CHANGING THE QUESTION WOULD COST, in words, BEFORE it is changed.
 *
 * setNodeQuestion drops answer-card pictures silently, and it has to: they name
 * option values of the question being swapped away, so rule 14 would fail on
 * every one of them (setNodeQuestion's own header). Silently is the problem. The
 * rail has no confirm dialog anywhere - its whole pattern is "refuse, in words" -
 * and this is the half of that pattern for an edit that is allowed: say what will
 * go, on the picker, while the old question is still selected.
 *
 * Null when nothing would be lost, which is the usual case.
 */
export function questionSwapWarning(graph: FlowGraph, nodeId: string): string | null {
  const node = nodeMap(graph).get(nodeId);
  if (!node || node.kind !== "question") return null;
  const count = optionImagesOf(node).length;
  if (count === 0) return null;
  return count === 1
    ? "Changing the question removes the answer picture on this screen: it belongs to an answer the new question does not have."
    : `Changing the question removes the ${count} answer pictures on this screen: they belong to answers the new question does not have.`;
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

/**
 * WHAT HAPPENS TO AN ENQUIRY THAT LANDS IN THIS BAND. One line per result step,
 * because "Early enquiry" on its own tells the owner what the score was and
 * nothing about what the practice then does - which is the only reason there are
 * three result steps rather than one.
 *
 * Read off the submit route, not invented: a HIGH band with a reachable contact
 * becomes a Speed-to-lead lead and is messaged inside the request
 * (api/smile-assessment/submit/route.ts:291), and the other two are recorded for
 * the team to work (BAND_MESSAGE, :84-88).
 */
const BAND_NEXT: Record<FlowBand, string> = {
  high: "Contacted straight away",
  medium: "Followed up by the team",
  low: "Kept on the list for later",
};

/**
 * WHAT THE CONTACT STEP ACTUALLY ASKS FOR, in the order the public funnel asks
 * it: a first name, how to reply, and then the one address that channel needs -
 * a mobile number for a text, an email address for an email
 * (deterministic-assessment-quiz.tsx:717-771). Listed on the card because "the
 * enquiry is captured here" is not the same information as "these three things
 * are what we end up holding".
 */
const CONTACT_FIELDS: readonly string[] = ["First name", "How to reach you", "Mobile or email"];

/** Said on a welcome card that has no authored intro of its own. */
const WELCOME_DEFAULT_INTRO = "Uses the assessment’s own intro";

/**
 * Where the welcome step lands a patient. It is an OVERRIDE of the assessment's
 * hero copy rather than a screen of its own (deterministic-assessment-quiz.tsx
 * :207-212), and a card that does not say so reads as a step nobody sees.
 */
const WELCOME_PLACE = "Sits above the first question";

export const FLOW_BAND_TITLES = BAND_TITLE;
export const FLOW_BAND_LABELS = BAND_SHORT;

export interface FlowCardText {
  eyebrow: string;
  title: string;
  options: string[];
}

/**
 * The card for one step: what it is, what it asks, and what it offers.
 *
 * EVERY KIND CARRIES ROWS, not only questions. A question card has always listed
 * its answers; the other three returned an empty list, so three quarters of a
 * funnel drew as a title in an empty rectangle and the canvas could not be read
 * without opening each step in the inspector. The rows below are FACTS about the
 * step - what the contact form captures, where the welcome copy appears, what
 * happens to an enquiry in this band - never restatements of the title.
 */
export function describeNode(node: FlowNode): FlowCardText {
  switch (node.kind) {
    case "welcome":
      return {
        eyebrow: "Start",
        title: node.headline ?? "Welcome screen",
        options: [node.intro ?? WELCOME_DEFAULT_INTRO, WELCOME_PLACE],
      };
    case "contact":
      // A copy, because a caller may hold and sort what it is handed.
      return { eyebrow: "Capture", title: "Contact details", options: [...CONTACT_FIELDS] };
    case "outcome":
      return {
        eyebrow: `Result · ${BAND_SHORT[node.band]}`,
        title: node.headline ?? BAND_TITLE[node.band],
        options: [BAND_NEXT[node.band]],
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
