// "WRITE THIS FOR ME" - ONE LINE OF COPY, FOR THE ONE BOX THE OWNER IS IN.
//
// The other half of the AI-writer lane. flow-generate.ts drafts a whole funnel
// from a goal; this drafts a SINGLE FIELD from the funnel that already exists -
// the headline on the opening screen, the lead-in above a question, the answer to
// one faq question. The owner keeps everything they wrote; the model is asked for
// the one line they are stuck on.
//
// THE PIPELINE, deliberately SHORTER than flow-generate's, and the difference is
// the point:
//
//   1. resolve  -> which field is this, what is its cap, and may it be written at
//                  all (see the two refusals below)
//   2. ask      -> refuse a truncated reply BEFORE parsing, exactly as the funnel
//                  writer does: half a sentence is not a line of copy
//   3. parse    -> one line, house-cleaned, DROPPED rather than truncated when it
//                  overruns its field's cap
//   4. scan     -> flow-copy.ts, the same gate the save runs. A hit costs ONE
//                  regeneration and then the whole thing gives up
//   5. give up  -> `source: "none"` and a sentence for the owner. NEVER dirty text
//                  with a warning attached
//
// WHY THERE IS NO REPAIR PASS AND NO FALLBACK. A graph has STRUCTURE to repair
// towards, and a hand-written template to fall back on; a line of copy has
// neither. There is nothing to say to the model about an unreadable one-liner
// that the first prompt did not already say, and no "template headline" that is
// better than the words the owner already has in the box. So the honest floor is
// "we could not write that one, please type it" - which leaves the field exactly
// as it was.
//
// WHY A NON-COMPLIANT LINE IS NEVER RETURNED WITH A WARNING. The funnel writer
// can strip a bad line and keep the funnel, because the funnel is the deliverable
// and the line is optional. Here the line IS the deliverable, so "returned with a
// warning" means the rail is holding wording a patient must not see, in a box the
// owner may never re-read before pressing save. Refuse, do not warn.
//
// TWO THINGS A MODEL IS NEVER ASKED TO WRITE, refused HERE rather than in the
// rail, because a rule that lives in a `disabled` attribute is a rule that
// disappears the next time the button is restyled (flow-inspect.ts:204-208 makes
// the same argument about the same charter clause):
//
//   A TESTIMONIAL, in any of its parts. The charter is absolute - "AI never
//   fabricates testimonials, reviews or outcome claims; a testimonial block
//   renders only practice-entered quotes". Polishing the grammar of a quote the
//   practice genuinely holds is charter-legal but is a DIFFERENT operation, with
//   a different prompt and a different failure mode, and it is not this one.
//
//   THE PRACTICE'S NAME on a trust strip. It is a fact, not a line of copy, and
//   the failure mode of inventing one is the same class as inventing a quote.
//
// PURE APART FROM THE INJECTED callModel, so the whole pipeline runs in the node
// test env with no network and no SDK (flow-assist.test.ts). The route
// (api/smile-assessment/flow-copy-assist) owns the model, its budget and its
// guards; this file owns the thinking.

import {
  FLOW_LIMITS,
  blockCopyFields,
  blocksOf,
  nodeMap,
  type FlowBlock,
  type FlowBlockKind,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { BLOCK_LABELS, describeEdge, describeNode } from "./flow-edit";
import { scanFlowCopyText, type FlowCopyHit } from "./flow-copy";
import type { FlowSelection, InspectorEdit } from "./flow-inspect";
import { questionById } from "./quiz";

// ---------------------------------------------------------------------------
// What can be pointed at.
// ---------------------------------------------------------------------------

/** Every copy field a "write this for me" button may sit beside. */
export const ASSIST_FIELDS = [
  "headline",
  "intro",
  "transition",
  "edge-transition",
  "block-text",
] as const;

export type AssistField = (typeof ASSIST_FIELDS)[number];

/**
 * WHICH BOX THE OWNER PRESSED, as a request rather than as an edit.
 *
 * It is NOT an `InspectorEdit`: that union is applied by a pure, synchronous
 * function and this cannot be answered without a model. So the rail emits one of
 * these upward, the builder does the asking, and the ANSWER comes back down the
 * existing edit intents (assistEditFor) - which is what keeps every trim, every
 * validation and every refusal in the landing path unchanged.
 *
 * `index` is the EDGE index for an edge lead-in and the BLOCK index for a block
 * line; `blockField` is a blockCopyFields path (`chips[0]`, `items[1].a`).
 */
export interface AssistTarget {
  nodeId: string;
  field: AssistField;
  index?: number;
  blockField?: string;
  /**
   * WHAT WAS IN THAT BOX WHEN THE BUTTON WAS PRESSED (assistFingerprint), so the
   * line that comes back can be checked against the thing it was written for
   * rather than merely against a shape that still fits.
   *
   * `index` + `blockField` is a POSITION, not an identity. A block moved up while
   * the model was writing, an faq item deleted from above the one being asked
   * about - each leaves a different piece of copy sitting at the same address,
   * with the same field name, so the resolver says yes and the line lands on the
   * wrong words. Silently, and with the save reporting success.
   *
   * Set by whoever does the asking (flow-builder.tsx stamps it at press time). It
   * travels no further than the browser: the route builds its own target from the
   * body and has no use for it, because the server never lands anything.
   */
  at?: string;
}

/**
 * One target, as a string. The rail uses it to know which of its buttons is the
 * one currently waiting; the builder uses it to know one is in flight at all.
 *
 * IT LIVES HERE rather than in the component because "are these two buttons the
 * same button" is a rule, and a rail that computed it itself would spin the wrong
 * button the first time two blocks on one screen had a field of the same name.
 */
export function assistTargetKey(target: AssistTarget): string {
  return [target.nodeId, target.field, target.index ?? "", target.blockField ?? ""].join("|");
}

/** Read a target off a request body. null when it is not one. */
export function parseAssistTarget(raw: unknown): AssistTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const nodeId = typeof r.nodeId === "string" ? r.nodeId.trim() : "";
  if (!nodeId || nodeId.length > FLOW_LIMITS.nodeId) return null;
  const field = ASSIST_FIELDS.find((f) => f === r.field);
  if (!field) return null;
  const target: AssistTarget = { nodeId, field };
  if (typeof r.index === "number" && Number.isInteger(r.index) && r.index >= 0) {
    target.index = r.index;
  }
  if (typeof r.blockField === "string" && r.blockField.trim() !== "") {
    target.blockField = r.blockField.trim().slice(0, FLOW_LIMITS.nodeId);
  }
  return target;
}

// ---------------------------------------------------------------------------
// The two refusals, and the resolution.
// ---------------------------------------------------------------------------

/**
 * Why this block line may not be written by a model, or null when it may.
 *
 * BOTH SENTENCES ARE THE ONES THE BUILDER ALREADY SAYS about the same rule
 * (flow-inspect.ts blockToAdd), on purpose: an owner meets one wording for "a
 * quote is the practice's own", whether they tried to ADD a testimonial without
 * one or tried to have one written.
 */
export function assistBlockFieldRefusal(blockKind: FlowBlockKind, field: string): string | null {
  if (blockKind === "testimonial") {
    return "A testimonial is a quote the practice already holds and the name of whoever gave it. Type both, in their words: nothing here writes one for you.";
  }
  if (blockKind === "trust-strip" && field === "practiceName") {
    return "A trust strip carries the practice’s own name, which is a fact rather than a line of copy. Type it in: nothing here invents one.";
  }
  return null;
}

/** May a model be asked for this block line? The rail draws its button off this. */
export function isAssistableBlockField(blockKind: FlowBlockKind, field: string): boolean {
  return assistBlockFieldRefusal(blockKind, field) === null;
}

export interface ResolvedAssistTarget {
  node: FlowNode;
  /** What is being written, in the owner's words. Goes into the prompt. */
  label: string;
  /** The field's own cap, in characters. A longer line is dropped, not cut. */
  max: number;
  /** What is in the box now. Empty when there is nothing. */
  current: string;
  block?: FlowBlock;
  edge?: FlowEdge;
}

export type AssistResolution =
  | { ok: true; target: ResolvedAssistTarget }
  | { ok: false; reason: string };

const no = (reason: string): AssistResolution => ({ ok: false, reason });

/**
 * WHICH FIELD IS THIS, AND MAY IT BE WRITTEN - the one place both questions are
 * answered, so the rail, the route and the pipeline cannot come to three
 * different views of the same button.
 *
 * It is deliberately strict about the SHAPE as well: a headline target naming a
 * question screen, an edge index that belongs to another step, a block field the
 * block does not carry - each is refused in words rather than quietly producing a
 * prompt about nothing.
 */
export function resolveAssistTarget(graph: FlowGraph, target: AssistTarget): AssistResolution {
  const node = nodeMap(graph).get(target.nodeId);
  if (!node) return no("That screen is no longer there.");

  switch (target.field) {
    case "headline": {
      if (node.kind !== "welcome" && node.kind !== "outcome") {
        return no("Only the opening screen and the result screens have a headline.");
      }
      return {
        ok: true,
        target: {
          node,
          label: node.kind === "welcome" ? "the opening headline" : "the result headline",
          max: FLOW_LIMITS.headline,
          current: node.headline ?? "",
        },
      };
    }

    case "intro": {
      if (node.kind !== "welcome") return no("Only the opening screen has an opening line.");
      return {
        ok: true,
        target: { node, label: "the opening line", max: FLOW_LIMITS.intro, current: node.intro ?? "" },
      };
    }

    case "transition": {
      if (node.kind !== "question") return no("Only a question screen has a lead-in line.");
      return {
        ok: true,
        target: {
          node,
          label: "the lead-in line above this question",
          max: FLOW_LIMITS.transition,
          current: node.transition ?? "",
        },
      };
    }

    case "edge-transition": {
      const index = target.index;
      const edge = typeof index === "number" ? graph.edges[index] : undefined;
      // The edge must leave THIS step. An index alone would let a stale button
      // write a lead-in onto whichever wire has since taken that position.
      if (!edge || edge.from !== node.id) return no("That connection is no longer there.");
      return {
        ok: true,
        target: {
          node,
          edge,
          label: "the lead-in line shown after this answer",
          max: FLOW_LIMITS.transition,
          current: edge.transition ?? "",
        },
      };
    }

    case "block-text": {
      const index = target.index;
      const field = target.blockField;
      if (typeof index !== "number" || typeof field !== "string") {
        return no("That line is no longer on this screen.");
      }
      const block = blocksOf(node)[index];
      if (!block) return no("That block is no longer on this screen.");
      const spec = blockCopyFields(block).find((f) => f.field === field);
      if (!spec) return no(`“${field}” is not something a ${BLOCK_LABELS[block.kind]} block carries.`);
      const refusal = assistBlockFieldRefusal(block.kind, field);
      if (refusal) return no(refusal);
      return {
        ok: true,
        target: {
          node,
          block,
          label: `${blockLineLabel(block.kind, field)} on this screen`,
          max: spec.max,
          current: spec.text,
        },
      };
    }
  }
}

/**
 * What one line of a block is, in a sentence a model can act on.
 *
 * A SECOND LABELLER, and knowingly so: the rail's BLOCK_FIELD_LABELS name the box
 * for someone looking at it ("Chip 2"), and this names the job for someone writing
 * it ("short reassurance 2 in the trust strip"). Merging them would make one of
 * the two read badly, and the two never have to agree on anything for either to be
 * correct.
 */
function blockLineLabel(kind: FlowBlockKind, field: string): string {
  if (field === "alt") return "the description of the picture";
  if (kind === "booking" && field === "headline") return "the words on the booking button";
  if (kind === "booking" && field === "blurb") return "the line under the booking button";
  const chip = /^chips\[(\d+)\]$/.exec(field);
  if (chip) return `short reassurance ${Number(chip[1]) + 1} in the trust strip`;
  const faq = /^items\[(\d+)\]\.([qa])$/.exec(field);
  if (faq) {
    const at = Number(faq[1]) + 1;
    return faq[2] === "q" ? `question ${at} in the FAQ` : `the answer to question ${at} in the FAQ`;
  }
  return `the “${field}” line of the ${BLOCK_LABELS[kind]} block`;
}

// ---------------------------------------------------------------------------
// The prompt.
// ---------------------------------------------------------------------------

export interface AssistContext {
  /** The PRACTICE's name, never the campaign's internal source label. */
  practiceName?: string | null;
}

export interface AssistPrompt {
  system: string;
  user: string;
}

/**
 * The whole brief for one line: the rules, then where the line appears in the
 * funnel the owner has already built.
 *
 * null when the target cannot be written - so a refused target has no prompt at
 * all rather than a prompt nobody may send.
 */
export function buildAssistPrompt(
  target: AssistTarget,
  graph: FlowGraph,
  context?: AssistContext,
): AssistPrompt | null {
  const resolved = resolveAssistTarget(graph, target);
  return resolved.ok ? promptFor(graph, resolved.target, context) : null;
}

/** The prompt for an ALREADY RESOLVED target, so the pipeline resolves once. */
function promptFor(
  graph: FlowGraph,
  t: ResolvedAssistTarget,
  context?: AssistContext,
): AssistPrompt {
  const system = [
    "You write one line of copy for a smile-assessment funnel on a UK dental practice's website.",
    `You are writing ${t.label}, and nothing else.`,
    "",
    "HARD RULES. A line that breaks one of these is thrown away:",
    `1. Reply with the line ITSELF and nothing else: no quotation marks, no explanation, no options, no JSON, no code fence.`,
    `2. At most ${t.max} characters. Shorter is better.`,
    "3. One line. Warm, plain British English, written to the patient as “you”.",
    "4. No dashes of any kind.",
    "5. Never give clinical advice and never say whether a treatment is suitable: a clinician decides that, always.",
    "6. Never mention NHS or private care, plans, schemes, bands or funding of any kind.",
    "7. Never mention prices, discounts, finance, guarantees, reviews, ratings or awards, and never claim to be the best, the only or the leading anything.",
    "8. Never invent a patient's words, a result, a timescale you were not given, or a number of any kind. Nothing you write may be a claim about an outcome.",
  ].join("\n");

  const practice = (context?.practiceName ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const user = [
    `Practice: ${practice || "not specified"}`,
    ...whereItAppears(graph, t),
    "",
    t.current
      ? `The line as it stands: ${t.current}`
      : "There is nothing in that box yet.",
    "",
    `Write ${t.label} now.`,
  ].join("\n");

  return { system, user };
}

/** The funnel around the box: what this screen is, and what surrounds it. */
function whereItAppears(graph: FlowGraph, t: ResolvedAssistTarget): string[] {
  const card = describeNode(t.node);
  const out: string[] = [`The screen: ${card.eyebrow} - ${card.title}`];

  if (t.node.kind === "question") {
    const q = questionById(t.node.questionId);
    if (q) out.push(`It asks: ${q.prompt}`, `The patient's choices: ${q.options.map((o) => o.label).join("; ")}`);
  }
  if (t.node.kind === "outcome") {
    // What the result screen is FOR, in the builder's own words: how ready the
    // enquiry looked, never anything about the treatment.
    out.push(`What happens next on it: ${card.options[0] ?? "the practice gets in touch"}`);
    out.push(
      "This screen is about how ready the enquiry is, never about what treatment would suit: do not say or imply that any treatment is right for them.",
    );
  }
  if (t.edge) {
    const answer = describeEdge(t.edge, t.node);
    const to = nodeMap(graph).get(t.edge.to);
    out.push(
      `It is shown to a patient who answered: ${answer ?? "anything else"}`,
      `They are arriving at: ${to ? describeNode(to).title : t.edge.to}`,
    );
  }
  if (t.block) {
    out.push(`It is one line of a ${BLOCK_LABELS[t.block.kind]} section on that screen.`);
  }

  // What the patient has already been through, so a lead-in does not greet
  // somebody who is five questions in as if they had just arrived.
  const step = stepNumber(graph, t.node.id);
  if (step !== null) out.push(`Questions already answered before this screen: ${step}`);

  return out;
}

/**
 * How many QUESTIONS a patient has answered by the time they reach this screen,
 * counted along the default route from the entry. null when the screen is not on
 * it (a branch-only step), because a wrong number is worse than none.
 */
function stepNumber(graph: FlowGraph, nodeId: string): number | null {
  const byId = nodeMap(graph);
  let at: string | undefined = graph.entry;
  let asked = 0;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    if (at === nodeId) return asked;
    seen.add(at);
    const node = byId.get(at);
    if (node?.kind === "question") asked += 1;
    const next = graph.edges.find((e) => e.from === at && e.answer === null) ?? graph.edges.find((e) => e.from === at);
    at = next?.to;
  }
  return null;
}

/** The one regeneration: the offending phrases, quoted back. */
export function buildAssistRetryUser(previousUser: string, previousLine: string, hits: FlowCopyHit[]): string {
  return [
    previousUser,
    "",
    "You already tried this line, and it cannot be put in front of a patient:",
    previousLine,
    "",
    "What was wrong with it:",
    describeAssistHits(hits),
    "",
    "Write a different line for the same field, saying none of that.",
  ].join("\n");
}

/** One line per hit. Its own formatter: the model is told the phrase, not a path. */
export function describeAssistHits(hits: FlowCopyHit[]): string {
  return hits.map((h) => `- “${h.matched}” is not allowed (${h.category})`).join("\n");
}

// ---------------------------------------------------------------------------
// Reading the reply.
// ---------------------------------------------------------------------------

/**
 * The model's line, house-cleaned, or null when there is not one.
 *
 * DROPPED, NOT TRUNCATED, over the cap - the same call flow-generate.ts makes
 * about a transition, for the same reason: half a sentence in front of a patient
 * reads worse than the box the owner already had.
 *
 * Only the FIRST non-empty line is taken. A model that ignores rule 1 and offers
 * three options gives us its best one first; taking all three would put a numbered
 * list in a headline box.
 */
export function parseAssistReply(text: string, max: number): string | null {
  if (typeof text !== "string") return null;
  // A code fence around a single line is the commonest way rule 1 is broken.
  const unfenced = text.replace(/```[a-z]*\n?/gi, "");
  const first = unfenced.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (!first) return null;

  const line = first
    // The spaces AROUND the dash go with it (flow-generate.ts:305): replacing the
    // character alone turns "Great — when suits you?" into "Great , when suits
    // you?", which is correct on the ban and wrong in front of a patient.
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    // Wrapping quotes, straight or curly: the model quoting its own answer is not
    // the owner asking for a quotation mark in their headline.
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .trim()
    .replace(/,+$/, "")
    .trim();

  if (!line || line.length > max) return null;
  return line;
}

/**
 * How many output tokens one field is worth.
 *
 * SIZED TO THE FIELD, not to the funnel writer's 3000: the longest field here is
 * 240 characters, and a cap an order of magnitude above what can possibly be used
 * is a cap that only pays for a model that ignored rule 1. The floor keeps a short
 * field from being cut off mid-word by its own budget; the ceiling is the whole
 * point.
 */
export function assistMaxTokens(maxChars: number): number {
  return Math.min(300, Math.max(80, Math.ceil(maxChars / 3) + 40));
}

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

export interface AssistModelReply {
  text: string;
  stopReason?: string | null;
}

/** One system+user round trip, with the output cap this field is worth. */
export type CallAssistModel = (
  system: string,
  user: string,
  maxTokens: number,
) => Promise<AssistModelReply>;

/** Why no line came back. null when one did. */
export type AssistOutcome = "refused" | "truncated" | "unreadable" | "non-compliant" | "model-error";

export interface AssistResult {
  /** The line, ONLY when it passed the scan. Never dirty text. */
  text: string | null;
  source: "model" | "none";
  reason: AssistOutcome | null;
  /** One sentence for the owner. null when a line came back. */
  message: string | null;
}

export interface AssistCopyInput {
  target: AssistTarget;
  graph: FlowGraph;
  context?: AssistContext;
  callModel: CallAssistModel;
}

const MESSAGES: Readonly<Record<Exclude<AssistOutcome, "refused">, string>> = {
  truncated:
    "That line came back half written, so nothing was changed. Ask again, or type it yourself.",
  unreadable:
    "Nothing usable came back, so nothing was changed. Ask again, or type it yourself.",
  "non-compliant":
    "Twice over, the wording that came back is not something a patient may be shown, so nothing was changed. Please write this one yourself.",
  "model-error":
    "The writer could not be reached, so nothing was changed. Your funnel is exactly as it was.",
};

function none(reason: AssistOutcome, message: string): AssistResult {
  return { text: null, source: "none", reason, message };
}

/**
 * ONE FIELD, WRITTEN OR NOT WRITTEN. Never throws, never returns wording that
 * failed the scan, and never changes anything by itself: the caller lands the text
 * through the ordinary edit intents, which is where the trims and the validation
 * live.
 */
export async function assistCopy(input: AssistCopyInput): Promise<AssistResult> {
  const { target, graph, context, callModel } = input;

  // ENFORCEMENT POINT ONE OF TWO. The rail draws no button on a testimonial; this
  // refuses the target even when something else asks. Two code paths, two checks -
  // the rail is a keyboard, and a keyboard is not a gate.
  const resolved = resolveAssistTarget(graph, target);
  if (!resolved.ok) return none("refused", resolved.reason);

  const prompt = promptFor(graph, resolved.target, context);
  const maxTokens = assistMaxTokens(resolved.target.max);

  try {
    const first = await callModel(prompt.system, prompt.user, maxTokens);
    // Truncated: refuse BEFORE parsing, exactly as the funnel writer does. There
    // is nothing in half a line worth keeping and nothing worth quoting back.
    if (first.stopReason === "max_tokens") return none("truncated", MESSAGES.truncated);

    const line = parseAssistReply(first.text, resolved.target.max);
    if (!line) return none("unreadable", MESSAGES.unreadable);

    // THE SAME SCANNER THE SAVE RUNS (flow-copy.ts), so a line written here is
    // held to exactly the rules a hand-typed one is, and there is no second list
    // to drift. `where` is irrelevant to the verdict, as isCleanLine says.
    const hits = scanFlowCopyText("", line);
    if (hits.length === 0) return { text: line, source: "model", reason: null, message: null };

    // ONE regeneration, quoting the offending phrases. Then it gives up: a second
    // dirty line is a model that will not write this field, and spending a third
    // call to find that out buys nothing.
    const retry = await callModel(
      prompt.system,
      buildAssistRetryUser(prompt.user, line, hits),
      maxTokens,
    );
    if (retry.stopReason === "max_tokens") return none("truncated", MESSAGES.truncated);

    const second = parseAssistReply(retry.text, resolved.target.max);
    if (!second) return none("unreadable", MESSAGES.unreadable);
    if (scanFlowCopyText("", second).length > 0) {
      return none("non-compliant", MESSAGES["non-compliant"]);
    }
    return { text: second, source: "model", reason: null, message: null };
  } catch {
    // A model or network error is a line that did not arrive, by another name.
    return none("model-error", MESSAGES["model-error"]);
  }
}

// ---------------------------------------------------------------------------
// Landing the line.
// ---------------------------------------------------------------------------

/**
 * The written line as an ORDINARY EDIT INTENT - the whole reason this feature adds
 * no landing path of its own.
 *
 * What comes back from the model goes through applyInspectorEdit onto
 * setWelcomeCopy / setOutcomeHeadline / setQuestionTransition / setEdgeTransition
 * / setBlockText, which trim it to FLOW_LIMITS, refuse it where it does not
 * belong, and leave it to be scanned again by the save. An AI-written line is
 * therefore held to every rule a typed one is, with no code in the middle that
 * knows it came from a model.
 *
 * null when the target carries no index it needs - a shape the resolver has
 * already refused, restated here so this function is total on its own.
 */
export function assistEditFor(target: AssistTarget, text: string): InspectorEdit | null {
  switch (target.field) {
    case "headline":
      return { kind: "headline", text };
    case "intro":
      return { kind: "intro", text };
    case "transition":
      return { kind: "transition", text };
    case "edge-transition":
      return typeof target.index === "number"
        ? { kind: "edge-transition", index: target.index, text }
        : null;
    case "block-text":
      return typeof target.index === "number" && typeof target.blockField === "string"
        ? { kind: "block-text", index: target.index, field: target.blockField, text }
        : null;
  }
}

/**
 * The funnel is EDITABLE while the line is being written, and that is the hazard
 * this answers.
 *
 * A round trip takes a second or two, and in that second the owner can type in
 * another box, delete a block or pick another screen. The node-scoped intents
 * (`headline`, `intro`, `transition`) act on WHATEVER IS SELECTED, so a headline
 * written for the opening screen would land on a result screen if the owner had
 * clicked away - silently, with the save reporting success. So the target is
 * re-checked against the funnel and the selection AS THEY ARE WHEN THE LINE
 * ARRIVES, and a line with nowhere to go is reported rather than placed.
 *
 * The edge intent addresses itself by index and is valid from either selection
 * (flow-inspect.ts), so only the wire has to still be there - which the resolver
 * checks, including that it still leaves the step the button was pressed on.
 */
export function canLandAssist(
  graph: FlowGraph,
  selection: FlowSelection | null,
  target: AssistTarget,
): boolean {
  if (!resolveAssistTarget(graph, target).ok) return false;
  // IDENTITY, NOT SHAPE. The resolver above answers "is there still a box of this
  // description here", which is a different question from "is it the same box".
  // See AssistTarget.at and assistFingerprint: without this line a block reordered
  // beside the button, or an faq item deleted from above the one being written,
  // hands the model's sentence to whatever copy inherited the address.
  if (typeof target.at === "string" && assistFingerprint(graph, target) !== target.at) return false;
  if (target.field === "edge-transition") return true;
  return selection?.kind === "node" && selection.id === target.nodeId;
}

/**
 * THE TARGETED COPY AS IT STANDS, as one comparable string. null when the target
 * does not resolve at all.
 *
 * It fingerprints the WHOLE of the thing being written into, not just the field:
 * a block's kind and every one of its lines, an edge's two ends and its answer.
 * That is deliberate - a reorder swaps two blocks without changing either one, so
 * a fingerprint of the target field alone would match straight through the very
 * move it exists to catch, whenever the two blocks share a field name.
 *
 * IT INCLUDES THE FIELD'S OWN CURRENT TEXT, so an owner who gave up waiting and
 * typed something is not overwritten by the answer to a question they stopped
 * asking. Refusing costs one more press; landing costs their words.
 *
 * NOT A HASH. It is compared for equality and nothing else, it never leaves the
 * browser, and a readable string is a readable test failure.
 */
export function assistFingerprint(graph: FlowGraph, target: AssistTarget): string | null {
  const resolved = resolveAssistTarget(graph, target);
  if (!resolved.ok) return null;
  const t = resolved.target;

  const parts: unknown[] = [t.node.id, t.node.kind];
  // The two node fields that are not copy but do decide what the copy is ABOUT: a
  // question swapped underneath a lead-in, or a result screen's band changed, both
  // make the written line answer the wrong thing.
  if (t.node.kind === "question") parts.push(t.node.questionId);
  if (t.node.kind === "outcome") parts.push(t.node.band);
  if (t.edge) parts.push(t.edge.from, t.edge.to, t.edge.answer ?? null, t.edge.transition ?? "");
  if (t.block) {
    parts.push(t.block.kind, blockCopyFields(t.block).map((f) => [f.field, f.text]));
  } else {
    parts.push(t.current);
  }
  return JSON.stringify(parts);
}

/** What the owner is told when the ground moved under a line that was being written. */
export const ASSIST_TARGET_MOVED =
  "That line was written for a different box, and the funnel has moved on since. Nothing was changed: pick that screen again and ask once more.";
