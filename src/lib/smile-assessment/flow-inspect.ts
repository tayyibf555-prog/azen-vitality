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

import {
  FLOW_LIMITS,
  isFlowBlockKind,
  nodeMap,
  type FlowBlock,
  type FlowBlockKind,
  type FlowEdge,
  type FlowGraph,
} from "./flow";
import {
  addBlock,
  addBlockChip,
  addBlockFaqItem,
  addEdge,
  defaultTargetOf,
  insertQuestionOnEdge,
  moveBlock,
  moveEdge,
  nextNodeId,
  outgoingEdges,
  planScreenInsertion,
  removeBlock,
  removeBlockItem,
  removeEdge,
  removeNode,
  removeOptionImage,
  setBlockImage,
  setBlockText,
  setEdgeAnswer,
  setEdgeTarget,
  setEdgeTransition,
  setNodeQuestion,
  setOptionImage,
  setOutcomeHeadline,
  setQuestionTransition,
  setWelcomeCopy,
  starterBlock,
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
  | { kind: "insert-question"; index: number; questionId: string }
  // --- A2's furniture, on the welcome and result screens -------------------
  /**
   * ADD A CONTENT BLOCK. It carries the WORDS for the kinds that have none of
   * their own, rather than a finished block, because "what may a new block say"
   * is the rule this whole lane turns on: `starterBlock` has no answer for a
   * testimonial (a quote is the practice's, never ours) and none for a trust
   * strip without a practice name. Resolving that here keeps the rail a form and
   * leaves the judgement in a module vitest can reach.
   */
  | {
      kind: "add-block";
      blockKind: FlowBlockKind;
      /** Whose name goes on a trust strip. */
      practiceName?: string;
      /** A testimonial's own words, and who said them. Required for that kind. */
      quote?: string;
      attribution?: string;
    }
  | { kind: "remove-block"; index: number }
  /** Move a block up or down the screen: authored order is render order. */
  | { kind: "move-block"; index: number; delta: number }
  /** One authored line of a block, by its blockCopyFields path (flow.ts:187). */
  | { kind: "block-text"; index: number; field: string; text: string }
  /** A picture block's picture, as a manifest key. Never a path, never a URL. */
  | { kind: "block-image"; index: number; image: string }
  | { kind: "block-chip-add"; index: number; text: string }
  | { kind: "block-faq-add"; index: number; q: string; a: string }
  /** Drop one chip or one faq pair from the block at `index`. */
  | { kind: "block-item-remove"; index: number; at: number }
  // --- A2's answer-card pictures, on a question screen ---------------------
  | { kind: "option-image"; value: string; image: string }
  | { kind: "option-image-remove"; value: string };

const refuse = (reason: string): FlowEditResult => ({ ok: false, reason });

/**
 * WHAT A NEW BLOCK IS MADE OF - the one place the charter's testimonial rule is
 * enforced rather than remembered.
 *
 * AI NEVER INVENTS A TESTIMONIAL, and neither does the builder. `starterBlock`
 * returns null for that kind on purpose (flow-edit.ts), so this is where an
 * "add a testimonial" click without the practice's own words becomes a refusal
 * in words instead of a block containing something nobody said. The rail can
 * only disable a button; a rule that lives in the disabled attribute is a rule
 * that vanishes the first time the button is re-styled.
 *
 * The trust strip is the same shape for a smaller reason: it carries the
 * practice's NAME, and this panel is not always given one.
 */
function blockToAdd(
  edit: Extract<InspectorEdit, { kind: "add-block" }>,
): { ok: true; block: FlowBlock } | { ok: false; reason: string } {
  if (!isFlowBlockKind(edit.blockKind)) {
    return { ok: false, reason: `“${String(edit.blockKind)}” is not a content block this build can render.` };
  }
  if (edit.blockKind === "testimonial") {
    const quote = (edit.quote ?? "").trim();
    const attribution = (edit.attribution ?? "").trim();
    if (!quote || !attribution) {
      return {
        ok: false,
        reason:
          "A testimonial is a quote the practice already holds and the name of whoever gave it. Type both, in their words: nothing here writes one for you.",
      };
    }
    return {
      ok: true,
      block: {
        kind: "testimonial",
        quote: quote.slice(0, FLOW_LIMITS.quote),
        attribution: attribution.slice(0, FLOW_LIMITS.attribution),
      },
    };
  }
  const starter = starterBlock(edit.blockKind, edit.practiceName);
  if (!starter) {
    return {
      ok: false,
      reason:
        edit.blockKind === "trust-strip"
          ? "A trust strip carries the practice’s name, and this funnel was not given one. Type it in, then add the block."
          : "There is no picture in the library for a screen yet.",
    };
  }
  return { ok: true, block: starter };
}

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

    case "add-block": {
      const built = blockToAdd(edit);
      return built.ok ? addBlock(graph, node.id, built.block) : refuse(built.reason);
    }

    case "remove-block":
      return removeBlock(graph, node.id, edit.index);

    case "move-block":
      return moveBlock(graph, node.id, edit.index, edit.delta);

    case "block-text":
      return setBlockText(graph, node.id, edit.index, edit.field, edit.text);

    case "block-image":
      return setBlockImage(graph, node.id, edit.index, edit.image);

    case "block-chip-add":
      return addBlockChip(graph, node.id, edit.index, edit.text);

    case "block-faq-add":
      return addBlockFaqItem(graph, node.id, edit.index, edit.q, edit.a);

    case "block-item-remove":
      return removeBlockItem(graph, node.id, edit.index, edit.at);

    case "option-image":
      return setOptionImage(graph, node.id, edit.value, edit.image);

    case "option-image-remove":
      return removeOptionImage(graph, node.id, edit.value);
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
  | "target"
  /** The content blocks on a welcome or result screen (rules 12 and 13). */
  | "blocks"
  /** The pictures on a question's answer cards (rules 13 and 14). */
  | "answer-images";

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
  // rule 12 / 14 - about the furniture, reported ON the step rather than on one
  // block ("this is a question step, blocks belong elsewhere").
  blocks_wrong_screen: "blocks",
  blocks_too_many: "blocks",
  option_images_wrong_screen: "answer-images",
  option_images_too_many: "answer-images",
  option_images_ragged: "answer-images",
};

/**
 * WHICH SECTION A FAILURE INSIDE A SCREEN BELONGS TO, decided by the PATH and not
 * by the code - because one code lands in two different sections.
 *
 * Rule 13's `image_unknown` and `image_wrong_slot` are reported for a BLOCK's
 * picture (`node "welcome".blocks[1].image`) and for an ANSWER CARD's picture
 * (`node "q-x".optionImages[0].image`) with the same code, and those are two
 * different lists in the rail. flow-validate writes the path, so the path is what
 * can tell them apart. Null means "not one of these sections", and the code map
 * above then has its say.
 */
function sectionFor(nodeId: string, where: string): InspectorField | null {
  if (where.startsWith(`node "${nodeId}".blocks[`)) return "blocks";
  if (where.startsWith(`node "${nodeId}".optionImages[`)) return "answer-images";
  return null;
}

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
    // `node "id".blocks[0].quote` and friends land on the SECTION they are in;
    // anything else named on this step falls to its own control, or to the head
    // of the rail when nothing claims it.
    if (f.where === nodeId || f.where.startsWith(`node "${nodeId}".`)) {
      out.push(issue(sectionFor(nodeId, f.where) ?? NODE_FIELD_BY_CODE[f.code] ?? "step", f));
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

/**
 * A failure inside ONE content block, with the line it is about.
 *
 * `field` is a blockCopyFields path (`quote`, `chips[0]`, `items[1].a`, `alt`) or
 * `image` for the picture reference; null means it is about the block as a whole
 * ("a faq needs 2 to 6 questions"). The rail prints the nulls at the head of the
 * block's card and the rest under the box that fixes them - the same doctrine as
 * nodeIssues, one level further in.
 */
export interface BlockIssue {
  field: string | null;
  rule: number;
  code: string;
  message: string;
}

/**
 * Everything validateFlow said about the block at `index` on this step.
 *
 * MATCHED WHOLE, NEVER BY PREFIX ALONE, and that is the part worth a test:
 * `node "welcome".blocks[1]` is a prefix of `node "welcome".blocks[10]`, so a
 * loose startsWith would print block 10's failures on block 1 the first time a
 * screen had eleven of them. The path must be the block's exactly, or the block's
 * followed by a dot.
 *
 * NO GRAPH ARGUMENT on purpose: `where` is a STRING flow-validate wrote, and
 * rebuilding it from the graph is the only way to read it. Taking the graph would
 * invite deriving the answer from the block instead, which is how the mapping and
 * the validator come to disagree.
 */
export function blockIssues(
  failures: readonly FlowValidationFailure[],
  nodeId: string,
  index: number,
): BlockIssue[] {
  const prefix = `node "${nodeId}".blocks[${index}]`;
  const out: BlockIssue[] = [];
  for (const f of failures) {
    if (f.where === prefix) {
      out.push({ field: null, rule: f.rule, code: f.code, message: f.message });
    } else if (f.where.startsWith(`${prefix}.`)) {
      out.push({
        field: f.where.slice(prefix.length + 1),
        rule: f.rule,
        code: f.code,
        message: f.message,
      });
    }
  }
  return out;
}

/** The issues on one line of a block, or - with null - on the block itself. */
export function blockIssuesFor(issues: readonly BlockIssue[], field: string | null): BlockIssue[] {
  return issues.filter((i) => i.field === field);
}
