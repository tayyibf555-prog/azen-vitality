// THE WALK. Given an authored funnel and the answers so far, what does the
// patient see next? Pure, synchronous, no I/O, no AI: this is the whole of
// deterministic mode's decision making.
//
// BUNDLE SAFETY. Like flow.ts, this module imports NOTHING but flow.ts - in
// particular not ./quiz and not ./scoring. It runs in the browser, and the
// question bank carries the option WEIGHTS, which are the practice's scoring
// model and must never be published. The walk needs none of it: an authored
// funnel routes on option VALUES, which the patient already knows because they
// just clicked one. flow-runtime.test.ts pins this by reading the source.
//
// WHERE THE WELCOME SCREEN WENT. A welcome node needs no answer, so the walk
// passes straight through it; the component renders it from `welcomeNode(graph)`
// as its own intro phase, exactly as the Guided style already does
// (guided-assessment-quiz.tsx:42). walkFlow only ever returns something that
// needs the patient to DO something.
//
// WHY "stuck" IS A STATUS AND NOT A NULL. If the answers cannot be routed
// through this graph, the honest answer is "this funnel cannot serve this
// session" - and the caller falls back to the adaptive funnel, which always
// works. The tempting alternative, quietly jumping to the contact step, is the
// dangerous one: the submission would then be missing core questions, so
// scoring.ts:98-105 caps it at "medium" and the lead is never fast-tracked
// (submit/route.ts:291). Silent, and it looks like it worked. So the walk says
// so instead.

import { edgesFrom, nodeMap, type FlowBand, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";

export type QuestionNode = Extract<FlowNode, { kind: "question" }>;
export type ContactNode = Extract<FlowNode, { kind: "contact" }>;
export type OutcomeNode = Extract<FlowNode, { kind: "outcome" }>;
export type WelcomeNode = Extract<FlowNode, { kind: "welcome" }>;

export type FlowWalk =
  | {
      status: "ask";
      node: QuestionNode;
      /** The warm lead-in for this step: the edge's line if it has one, else the node's. */
      transition: string | null;
      /** Question ids answered on the way here, in order. Drives the progress bar. */
      asked: string[];
    }
  | { status: "contact"; node: ContactNode; transition: string | null; asked: string[] }
  | {
      status: "stuck";
      /** Plain reason, for a log line. Never shown to a patient. */
      reason: string;
      /** The node id the walk gave up at. */
      at: string;
      asked: string[];
    };

/** The entry welcome screen, if the funnel opens with one. */
export function welcomeNode(graph: FlowGraph): WelcomeNode | null {
  const node = nodeMap(graph).get(graph.entry);
  return node && node.kind === "welcome" ? node : null;
}

/**
 * Pick the edge an answer takes: an exact match first, in declaration order, then
 * the default edge. Declaration order is what makes the walk deterministic, which
 * is why edgesFrom preserves it.
 */
function routeFor(edges: FlowEdge[], answer: string | null): FlowEdge | null {
  if (answer !== null) {
    const exact = edges.find((e) => e.answer === answer);
    if (exact) return exact;
  }
  return edges.find((e) => e.answer === null) ?? null;
}

/**
 * Walk from the entry to whatever needs the patient next.
 *
 * `answers` maps question id -> chosen option value, exactly as the submission
 * does. Ids the graph does not use are ignored, which is what makes an edit
 * mid-session survivable: a session holding answers from an older version of the
 * funnel simply re-walks the new one, keeps whatever still applies, and stops at
 * the first question it has no answer for.
 */
export function walkFlow(graph: FlowGraph, answers: Record<string, string>): FlowWalk {
  const byId = nodeMap(graph);
  const asked: string[] = [];
  let current = byId.get(graph.entry);
  if (!current) {
    return { status: "stuck", reason: `entry "${graph.entry}" is not a node`, at: graph.entry, asked };
  }

  let transition: string | null = null;
  // Hard bound: a valid funnel is acyclic (rule 4), but a graph that reached the
  // runtime without validating must still terminate rather than hang a browser.
  const limit = graph.nodes.length + 1;

  for (let hop = 0; hop <= limit; hop++) {
    if (current.kind === "question") {
      const answer = answers[current.questionId];
      if (typeof answer !== "string" || answer === "") {
        return { status: "ask", node: current, transition: transition ?? current.transition ?? null, asked };
      }
      const edge = routeFor(edgesFrom(graph, current.id), answer);
      if (!edge) {
        return {
          status: "stuck",
          reason: `"${current.id}" has no route for answer "${answer}" and no default edge`,
          at: current.id,
          asked,
        };
      }
      asked.push(current.questionId);
      const next = byId.get(edge.to);
      if (!next) {
        return { status: "stuck", reason: `edge points at unknown node "${edge.to}"`, at: current.id, asked };
      }
      transition = edge.transition ?? null;
      current = next;
      continue;
    }

    if (current.kind === "welcome") {
      const edge = routeFor(edgesFrom(graph, current.id), null);
      const next = edge ? byId.get(edge.to) : undefined;
      if (!edge || !next) {
        return { status: "stuck", reason: `welcome step "${current.id}" leads nowhere`, at: current.id, asked };
      }
      transition = edge.transition ?? null;
      current = next;
      continue;
    }

    if (current.kind === "contact") {
      return { status: "contact", node: current, transition, asked };
    }

    // An outcome before the contact step is exactly what rule 6 exists to stop.
    // Reaching one here means an unvalidated graph is live: say so.
    return {
      status: "stuck",
      reason: `reached result step "${current.id}" before the contact step`,
      at: current.id,
      asked,
    };
  }

  return { status: "stuck", reason: "the funnel did not settle; it may contain a loop", at: current.id, asked };
}

/**
 * The next node needing the patient: a question, or the contact step. null means
 * the walk could not route these answers - the caller falls back to the adaptive
 * funnel rather than pretending the funnel finished. Use walkFlow when the reason
 * matters (it usually does).
 */
export function nextNode(graph: FlowGraph, answers: Record<string, string>): FlowNode | null {
  const walk = walkFlow(graph, answers);
  return walk.status === "stuck" ? null : walk.node;
}

/**
 * The result step for a band. The band is decided SERVER-SIDE by scoreAssessment
 * after the submission, so this runs once, at the end - never during the walk.
 * Prefers the band's own edge out of the contact step, then the default edge,
 * then any result node carrying that band. null when the graph offers none, and
 * the caller falls back to the standard result copy (result-copy.ts), which is
 * derived from the band anyway.
 */
export function outcomeNodeFor(graph: FlowGraph, band: FlowBand): OutcomeNode | null {
  const byId = nodeMap(graph);
  const contact = graph.nodes.find((n) => n.kind === "contact");
  if (contact) {
    const edge = routeFor(edgesFrom(graph, contact.id), band);
    const target = edge ? byId.get(edge.to) : undefined;
    if (target && target.kind === "outcome") return target;
  }
  const any = graph.nodes.find((n) => n.kind === "outcome" && n.band === band);
  return any && any.kind === "outcome" ? any : null;
}

/**
 * A representative path from the entry to `nodeId`: the first one found walking
 * edges in declaration order, which makes it stable for the same graph. Used by
 * the builder to answer "how does a patient get here?". null when the node is
 * unreachable. Cycle-safe.
 */
export function pathTo(graph: FlowGraph, nodeId: string): FlowNode[] | null {
  const byId = nodeMap(graph);
  const target = byId.get(nodeId);
  const entry = byId.get(graph.entry);
  if (!target || !entry) return null;

  // Doubles as memoisation: once a node has been fully explored without finding
  // the target, the target is not reachable from it, so re-entering is pointless.
  // That is also what makes this safe on a graph that turned out to have a loop.
  const visited = new Set<string>();
  const trail: FlowNode[] = [];

  const walk = (node: FlowNode): boolean => {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    trail.push(node);
    if (node.id === nodeId) return true;
    for (const e of edgesFrom(graph, node.id)) {
      const next = byId.get(e.to);
      if (next && walk(next)) return true;
    }
    trail.pop();
    return false;
  };

  return walk(entry) ? trail : null;
}
