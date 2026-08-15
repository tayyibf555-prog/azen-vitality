// THE GATE. A funnel graph is only allowed to face a patient if it passes every
// rule here. Pure, no I/O, exhaustively tested (flow-validate.test.ts breaks each
// rule deliberately and proves it goes red).
//
// EVERY FAILURE IS RETURNED AT ONCE, never just the first. That is the
// validateContent doctrine (src/lib/landing/content.ts:311-318): the AI repair
// pass quotes the whole list back to the model, and an owner fixing a funnel by
// hand should see all of it in one go rather than playing whack-a-mole.
//
// The rules are numbered 1-11 and the numbers are part of the contract (the tests
// and the repair prompt cite them). Rule 0 is reserved for "the blob was not even
// readable as a graph" (see normaliseAndValidateFlow at the bottom).
//
// TWO RULES ARE LOAD-BEARING AND SILENT IF BROKEN:
//
//   RULE 10 (core coverage). scoring.ts:98-105 downgrades a "high" band to
//   "medium" whenever treatment + timeline + funding were not all answered. A
//   medium never fires the Speed-to-lead bridge (submit/route.ts:291). So a funnel
//   that forgets the funding question produces ZERO fast-tracked leads, forever,
//   with no error in any log and a quiz that looks like it works perfectly. That
//   is why this is a hard rule and not a warning.
//
//   RULE 11 (region). shouldFinish requires it (funnel.ts:72) and the booking
//   agent routes the patient to the nearest practice from it (quiz.ts:191-196). A
//   funnel without it produces leads nobody can route.

import {
  QUIZ_QUESTION_IDS,
  questionById,
  Q_TREATMENT,
  Q_TIMELINE,
  Q_BUDGET,
  Q_LOCATION,
} from "./quiz";
import { MAX_QUESTIONS } from "./funnel";
import {
  FLOW_BANDS,
  FLOW_SCHEMA_VERSION,
  isFlowBand,
  nodeMap,
  normaliseFlow,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";

/** The trio scoring.ts:98-105 demands before a lead may band "high". */
export const CORE_FLOW_QUESTION_IDS: readonly string[] = [Q_TREATMENT, Q_TIMELINE, Q_BUDGET];

/**
 * Longest allowed run of QUESTIONS on any one path. Parity with the adaptive
 * funnel's hard cap (funnel.ts:19) plus two, so an author has a little slack for a
 * branch-specific extra without ever shipping a funnel longer than the adaptive
 * one feels. Counted in question nodes only: welcome/contact/outcome are not asks.
 */
export const MAX_FLOW_QUESTION_DEPTH = MAX_QUESTIONS + 2;

export interface FlowValidationFailure {
  /** 1-11, or 0 for an unreadable blob. Cited by the tests and the repair prompt. */
  rule: number;
  /** Stable machine code, e.g. "core_missing". */
  code: string;
  /** Where it was found: a node id, an edge description, or "flow". */
  where: string;
  /** One line an owner (or the model) can act on. */
  message: string;
}

export interface FlowValidationResult {
  ok: boolean;
  failures: FlowValidationFailure[];
}

function edgeLabel(e: FlowEdge): string {
  return `edge ${e.from} -> ${e.to} (${e.answer === null ? "default" : e.answer})`;
}

function ownQuestion(n: FlowNode): string | null {
  return n.kind === "question" ? n.questionId : null;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

/** Per-node facts about EVERY path that reaches it. The heart of rules 6 and 8-11. */
interface NodeFacts {
  /** Question ids asked on ALL paths to this node (intersection / "must").   */
  must: Set<string>;
  /** Question ids asked on SOME path to this node (union / "may").           */
  may: Set<string>;
  /** Treatment answers possible on the paths that reach this node.           */
  treat: Set<string>;
  /** Node ids that every path to this node passes through (dominators).      */
  dom: Set<string>;
  /** Most questions asked strictly before this node, on any path.            */
  depth: number;
}

export function validateFlow(graph: FlowGraph): FlowValidationResult {
  const failures: FlowValidationFailure[] = [];
  const fail = (rule: number, code: string, where: string, message: string): void => {
    failures.push({ rule, code, where, message });
  };

  // -------------------------------------------------------------------------
  // RULE 1 - structure: schema version, a real single entry, unique node ids,
  // edges that point at nodes that exist.
  // -------------------------------------------------------------------------
  if (graph.schemaVersion !== FLOW_SCHEMA_VERSION) {
    fail(
      1,
      "schema_version",
      "flow",
      `schemaVersion must be ${FLOW_SCHEMA_VERSION}, got ${graph.schemaVersion}`,
    );
  }

  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) {
      fail(1, "duplicate_node_id", n.id, `two nodes share the id "${n.id}"`);
    }
    seen.add(n.id);
  }

  const byId = nodeMap(graph);
  const entry = byId.get(graph.entry);
  if (!entry) {
    fail(
      1,
      "entry_missing",
      "flow",
      `entry "${graph.entry}" is not one of the nodes, so nothing that depends on walking the funnel could be checked`,
    );
  }

  const edges: FlowEdge[] = [];
  for (const e of graph.edges) {
    let usable = true;
    if (!byId.has(e.from)) {
      fail(1, "edge_unknown_from", edgeLabel(e), `edge starts at unknown node "${e.from}"`);
      usable = false;
    }
    if (!byId.has(e.to)) {
      fail(1, "edge_unknown_to", edgeLabel(e), `edge ends at unknown node "${e.to}"`);
      usable = false;
    }
    if (usable) edges.push(e);
  }

  const outByNode = new Map<string, FlowEdge[]>();
  const inByNode = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const out = outByNode.get(e.from);
    if (out) out.push(e);
    else outByNode.set(e.from, [e]);
    const into = inByNode.get(e.to);
    if (into) into.push(e);
    else inByNode.set(e.to, [e]);
  }
  const outs = (id: string): FlowEdge[] => outByNode.get(id) ?? [];
  const ins = (id: string): FlowEdge[] => inByNode.get(id) ?? [];

  // -------------------------------------------------------------------------
  // RULES 2 + 3 - what an edge may say, and that every answer has somewhere to
  // go. Walked per node so the messages name the node the author must fix.
  // -------------------------------------------------------------------------
  for (const n of graph.nodes) {
    const out = outs(n.id);

    // Ambiguous routing: two edges out of one node claiming the same answer.
    const claimed = new Set<string>();
    for (const e of out) {
      const key = e.answer === null ? "\u0000default" : e.answer;
      if (claimed.has(key)) {
        fail(
          3,
          "duplicate_edge_answer",
          edgeLabel(e),
          `"${n.id}" already has an edge for ${e.answer === null ? "the default route" : `answer "${e.answer}"`}`,
        );
      }
      claimed.add(key);
    }
    const hasDefault = out.some((e) => e.answer === null);

    if (n.kind === "question") {
      const q = questionById(n.questionId);
      if (!q || !QUIZ_QUESTION_IDS.includes(n.questionId)) {
        fail(
          2,
          "unknown_question",
          n.id,
          `questionId "${n.questionId}" is not in the question bank (quiz.ts). A funnel may only ask bank questions.`,
        );
        continue; // no options to check coverage against
      }
      const values = new Set(q.options.map((o) => o.value));
      for (const e of out) {
        if (e.answer !== null && !values.has(e.answer)) {
          fail(
            2,
            "edge_answer_not_an_option",
            edgeLabel(e),
            `"${e.answer}" is not an option of "${n.questionId}"`,
          );
        }
      }
      if (out.length === 0) {
        fail(3, "no_outgoing", n.id, `question "${n.id}" has no outgoing edge, so the funnel stops on it`);
      } else if (!hasDefault) {
        for (const o of q.options) {
          if (!claimed.has(o.value)) {
            fail(
              3,
              "option_uncovered",
              n.id,
              `option "${o.value}" of "${n.questionId}" has no edge and there is no default edge`,
            );
          }
        }
      }
    } else if (n.kind === "contact") {
      // Edges out of contact carry the BAND, decided server-side after scoring.
      for (const e of out) {
        if (e.answer !== null && !isFlowBand(e.answer)) {
          fail(
            2,
            "edge_band_invalid",
            edgeLabel(e),
            `an edge out of the contact step must carry a band (${FLOW_BANDS.join(", ")}) or be the default`,
          );
        }
      }
      if (out.length === 0) {
        fail(3, "contact_has_no_route", n.id, `contact step "${n.id}" leads nowhere: no result is ever shown`);
      } else if (!hasDefault) {
        for (const band of FLOW_BANDS) {
          if (!claimed.has(band)) {
            fail(3, "band_uncovered", n.id, `no route out of the contact step for a "${band}" result`);
          }
        }
      }
    } else if (n.kind === "welcome") {
      for (const e of out) {
        if (e.answer !== null) {
          fail(
            2,
            "edge_answer_on_welcome",
            edgeLabel(e),
            "an edge out of the welcome step must be the default: nothing has been answered yet",
          );
        }
      }
      if (out.length === 0) {
        fail(3, "no_outgoing", n.id, `welcome step "${n.id}" has no outgoing edge, so the funnel never starts`);
      }
    } else {
      // outcome: terminal. Reported under rule 7 below.
    }
  }

  // Nothing further is meaningful without a real entry to walk from.
  if (!entry) {
    return { ok: false, failures };
  }

  // -------------------------------------------------------------------------
  // RULE 5 - reachability. Everything after this works on the reachable
  // subgraph only, so an unreachable branch cannot poison the path analysis.
  // -------------------------------------------------------------------------
  const reachable = new Set<string>([entry.id]);
  const queue: string[] = [entry.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of outs(id)) {
      if (!reachable.has(e.to)) {
        reachable.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) {
      fail(5, "orphan", n.id, `"${n.id}" cannot be reached from the entry step`);
    }
  }

  const liveNodes = graph.nodes.filter((n) => reachable.has(n.id) && byId.get(n.id) === n);
  const liveIns = (id: string): FlowEdge[] => ins(id).filter((e) => reachable.has(e.from));

  // -------------------------------------------------------------------------
  // RULE 7 - every dead end is an outcome, outcomes are dead ends, and all three
  // bands exist. (Checked on the reachable subgraph: an orphan outcome is
  // already reported by rule 5 and must not satisfy a band.)
  // -------------------------------------------------------------------------
  for (const n of liveNodes) {
    const out = outs(n.id);
    if (n.kind === "outcome" && out.length > 0) {
      fail(7, "outcome_not_terminal", n.id, `result step "${n.id}" has an outgoing edge; a result ends the funnel`);
    }
    if (out.length === 0 && n.kind !== "outcome") {
      fail(
        7,
        "terminal_not_outcome",
        n.id,
        `"${n.id}" is a dead end but is not a result step, so the patient is left with nothing`,
      );
    }
  }
  const liveOutcomes = liveNodes.filter((n): n is Extract<FlowNode, { kind: "outcome" }> => n.kind === "outcome");
  for (const band of FLOW_BANDS) {
    if (!liveOutcomes.some((o) => o.band === band)) {
      fail(7, "band_missing", "flow", `there is no reachable result step for a "${band}" result`);
    }
  }

  // -------------------------------------------------------------------------
  // RULE 4a - no cycles. Three-colour DFS (white -> grey -> black); a grey hit is
  // a back edge. This runs BEFORE any path analysis because every rule below
  // walks the graph in topological order, which a cycle makes impossible.
  // -------------------------------------------------------------------------
  const colour = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (id: string): void => {
    colour.set(id, 1);
    for (const e of outs(id)) {
      const c = colour.get(e.to) ?? 0;
      if (c === 1) {
        cyclic = true;
        fail(
          4,
          "cycle",
          edgeLabel(e),
          `this edge loops back to "${e.to}", so a patient could go round for ever`,
        );
      } else if (c === 0) {
        visit(e.to);
      }
    }
    colour.set(id, 2);
  };
  visit(entry.id);

  if (cyclic) {
    // Path analysis (rules 4b, 6, 8, 9, 10, 11) cannot terminate on a cyclic
    // graph. Say so loudly rather than silently returning a shorter, friendlier
    // looking list of failures.
    fail(
      4,
      "cycle_blocks_checks",
      "flow",
      "the loop above must be removed before contact placement, repeat questions, treatment relevance, core coverage and region coverage can be checked",
    );
    return { ok: false, failures };
  }

  // -------------------------------------------------------------------------
  // Path analysis. Kahn topological order over the reachable subgraph, then ONE
  // forward pass computing the four facts every remaining rule needs. Dataflow,
  // not path enumeration: a branchy funnel has exponentially many paths, and
  // walking them all would be a hang, not a rule.
  // -------------------------------------------------------------------------
  const indegree = new Map<string, number>();
  for (const n of liveNodes) indegree.set(n.id, liveIns(n.id).length);
  const ready = liveNodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of outs(id)) {
      if (!reachable.has(e.to)) continue;
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) ready.push(e.to);
    }
  }

  const facts = new Map<string, NodeFacts>();
  const treatmentQuestion = questionById(Q_TREATMENT);
  const allTreatments = new Set((treatmentQuestion?.options ?? []).map((o) => o.value));

  /** The treatment answers this edge carries forward out of node `from`. */
  const treatOut = (from: FlowNode, e: FlowEdge, before: Set<string>): Set<string> => {
    if (from.kind !== "question" || from.questionId !== Q_TREATMENT) return before;
    if (e.answer !== null) return new Set([e.answer]);
    // The default edge carries every option NOT explicitly routed elsewhere.
    const routed = new Set(outs(from.id).map((x) => x.answer).filter((a): a is string => a !== null));
    return new Set([...allTreatments].filter((v) => !routed.has(v)));
  };

  for (const id of order) {
    // "must" and "dom" MEET with intersection, so they start as null (unknown)
    // rather than empty, or the first predecessor would wipe them out.
    let must: Set<string> | null = null;
    let dom: Set<string> | null = null;
    const may = new Set<string>();
    const treat = new Set<string>();
    let depth = 0;

    for (const e of liveIns(id)) {
      const from = byId.get(e.from);
      const f = facts.get(e.from);
      if (!from || !f) continue; // impossible in topological order on a DAG
      const own = ownQuestion(from);
      const afterMust = own ? new Set([...f.must, own]) : f.must;
      must = must === null ? new Set(afterMust) : intersect(must, afterMust);
      for (const v of f.may) may.add(v);
      if (own) may.add(own);
      for (const v of treatOut(from, e, f.treat)) treat.add(v);
      const afterDom = new Set([...f.dom, e.from]);
      dom = dom === null ? afterDom : intersect(dom, afterDom);
      depth = Math.max(depth, f.depth + (own ? 1 : 0));
    }

    const domSet = dom ?? new Set<string>();
    domSet.add(id);
    facts.set(id, { must: must ?? new Set<string>(), may, treat, dom: domSet, depth });
  }

  // ---- RULE 4b - length. Counted in questions, the patient-facing measure. ----
  let longest = 0;
  for (const n of liveNodes) {
    const f = facts.get(n.id);
    if (!f) continue;
    longest = Math.max(longest, f.depth + (ownQuestion(n) ? 1 : 0));
  }
  if (longest > MAX_FLOW_QUESTION_DEPTH) {
    fail(
      4,
      "too_deep",
      "flow",
      `the longest path asks ${longest} questions; the limit is ${MAX_FLOW_QUESTION_DEPTH}`,
    );
  }

  // ---- RULE 8 - a question is never asked twice on one path. -----------------
  for (const n of liveNodes) {
    if (n.kind !== "question") continue;
    const f = facts.get(n.id);
    if (f?.may.has(n.questionId)) {
      fail(
        8,
        "question_repeated",
        n.id,
        `"${n.questionId}" can already have been asked before "${n.id}" on some path`,
      );
    }
  }

  // ---- RULE 9 - a treatment-specific question only on its own branch. -------
  // The invariant candidateQuestions enforces at runtime in adaptive mode
  // (funnel.ts:53): a question with appliesTo is only relevant to those
  // treatments, and asking it off-branch is a nonsense question to the patient.
  for (const n of liveNodes) {
    if (n.kind !== "question") continue;
    const q = questionById(n.questionId);
    if (!q?.appliesTo) continue;
    const f = facts.get(n.id);
    if (!f) continue;
    if (!f.must.has(Q_TREATMENT)) {
      fail(
        9,
        "applies_to_unanswered",
        n.id,
        `"${n.questionId}" only applies to ${q.appliesTo.join(", ")}, but "${n.id}" can be reached before the treatment question is answered`,
      );
    }
    for (const t of f.treat) {
      if (!q.appliesTo.includes(t)) {
        fail(
          9,
          "applies_to_violation",
          n.id,
          `"${n.questionId}" only applies to ${q.appliesTo.join(", ")}, but "${n.id}" is reachable after answering treatment "${t}"`,
        );
      }
    }
  }

  // ---- RULE 6 - exactly one contact step, and it comes before every result. --
  const contacts = liveNodes.filter((n) => n.kind === "contact");
  if (contacts.length !== 1) {
    fail(
      6,
      "contact_count",
      "flow",
      `a funnel needs exactly one contact step, found ${contacts.length}`,
    );
  }
  const contact = contacts.length === 1 ? contacts[0]! : null;
  if (contact) {
    for (const o of liveOutcomes) {
      if (!facts.get(o.id)?.dom.has(contact.id)) {
        fail(
          6,
          "outcome_before_contact",
          o.id,
          `result step "${o.id}" can be reached without passing the contact step, so that lead is never captured`,
        );
      }
    }
  }

  // ---- RULES 10 + 11 - what EVERY path must have answered by the end. -------
  // Anchored on the contact step (the moment the lead is captured). With no
  // single contact step there is nothing to anchor on, so fall back to every
  // dead end, which still catches an under-covered path.
  const anchors: FlowNode[] = contact ? [contact] : liveNodes.filter((n) => outs(n.id).length === 0);
  for (const a of anchors) {
    const f = facts.get(a.id);
    if (!f) continue;
    for (const core of CORE_FLOW_QUESTION_IDS) {
      if (!f.must.has(core)) {
        fail(
          10,
          "core_missing",
          a.id,
          `"${core}" is not answered on every path to "${a.id}". Without all of ${CORE_FLOW_QUESTION_IDS.join(", ")} every lead is capped at "medium" (scoring.ts:98-105) and none is ever fast-tracked.`,
        );
      }
    }
    if (!f.must.has(Q_LOCATION)) {
      fail(
        11,
        "location_missing",
        a.id,
        `"${Q_LOCATION}" is not answered on every path to "${a.id}", so the team cannot route the enquiry to a practice`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Model-facing summary of every failure, for the one repair pass (brief §6). */
export function describeFlowFailures(failures: FlowValidationFailure[]): string {
  return failures.map((f) => `- [rule ${f.rule}: ${f.code}] ${f.where}: ${f.message}`).join("\n");
}

/**
 * The single entry point for "I have a blob, can I use it?" - coercion (shape)
 * then validation (rules). Used by the public read path and by the generator, so
 * both treat an unreadable blob and a broken graph the same way: no flow, and the
 * caller falls back to the adaptive funnel.
 */
export function normaliseAndValidateFlow(raw: unknown): {
  graph: FlowGraph | null;
  result: FlowValidationResult;
} {
  const graph = normaliseFlow(raw);
  if (!graph) {
    return {
      graph: null,
      result: {
        ok: false,
        failures: [
          {
            rule: 0,
            code: "unreadable",
            where: "flow",
            message: "the funnel could not be read as a graph (wrong shape, a malformed node or edge, or copy over the length limit)",
          },
        ],
      },
    };
  }
  const result = validateFlow(graph);
  return { graph: result.ok ? graph : null, result };
}
