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
  cloneFlowBlock,
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
