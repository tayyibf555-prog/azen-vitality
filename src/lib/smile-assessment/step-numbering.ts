// THE STEP NUMBER. Which ordinal a screen of an authored funnel is recorded
// under, decided ONCE, here, for both halves of the drop-off feature.
//
// ============================================================================
// WHY THIS MODULE EXISTS AT ALL.
//
// A3 shipped the pipeline and deliberately refused to pick a numbering (see the
// note that used to sit in step-beacon.ts and drop-off/route.ts). There were three
// candidates already in the tree and not one of them is a screen ordinal:
//
//   phoneFlowLayout's `step`  a 1-based QUESTION chip. A welcome step SHARES the
//                             first question's number, so two screens carry one
//                             number and a bar chart keyed on it loses a screen.
//   walkFlow's `asked`        a list of question ids, i.e. the path a SESSION took.
//                             Its length is depth, so "step 2" is a different
//                             question for two patients on two branches — which is
//                             exactly what a per-screen drop-off chart must not be.
//   the node id               author-chosen, renamed freely, and already ruled out
//                             by 0080's column comment.
//
// So the numbering is a THIRD thing, defined here: a screen's position in the
// funnel's own canonical order. The emitter (the deterministic quiz) and the
// reader (the drop-off route's labels + stepCount) both call this function, so
// there is exactly one place that can be wrong.
//
// THE ORDER: LONGEST-PATH DEPTH, THEN DECLARATION ORDER.
//
// Depth is "the most screens a patient can see before this one", which is the same
// layering the builder's canvas draws its columns with (flow-layout.ts). It is the
// right axis for two reasons that are facts about the graph rather than taste:
//
//   - it puts SHARED ENDINGS LAST. The contact step is a single node every branch
//     converges on (rule 6), so its longest-path depth is greater than every
//     question that can precede it. Breadth-first order would not do this: a short
//     branch straight to the contact step would number it before questions that
//     come earlier for everybody else, and the chart would draw the contact screen
//     in the middle of the funnel.
//   - it is a property of the FUNNEL, not of the picture.
//
// The tie inside one depth is broken by DECLARATION ORDER (the node's position in
// graph.nodes), and that is a deliberate departure from the canvas, which breaks
// the same tie by barycentre to reduce wire crossings. Barycentre is a
// crossing-reduction heuristic tuned for looks; re-tuning it is a UI change nobody
// would think twice about, and if the analytics numbering rode on it every stored
// ordinal for the SAME flow version would silently re-map to a different screen.
// Declaration order changes only when the funnel is edited, and an edit bumps
// flow_version (0078), which is the scope every tally is already keyed on.
//
// It also keeps this module free of flow-layout.ts, which matters twice: the
// public quiz would otherwise ship the whole canvas geometry engine to a patient
// on a phone, and the numbering would inherit a dependency on layout METRICS.
//
// THE SCREENS, AND WHY THEY ARE NOT THE NODES ONE-FOR-ONE. This numbers what the
// deterministic runtime actually PUTS ON SCREEN, which is not the node list:
//
//   welcome   NOT A SCREEN. There is no start button anywhere in this runtime: a
//             welcome step's headline and intro are rendered above the FIRST
//             QUESTION'S prompt, on the question screen
//             (deterministic-assessment-quiz.tsx, flow-phone-screen.ts:
//             "welcome-question"). Giving it an ordinal would mean a bar that is
//             permanently zero, sitting where the funnel's biggest number belongs.
//   question  one ordinal each.
//   contact   one ordinal (rule 6 allows exactly one).
//   outcome   ALL RESULT STEPS SHARE THE LAST ORDINAL. This is the completion
//             decision, and it is made here rather than at the aggregation:
//             aggregateStepEvents reports completionPct as "the last step's
//             sessions over the first step's", so with three separate result
//             ordinals (high/medium/low) the reported completion would be the
//             share of visitors who got the LOW result — a number that reads like
//             a funnel completion rate and is not one. Collapsed, the last ordinal
//             means "reached ANY result screen", so completionPct is literally the
//             completion rate, and the three bands stay separable through
//             smile_assessment_response, which records the band with the lead.
//
// ONLY WHAT IS REACHABLE. A node the entry cannot reach is a node no patient can
// see, so it gets no ordinal and does not lengthen the funnel. (Rule 5 forbids one
// in a valid funnel; a draft can still have one, and the builder is where that is
// repaired.)
//
// PURE, AND BROWSER-SAFE BY THE SAME RULE flow-runtime.ts KEEPS: this module
// imports nothing but flow.ts and the step-event rules. No React, no layout, no
// ./quiz — the question bank carries the scoring WEIGHTS, and this file is pulled
// into the public quiz's bundle. step-numbering.test.ts pins the import list.

import { edgesFrom, nodeMap, type FlowGraph, type FlowNode } from "./flow";
import { MAX_STEP_INDEX } from "./step-events";

/** What sits at one ordinal. `nodeId` is the node a label should be derived from. */
export interface StepScreen {
  stepIndex: number;
  /**
   * The node this screen is drawn from. For the shared result ordinal it is the
   * FIRST result step in canonical order — every band's screen is the same slot in
   * the funnel, and a label has to come from one of them.
   */
  nodeId: string;
  kind: "question" | "contact" | "outcome";
}

export interface StepNumbering {
  /**
   * Node id -> the ordinal its screen is recorded under. Welcome steps and
   * unreachable nodes are ABSENT rather than mapped to anything, so a caller that
   * looks one up gets `undefined` and emits nothing.
   */
  ordinals: ReadonlyMap<string, number>;
  /** Ascending by stepIndex, one entry per ordinal. */
  screens: StepScreen[];
  /** How many screens this funnel has: what aggregateStepEvents fills up to. */
  stepCount: number;
  /** The contact screen's ordinal, or null when the funnel has no reachable one. */
  contactStep: number | null;
  /** The ordinal every result screen shares, or null when there is none. */
  outcomeStep: number | null;
}

/** One ordinal's worth of nodes, before the ordinals are handed out. */
interface Slot {
  kind: StepScreen["kind"];
  /** More than one only for the collapsed result slot. */
  nodeIds: string[];
}

/** Everything the entry can reach. Cycle-safe: a graph that reached us unvalidated must still terminate. */
function reachable(graph: FlowGraph): Set<string> {
  const byId = nodeMap(graph);
  const seen = new Set<string>();
  if (!byId.has(graph.entry)) return seen;
  const stack = [graph.entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edgesFrom(graph, id)) {
      if (byId.has(e.to) && !seen.has(e.to)) stack.push(e.to);
    }
  }
  return seen;
}

/**
 * Longest path from the entry to each reachable node, by Kahn's algorithm.
 *
 * A CYCLE IS SURVIVED, NOT ASSUMED AWAY. Rule 4a forbids one, and a graph that
 * never validated can still be handed here (the builder holds drafts, and this is
 * called on the stored flow). Nodes left inside a cycle are never dequeued, so
 * they are parked one layer past everything that did settle: they still get
 * ordinals, in a stable order, and they sort after the funnel that works.
 */
function depths(graph: FlowGraph, live: Set<string>): Map<string, number> {
  const depth = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const id of live) {
    depth.set(id, 0);
    indegree.set(id, 0);
  }
  for (const e of graph.edges) {
    if (!live.has(e.from) || !live.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const id of live) if ((indegree.get(id) ?? 0) === 0) queue.push(id);

  const settled = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    settled.add(id);
    for (const e of edgesFrom(graph, id)) {
      if (!live.has(e.to)) continue;
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(id) ?? 0) + 1));
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }

  if (settled.size < live.size) {
    let deepest = 0;
    for (const id of settled) deepest = Math.max(deepest, depth.get(id) ?? 0);
    for (const id of live) if (!settled.has(id)) depth.set(id, deepest + 1);
  }
  return depth;
}

/**
 * The canonical screen numbering for one funnel.
 *
 * PURE AND DETERMINISTIC: the same graph in always produces the same ordinals out,
 * and the graph is never mutated.
 */
export function stepNumbering(graph: FlowGraph): StepNumbering {
  const byId = nodeMap(graph);
  const live = reachable(graph);
  const depth = depths(graph, live);
  const declared = new Map<string, number>();
  graph.nodes.forEach((n, i) => declared.set(n.id, i));

  const order = (a: FlowNode, b: FlowNode): number =>
    (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
    (declared.get(a.id) ?? 0) - (declared.get(b.id) ?? 0);

  const nodes = [...live].map((id) => byId.get(id)!).filter(Boolean);

  const slots: Slot[] = nodes
    .filter((n) => n.kind === "question" || n.kind === "contact")
    .sort(order)
    .map((n) => ({ kind: n.kind as "question" | "contact", nodeIds: [n.id] }));

  // The one collapsed slot, always last: every band's result screen is the same
  // place in the funnel. See the header.
  const outcomes = nodes.filter((n) => n.kind === "outcome").sort(order);
  if (outcomes.length > 0) {
    slots.push({ kind: "outcome", nodeIds: outcomes.map((n) => n.id) });
  }

  // THE ANONYMOUS INPUT'S CEILING, honoured here rather than discovered at the
  // door. A funnel is capped at FLOW_LIMITS.nodes (60) screens, comfortably inside
  // MAX_STEP_INDEX, so this can only bite on a hand-edited graph — and the failure
  // it prevents is the quiet one: ordinals the endpoint silently drops, against a
  // stepCount the chart draws bars for.
  const kept = slots.slice(0, MAX_STEP_INDEX + 1);

  const ordinals = new Map<string, number>();
  const screens: StepScreen[] = [];
  let contactStep: number | null = null;
  let outcomeStep: number | null = null;

  kept.forEach((slot, stepIndex) => {
    for (const id of slot.nodeIds) ordinals.set(id, stepIndex);
    screens.push({ stepIndex, nodeId: slot.nodeIds[0]!, kind: slot.kind });
    if (slot.kind === "contact") contactStep = stepIndex;
    if (slot.kind === "outcome") outcomeStep = stepIndex;
  });

  return { ordinals, screens, stepCount: kept.length, contactStep, outcomeStep };
}

/**
 * The ordinal for one node, or null when it has none — a welcome step, an
 * unreachable node, or a node past the ceiling. Null rather than a fallback
 * number: an invented ordinal is a bar on somebody's chart.
 */
export function stepIndexOf(numbering: StepNumbering, nodeId: string): number | null {
  const found = numbering.ordinals.get(nodeId);
  return typeof found === "number" ? found : null;
}
