// WHAT THE INSPECTOR'S CONTROLS MEAN. The layer between "the owner typed in the
// headline box on the welcome screen" and the pure edit ops in flow-edit.ts.
//
// WHY IT EXISTS AT ALL, when flow-edit.ts is already the op layer. Three of the
// rail's controls are not one op each, and every one of them is the kind of rule
// that looks right in JSX and is wrong on the seventh edit:
//
//   THE PAIRING RULE. `setWelcomeCopy` takes BOTH the headline and the intro, so
//   the headline box has to re-send the intro it did not touch. Written in the
//   component that is `apply(setWelcomeCopy(graph, id, e.target.value, node.intro ?? ""))`
//   - and the day the intro box forgets to re-send the headline, typing a new
//   intro silently clears the headline, with the save reporting success.
//
//   THE ROUTE-AN-ANSWER RULE. "Send this answer somewhere" is addEdge to the
//   step's DEFAULT target, and there may not be one. The old builder disabled the
//   button in that case: a control that does nothing and does not say why.
//
//   THE SELECTION RULE. A node-scoped edit against an edge selection (or a node
//   that has since been deleted) must refuse, not throw and not silently no-op.
//
// So the rail emits an INTENT - "the headline is now this" - and everything that
// decides what that does to the graph lives here, in a module vitest can reach.
// The component is left with one line per control: apply(applyInspectorEdit(...)).
//
// AND WHICH FIELD A FAILURE BELONGS TO. validateFlow reports every failure at
// once with a `where` that is a node id, an edge description or "flow" (see
// flow-validate.ts). The banner has always shown that list whole; this module is
// what lets the rail ALSO put "option X has no edge and there is no default edge"
// next to the branch list it is about. Nothing is invented and nothing is
// dropped: an unmapped failure that names this step still surfaces, at the head
// of the rail, because a rule the owner cannot see is a rule they cannot fix.

import { nodeMap, type FlowEdge, type FlowGraph } from "./flow";
import {
  addEdge,
  defaultTargetOf,
  insertQuestionOnEdge,
  moveEdge,
  nextNodeId,
  outgoingEdges,
  planScreenInsertion,
  removeEdge,
  removeNode,
  setEdgeAnswer,
  setEdgeTarget,
  setEdgeTransition,
  setNodeQuestion,
  setOutcomeHeadline,
  setQuestionTransition,
  setWelcomeCopy,
  type FlowEditResult,
} from "./flow-edit";
import type { FlowValidationFailure } from "./flow-validate";

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

/**
 * What the rail is pointed at. A STEP or a CONNECTION, because those are the two
 * things a funnel is made of and the two things both canvases can be clicked on.
 */
export type FlowSelection = { kind: "node"; id: string } | { kind: "edge"; index: number };

export function isNodeSelected(selection: FlowSelection | null, id: string): boolean {
  return selection?.kind === "node" && selection.id === id;
}

/**
 * The step an arrow key moves to: the next one along the order it was handed.
 *
 * IT CLAMPS, IT DOES NOT WRAP. Wrapping means the right arrow on the last result
 * screen jumps back to the opening screen, which reads as the selection being
 * lost rather than as having reached the end.
 *
 * The ORDER IS AN ARGUMENT rather than something derived here, because the only
 * order that makes sense to an arrow key is the one the eye is following - the
 * phone strip's left-to-right, top-to-bottom layout (flow-phone-layout.ts). This
 * module has no business knowing about geometry.
 */
export function stepAfter(
  ids: readonly string[],
  current: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  // Nothing selected (or a step that has since gone): start at whichever end the
  // arrow came from.
  if (at < 0) return (delta >= 0 ? ids[0] : ids[ids.length - 1]) ?? null;
  const next = at + (delta >= 0 ? 1 : -1);
  if (next < 0 || next >= ids.length) return ids[at] ?? null;
  return ids[next] ?? null;
}

// ---------------------------------------------------------------------------
// Edits.
// ---------------------------------------------------------------------------

/**
 * One thing the rail can do, as an INTENT rather than as a call. The node-scoped
 * kinds act on whatever is selected; the edge-scoped ones carry their own index,
 * because the branch rows on a STEP's inspector edit that step's wires.
 */
export type InspectorEdit =
  /** Ask a different bank question on this step. */
  | { kind: "question"; questionId: string }
  /** The step's own lead-in line. */
  | { kind: "transition"; text: string }
  /** Welcome or result headline - the field is the same box on both. */
  | { kind: "headline"; text: string }
  /** The welcome step's opening line. */
  | { kind: "intro"; text: string }
  /** Give an answer that leads nowhere a route, alongside the rest. */
  | { kind: "route-option"; value: string }
  /**
   * Wire this step to another one outright. The repair for a step with NO route
   * out, which "route this answer" cannot make: it sends an answer the same way as
   * the rest, and on a dead end there is no rest.
   */
  | { kind: "connect"; to: string; answer: string | null }
  | { kind: "remove-node" }
  /**
   * ADD A SCREEN AFTER THIS ONE - the + on the strip and the rail's own control.
   *
   * IT CARRIES ITS OWN NODE, like the edge edits carry their index, because the +
   * on the canvas fires for the screen it sits beside rather than for the screen
   * that happens to be selected. A control that acted on the selection instead
   * would add the screen somewhere else entirely the first time an owner clicked a
   * + without selecting first.
   *
   * The question is optional: the + takes the first one it may offer (and lands
   * you on it, picker open), the rail's control names one. planScreenInsertion
   * settles both against the validator's list.
   */
  | { kind: "add-screen"; nodeId: string; questionId?: string }
  | { kind: "edge-target"; index: number; to: string }
  | { kind: "edge-answer"; index: number; answer: string | null }
  | { kind: "edge-transition"; index: number; text: string }
  | { kind: "remove-edge"; index: number }
  /** Move a branch up or down among the wires out of its own step. */
  | { kind: "move-edge"; index: number; delta: number }
  | { kind: "insert-question"; index: number; questionId: string };

const refuse = (reason: string): FlowEditResult => ({ ok: false, reason });

/**
 * Apply one control's intent to the draft graph. Pure: a NEW graph out, or a
 * refusal in words, exactly like every op in flow-edit.ts - which is what the
 * builder then either commits to state or shows.
 */
export function applyInspectorEdit(
  graph: FlowGraph,
  selection: FlowSelection | null,
  edit: InspectorEdit,
): FlowEditResult {
  // The wire edits address themselves and are valid from either selection: the
  // branch rows in a STEP's rail edit that step's own wires. So does "add a screen
  // after this one", which the + on the strip fires for a screen that need not be
  // the selected one.
  switch (edit.kind) {
    case "edge-target":
      return setEdgeTarget(graph, edit.index, edit.to);
    case "edge-answer":
      return setEdgeAnswer(graph, edit.index, edit.answer);
    case "edge-transition":
      return setEdgeTransition(graph, edit.index, edit.text);
    case "remove-edge":
      return removeEdge(graph, edit.index);
    case "move-edge":
      return moveEdge(graph, edit.index, edit.delta);
    case "insert-question":
      return insertQuestionOnEdge(graph, edit.index, edit.questionId);
    case "add-screen": {
      const plan = planScreenInsertion(graph, edit.nodeId, edit.questionId);
      return plan.ok
        ? insertQuestionOnEdge(graph, plan.edgeIndex, plan.questionId)
        : refuse(plan.reason);
    }
    default:
      break;
  }

  if (selection === null || selection.kind !== "node") {
    return refuse("Nothing is selected any more. Pick a screen and try again.");
  }
  const node = nodeMap(graph).get(selection.id);
  if (!node) return refuse("That step is no longer there.");

  switch (edit.kind) {
    case "question":
      return setNodeQuestion(graph, node.id, edit.questionId);

    case "transition":
      return setQuestionTransition(graph, node.id, edit.text);

    case "headline":
      // ONE BOX, TWO OPS. The welcome screen and a result screen both have a
      // headline and the rail draws one field for it; which op that is, is a
      // fact about the node and is decided here rather than in the JSX.
      return node.kind === "welcome"
        ? setWelcomeCopy(graph, node.id, edit.text, node.intro ?? "")
        : setOutcomeHeadline(graph, node.id, edit.text);

    case "intro":
      // The pairing rule: re-send the headline this box did not touch, or saving
      // an intro clears the headline above it.
      return node.kind === "welcome"
        ? setWelcomeCopy(graph, node.id, node.headline ?? "", edit.text)
        : refuse("Only the opening screen has an opening line.");

    case "route-option": {
      const target = defaultTargetOf(graph, node.id);
      if (!target) {
        return refuse(
          "This step leads nowhere yet, so there is nothing to send that answer to. Connect it first.",
        );
      }
      return addEdge(graph, node.id, target, edit.value);
    }

    case "connect":
      return addEdge(graph, node.id, edit.to, edit.answer);

    case "remove-node":
      return removeNode(graph, node.id);
  }
}

/**
 * What the selection should be after an edit LANDS. Only ever called on success:
 * a refused edit changes nothing, and the selection must stay exactly where it is
 * so the owner can read the refusal against the step it is about.
 *
 * WHY THIS IS NOT `onSelect(null)` IN THE RAIL, which is where it started. A
 * button that fired the edit AND cleared the selection in the same breath cleared
 * the REFUSAL with it (the builder clears refusals when the selection moves), so
 * "this step leads nowhere yet, connect it first" never reached the screen and the
 * click read as doing nothing - the exact failure this whole layer exists to stop.
 *
 * FOUR EDITS MOVE THE GROUND UNDER A SELECTION, and the answer differs by what the
 * owner was doing:
 *
 *   ADDING A SCREEN LANDS ON IT. Both insertion edits splice a wire in two, so an
 *   EDGE selection would silently come to mean a different connection - but the
 *   honest replacement is not "nothing", it is the screen that was just made. That
 *   is the whole point of the one-click + on the strip: the new screen is selected,
 *   its rail is open, and the question it picked is one control away from being
 *   changed. The id is planScreenInsertion's, resolved on the graph as it stood -
 *   the same call insertQuestionOnEdge makes a moment later, so the two cannot
 *   disagree about what the new step is called.
 *
 *   REMOVING CLEARS IT. A removed step is gone; a removed wire shifts every index
 *   after it. There is nothing to land on.
 *
 *   REORDERING CLEARS AN EDGE SELECTION ONLY. moveEdge swaps two entries, so the
 *   index a CONNECTION was selected by now addresses its neighbour. A step's
 *   selection is untouched by it - and a step is what is selected when the branch
 *   rows fire this, which is the only place they can be fired from.
 *
 * THE PRE-EDIT GRAPH is the argument on purpose: this is called with the graph the
 * edit was computed against, never the result. Handing it the result would make the
 * planner resolve a name against a funnel that already holds the step it is naming.
 */
export function selectionAfterEdit(
  selection: FlowSelection | null,
  edit: InspectorEdit,
  graph: FlowGraph,
): FlowSelection | null {
  switch (edit.kind) {
    case "add-screen": {
      const plan = planScreenInsertion(graph, edit.nodeId, edit.questionId);
      return plan.ok ? { kind: "node", id: plan.nodeId } : null;
    }
    case "insert-question":
      return { kind: "node", id: nextNodeId(graph, edit.questionId) };
    case "remove-node":
    case "remove-edge":
      return null;
    case "move-edge":
      return selection?.kind === "edge" ? null : selection;
    default:
      return selection;
  }
}

// ---------------------------------------------------------------------------
// WHERE A FAILURE BELONGS IN THE RAIL.
// ---------------------------------------------------------------------------

/** The parts of the rail a failure can be shown against. */
export type InspectorField =
  /** The head of the rail: true of the whole step, not of one control. */
  | "step"
  /** The question picker. */
  | "question"
  /** A lead-in line. */
  | "transition"
  | "headline"
  | "intro"
  /** The list of where each answer goes. */
  | "branches"
  /** A connection's own answer picker... */
  | "answer"
  /** ...and its destination. */
  | "target";

export interface FieldIssue {
  field: InspectorField;
  rule: number;
  code: string;
  message: string;
}

/**
 * A failure's `where` for an edge, EXACTLY as flow-validate.ts writes it
 * (edgeLabel, :91). Rebuilt and compared whole rather than parsed, so a change to
 * that format makes this mapping return nothing - the banner still shows every
 * failure - instead of attributing a message to the wrong branch. The round-trip
 * is pinned in flow-inspect.test.ts against real validateFlow output, so the
 * drift is caught rather than merely survived.
 */
export function edgeWhere(edge: FlowEdge): string {
  return `edge ${edge.from} -> ${edge.to} (${edge.answer === null ? "default" : edge.answer})`;
}

/**
 * Which control a node-scoped failure sits under. Anything absent falls back to
 * "step": a new rule is shown at the head of the rail rather than swallowed.
 */
const NODE_FIELD_BY_CODE: Readonly<Record<string, InspectorField>> = {
  // rule 2 / 8 / 9 - about the QUESTION this step asks.
  unknown_question: "question",
  question_repeated: "question",
  applies_to_unanswered: "question",
  applies_to_violation: "question",
  // rule 3 / 7 - about where its answers go.
  option_uncovered: "branches",
  no_outgoing: "branches",
  contact_has_no_route: "branches",
  band_uncovered: "branches",
  outcome_not_terminal: "branches",
  terminal_not_outcome: "branches",
};

/** Which control an edge-scoped failure sits under, in a CONNECTION's rail. */
const EDGE_FIELD_BY_CODE: Readonly<Record<string, InspectorField>> = {
  duplicate_edge_answer: "answer",
  edge_answer_not_an_option: "answer",
  edge_band_invalid: "answer",
  edge_answer_on_welcome: "answer",
  cycle: "target",
};

function issue(field: InspectorField, f: FlowValidationFailure): FieldIssue {
  return { field, rule: f.rule, code: f.code, message: f.message };
}

/**
 * Everything validateFlow said about this step, placed against the control that
 * can fix it.
 *
 * INCLUDING WHAT IT SAID ABOUT THE STEP'S OWN WIRES. "option X has no edge" names
 * the node; "this edge loops back" names the edge. Both are answered by the same
 * branch list, and an owner reading a step's rail should see both there.
 */
export function nodeIssues(
  graph: FlowGraph,
  failures: readonly FlowValidationFailure[],
  nodeId: string,
): FieldIssue[] {
  const own = new Set(outgoingEdges(graph, nodeId).map(({ edge }) => edgeWhere(edge)));
  const out: FieldIssue[] = [];
  for (const f of failures) {
    // `node "id".blocks[0].quote` and friends: named ON this step, no control of
    // their own in the rail yet, so they surface at its head.
    if (f.where === nodeId || f.where.startsWith(`node "${nodeId}".`)) {
      out.push(issue(NODE_FIELD_BY_CODE[f.code] ?? "step", f));
    } else if (own.has(f.where)) {
      out.push(issue("branches", f));
    }
  }
  return out;
}

/**
 * Everything validateFlow said about this connection.
 *
 * Two identical wires (same from, same to, same answer) share a `where`, so each
 * row shows both messages. That is the truth: rule 3 reports them as a pair, and
 * either one is the one to remove.
 */
export function edgeIssues(
  graph: FlowGraph,
  failures: readonly FlowValidationFailure[],
  index: number,
): FieldIssue[] {
  const edge = graph.edges[index];
  if (!edge) return [];
  const where = edgeWhere(edge);
  return failures
    .filter((f) => f.where === where)
    .map((f) => issue(EDGE_FIELD_BY_CODE[f.code] ?? "step", f));
}

/** The issues on one control, in the order validateFlow reported them. */
export function issuesFor(issues: readonly FieldIssue[], field: InspectorField): FieldIssue[] {
  return issues.filter((i) => i.field === field);
}
