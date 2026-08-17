// AI-GENERATED FUNNELS. The owner describes the campaign (goal, ideal patient,
// budget focus) and gets back a FlowGraph they can edit on the canvas - drawn
// ONLY from the question bank, validated by the same gate a hand-drawn funnel
// passes, and never rendered unvalidated.
//
// THE PIPELINE, copied deliberately from src/lib/landing/generate-run.ts (the
// house reference for "a model wrote something patient-facing"):
//
//   1. ask       -> refuse outright on a truncated reply (before parsing)
//   2. parse     -> assemble -> validateFlow (every failure at once)
//   3. pin       -> the contact step and the three result steps are OURS
//   4. scan      -> compliance lint of every authored line
//   5. on any failure, ONE repair pass quoting the whole failure list back
//   6. still bad -> the goal's hand-written template. Never an unvalidated graph.
//
// WHY THE MODEL CANNOT REMOVE CONTACT CAPTURE. It is not asked to. The reply
// carries QUESTION nodes and the edges between them; the welcome step, the
// contact step and the three result steps are taken from the goal's template and
// assembled around that reply server-side (see assembleFlowGraph), then pinned
// again after validation (pinScaffoldNodes) the way generate-run.ts:63-67 pins
// the owner-only fields. A funnel that captured no contact detail would produce
// leads with no way to contact them, which is the entire point of the product;
// it is not a thing a model gets a vote on.
//
// HOW IT WRITES THE SCREENS IT MAY NOT BUILD. A funnel is not only its questions:
// the opening screen and the three result screens carry the words a patient
// actually reads. The model writes those through a SECOND top-level reply key,
// `screens`, keyed by the id of a screen that already exists - never by emitting a
// welcome or an outcome node of its own. parseFlowReply therefore keeps its
// questions-only invariant untouched, the merge is a lookup rather than a diff,
// and "the model cannot add, remove or rename a screen" stays true by
// construction rather than by checking. What the merge keeps is COPY; identity,
// the band and the contact step are still forced from the template
// (pinScaffoldNodes, keepAuthoredCopy).
//
// TWO MODES, ONE ENGINE:
//
//   draft    - the funnel does not exist yet. The model supplies the questions,
//              the routing and the screen copy; the floor is the goal's template.
//   rewrite  - the funnel EXISTS and the owner likes its shape. Only the words are
//              asked for, only the words are read (applyRewrittenCopy), and the
//              floor is THE OWNER'S OWN GRAPH, unchanged. A rewrite that quietly
//              handed back a template would delete a funnel somebody built by
//              hand, which is the single worst thing this file could do; so the
//              rewrite path cannot reach templateResult at all, and
//              sameFlowStructure is asserted on what it returns.
//
// TWO BLOCK KINDS A MODEL MAY NEVER EMIT, in either mode: a testimonial and a
// booking block. Dropped by the PARSER rather than merely left out of the prompt,
// because a prompt is a request and a parser is a gate (WRITABLE_BLOCK_KINDS).
//
// WHY A MODEL/NETWORK ERROR AND AN UNUSABLE REPLY ARE THE SAME THING. Both mean
// "no usable funnel from the model", and both end on that mode's floor - the
// template for a draft, the owner's own funnel for a rewrite. There is no state
// in which this function returns something a patient should not see, no state in
// which it returns nothing, and no state in which a rewrite loses a funnel.
//
// PURE APART FROM THE INJECTED callModel, so the whole pipeline runs in the node
// test env with no network and no Anthropic SDK (flow-generate.test.ts). The
// route (api/smile-assessment/flow-generate) owns the model, its budget and its
// guards; this file owns the thinking.

import { QUIZ_QUESTIONS, Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "./quiz";
import { budgetLabel, goalLabel } from "./campaign";
import {
  FLOW_LIMITS,
  FLOW_SCHEMA_VERSION,
  blockCopyFields,
  blocksOf,
  cloneFlowBlock,
  withRequiredSchemaVersion,
  type FlowBlock,
  type FlowBlockKind,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind,
} from "./flow";
import { assessImage, assessImagesForSlot } from "@/lib/assess/image-library";
import {
  MAX_FLOW_QUESTION_DEPTH,
  describeFlowFailures,
  normaliseAndValidateFlow,
  validateFlow,
  type FlowValidationFailure,
} from "./flow-validate";
import { templateForGoal } from "./flow-templates";
import { describeFlowCopyHits, scanFlowCopy, scanFlowCopyText } from "./flow-copy";

// ---------------------------------------------------------------------------
// The model seam.
// ---------------------------------------------------------------------------

/**
 * One reply from the model. `stopReason` is carried because a reply cut off at
 * the token cap is UNUSABLE JSON, and parsing it half-written is how a mangled
 * funnel gets stored (practice-brain/classify.ts:94 fails closed for exactly this
 * reason). We refuse it before the parser ever sees it.
 */
export interface FlowModelReply {
  text: string;
  stopReason?: string | null;
}

/** A single system+user round trip. Injected, so this module needs no SDK. */
export type CallFlowModel = (system: string, user: string) => Promise<FlowModelReply>;

/**
 * Where the returned graph came from. Surfaced to the owner by the builder UI.
 *
 * `unchanged` is the REWRITE floor and exists so that "nothing happened" can be
 * said out loud. Reusing `template` for it would have been a lie with real
 * consequences: the gallery reads that word as "we swapped in the starter", and an
 * owner told that about their own funnel would go looking for work that was never
 * lost.
 */
export type FlowGenerateSource =
  | "model"
  | "model-repair"
  | "model-stripped"
  | "template"
  | "unchanged";

/** Why the model's graph was not used. null when it was. */
export type FlowGenerateReason = "truncated" | "unreadable" | "invalid" | "model-error" | null;

/**
 * DRAFT a funnel that does not exist, or REWRITE the words of one that does.
 * The floors are opposite (the goal's template / the owner's own graph), which is
 * why this is a mode rather than two flags.
 */
export type FlowGenerateMode = "draft" | "rewrite";

export interface GenerateFlowInput {
  /** Campaign goal key (GOAL_CATALOG). Picks the branch bias and the fallback template. */
  goal: string;
  /** The owner's free-text description of who the campaign is for. Internal only. */
  idealCustomer?: string | null;
  /** Target budget key (BUDGET_CATALOG). */
  targetBudget?: string | null;
  /**
   * The PRACTICE's own name. A fact rather than copy: it is what a trust strip is
   * headed with, and the model's version of it is discarded unread. Without one,
   * no trust strip is written at all.
   */
  practiceName?: string | null;
  /** Defaults to "draft". */
  mode?: FlowGenerateMode;
  /** The funnel as it stands. REQUIRED by mode "rewrite", ignored by "draft". */
  graph?: FlowGraph;
  callModel: CallFlowModel;
}

export interface GenerateFlowResult {
  /** Always valid: validateFlow(graph).ok === true, whatever the source. */
  graph: FlowGraph;
  source: FlowGenerateSource;
  reason: FlowGenerateReason;
  /** The last failure list, for the builder's "why" line. Empty on a clean pass. */
  failures: FlowValidationFailure[];
}

// ---------------------------------------------------------------------------
// Compliance. The SCANNER is flow-copy.ts - the one gate every write path goes
// through (updateCampaignFlow rejects on it), so a generated funnel is held to
// exactly the rules a hand-typed one is, and there is no second list to drift.
// What lives here is the one thing the write gate has no use for: STRIPPING.
// ---------------------------------------------------------------------------

/** Does this one line pass both scanners? The `where` is irrelevant to the verdict. */
function isCleanLine(text: string | undefined): boolean {
  return typeof text === "string" && text.trim() !== "" && scanFlowCopyText("", text).length === 0;
}

/**
 * Content blocks minus any block carrying a line that failed the scan. A block is
 * dropped WHOLE, not line by line: half a faq is a faq that answers a question
 * nobody asked, and a testimonial without its attribution is an anonymous claim.
 * `undefined` when the node had none, so the key stays absent.
 *
 * A dropped block cannot invalidate the graph: blocks are optional (rule 12 has no
 * minimum), so what comes out still validates, which is the promise stripFlowCopy
 * makes below.
 */
function cleanBlocks(blocks: FlowBlock[] | undefined): FlowBlock[] | undefined {
  if (!blocks) return undefined;
  const kept = blocks.filter((b) => blockCopyFields(b).every((f) => isCleanLine(f.text)));
  return kept.length > 0 ? kept.map(cloneFlowBlock) : undefined;
}

/**
 * Drop only the lines that failed the scan, keeping the rest of the funnel. This
 * is the "then strip" half of regenerate-once-then-strip (copilot/tools.ts:
 * 1277-1282): a second non-compliant reply costs the patient a warm lead-in on
 * one step, not the whole generated funnel.
 *
 * Every stripped field is OPTIONAL, so the graph that comes out validates exactly
 * as the one that went in, and it now passes the write gate the owner's save will
 * run it through (FlowCopyRejectedError, campaign-repository).
 */
export function stripFlowCopy(graph: FlowGraph): FlowGraph {
  const nodes: FlowNode[] = graph.nodes.map((n) => {
    if (n.kind === "question") {
      if (isCleanLine(n.transition)) return n;
      const node: FlowNode = { id: n.id, kind: "question", questionId: n.questionId };
      if (n.optionImages) node.optionImages = n.optionImages.map((o) => ({ ...o }));
      return node;
    }
    if (n.kind === "welcome") {
      const node: FlowNode = { id: n.id, kind: "welcome" };
      if (isCleanLine(n.headline)) node.headline = n.headline;
      if (isCleanLine(n.intro)) node.intro = n.intro;
      const blocks = cleanBlocks(n.blocks);
      if (blocks) node.blocks = blocks;
      return node;
    }
    if (n.kind === "outcome") {
      const blocks = cleanBlocks(n.blocks);
      if (isCleanLine(n.headline) && blocks?.length === n.blocks?.length) return n;
      const node: FlowNode = { id: n.id, kind: "outcome", band: n.band };
      if (isCleanLine(n.headline)) node.headline = n.headline;
      if (blocks) node.blocks = blocks;
      return node;
    }
    return n;
  });

  const edges: FlowEdge[] = graph.edges.map((e) =>
    isCleanLine(e.transition) ? e : { from: e.from, to: e.to, answer: e.answer },
  );

  return { schemaVersion: graph.schemaVersion, entry: graph.entry, nodes, edges };
}

// ---------------------------------------------------------------------------
// The prompt.
// ---------------------------------------------------------------------------

/**
 * The bank, one line per question: `id | dimension | prompt | options`, the same
 * shape the adaptive picker sends (next/route.ts:99) plus the option values,
 * which a graph needs because its edges route on them.
 *
 * WEIGHTS ARE NOT SENT. They are the scoring model, and a model that knows which
 * answers score highest is being invited to build a funnel that flatters the
 * numbers rather than one that qualifies an enquiry.
 */
export function renderQuestionBank(): string {
  return QUIZ_QUESTIONS.map((q) => {
    const options = q.options.map((o) => `${o.value}=${o.label}`).join("; ");
    const applies = q.appliesTo
      ? ` | ONLY after ${Q_TREATMENT} is answered ${q.appliesTo.join(" or ")}`
      : "";
    return `${q.id} | ${q.dimension} | ${q.prompt} | options: ${options}${applies}`;
  }).join("\n");
}

export interface FlowPrompt {
  system: string;
  user: string;
}

/** What each result screen is FOR, in the words the builder itself uses. */
const BAND_PURPOSE: Readonly<Record<string, string>> = {
  high: "the enquiry looked ready to get started",
  medium: "the enquiry looked interested but not yet decided",
  low: "the enquiry was early, and is looking for information",
};

/**
 * The screens the model may WRITE but may not BUILD, one line each, taken from
 * the goal's own scaffold so the ids in the prompt are the ids the merge looks up.
 * Empty when the goal has no template, which is the same state that makes
 * assembleFlowGraph return null.
 */
function renderScreenList(goal: string | null | undefined): string[] {
  const scaffold = scaffoldFor(goal);
  if (!scaffold) return [];
  const lines: string[] = [];
  if (scaffold.welcome) {
    lines.push(`${scaffold.welcome.id} | the opening screen, before the first question | headline, intro, blocks`);
  }
  for (const r of scaffold.results) {
    lines.push(`${r.id} | the result screen shown when ${BAND_PURPOSE[r.band] ?? "the enquiry scored " + r.band} | headline, blocks`);
  }
  return lines;
}

/** The pictures a screen may use, as keys. There is no other way to name one. */
function renderHeroImages(): string {
  return assessImagesForSlot("hero")
    .map((i) => `${i.key} (${i.alt})`)
    .join("; ");
}

export function buildFlowPrompt(input: {
  goal: string;
  idealCustomer?: string | null;
  targetBudget?: string | null;
  practiceName?: string | null;
}): FlowPrompt {
  const screens = renderScreenList(input.goal);
  const system = [
    "You design the question flow for a smile-assessment funnel on a UK dental practice's website, and you write the words on its opening and result screens.",
    "You choose questions ONLY from the bank supplied below. You never invent a question, an option value or an id.",
    "",
    "Reply with ONLY this JSON object:",
    '{"entry":"<node id>","nodes":[{"id":"<your id>","questionId":"<bank id>","transition":"<optional line>"}],"edges":[{"from":"<node id>","to":"<node id>","answer":"<option value or null>","transition":"<optional line>"}],"screens":{"<screen id>":{"headline":"<optional>","intro":"<optional>","blocks":[]}}}',
    "",
    "HARD RULES. A funnel that breaks one of these is rejected:",
    `1. Every questionId is copied exactly from the bank. Every "answer" is an option value of the question the edge STARTS from, or null.`,
    "2. Ask each question at most once in the whole funnel.",
    `3. Every question node has EXACTLY ONE edge with "answer": null, its default route. Add an edge with a specific answer only where that answer should go somewhere different.`,
    `4. EVERY route through the funnel must ask ${Q_TREATMENT}, ${Q_TIMELINE}, ${Q_BUDGET} and ${Q_LOCATION} before it reaches the contact step. Open with ${Q_TREATMENT}.`,
    `5. A question marked "ONLY after ${Q_TREATMENT} is answered X" may only be reached down the edges carrying those answers.`,
    `6. No route may ask more than ${MAX_FLOW_QUESTION_DEPTH} questions. Aim for five or six.`,
    `7. The contact step already exists, with the id "contact". Every route ends with an edge into it. Do NOT create a contact step, a welcome step or any result step: they are added for you.`,
    "8. Use between four and eight question nodes in total.",
    ...screenRules(),
    "",
    "TRANSITIONS are optional one-line lead-ins shown as the patient arrives at a step. Under 14 words each.",
    "",
    ...COPY_RULES,
    "",
    "Respond with ONLY the JSON object, no prose and no code fence.",
  ].join("\n");

  const ideal = (input.idealCustomer ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  const practice = (input.practiceName ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const user = [
    `Practice: ${practice || "not specified"}`,
    `Campaign goal: ${goalLabel(input.goal)}`,
    `Ideal patient for this campaign: ${ideal || "not specified"}`,
    `Budget focus: ${budgetLabel(input.targetBudget ?? "any")}`,
    "",
    "Screens you may write words for (id | what it is | fields it takes):",
    screens.join("\n") || "none",
    "",
    "Question bank (id | dimension | prompt | options as value=label):",
    renderQuestionBank(),
  ].join("\n");

  return { system, user };
}

/**
 * The compliance clauses, ONE list shared by both modes.
 *
 * They are the prompt-side half of flow-copy.ts, which is what actually enforces
 * them. Two copies of this list is how a rewrite quietly ends up allowed to say
 * something a draft is not, so there is one.
 */
const COPY_RULES: readonly string[] = [
  "EVERY line you write is read by a patient, and these apply to all of them:",
  "Warm, plain British English, written to the patient as “you”. No dashes of any kind.",
  "Never give clinical advice and never say whether a treatment is suitable: a clinician decides that.",
  "Never mention NHS or private care, plans, schemes, bands or funding of any kind.",
  "Never mention prices, discounts, finance, guarantees, reviews, ratings or awards, and never claim to be the best, the only or the leading anything.",
  "Never invent a patient's words, a result, a timescale you were not given, or a number of any kind.",
];

/**
 * What `screens` is and what may go in it.
 *
 * The two forbidden block kinds are named ALOUD rather than merely left off the
 * list, because a model told only "you may use these three" reaches for a
 * testimonial anyway when it is writing a page that obviously wants one - and
 * every token it spends on one is a block the parser drops.
 */
function screenRules(): string[] {
  return [
    '9. "screens" is OPTIONAL and holds the words on screens that ALREADY EXIST. Its keys are the screen ids listed in the next message and nothing else: you never create, rename or remove a screen. A headline is a short line at the top of a screen; an intro is one or two sentences under it. Write them only where they say something the campaign would want said.',
    `10. "blocks" is an optional list of small sections under the copy, at most ${FLOW_LIMITS.blocksPerNode} per screen. The ONLY kinds you may use:`,
    `   {"kind":"trust-strip","chips":["<short reassurance>", ...]} - 1 to ${FLOW_LIMITS.chips} chips of a few words each. Do NOT write the practice name: it is filled in for you.`,
    `   {"kind":"faq","items":[{"q":"<question>","a":"<answer>"}, ...]} - 2 to ${FLOW_LIMITS.faqItems} pairs.`,
    `   {"kind":"image","image":"<key>","alt":"<what it shows>"} - the key must be one of: ${renderHeroImages()}.`,
    "11. NEVER write a testimonial, a review, a patient quote or an attribution, and never a booking block. A quote belongs to the practice and only the practice types it in; a booking block asserts that online booking is switched on, which you cannot know. Anything of either kind is thrown away.",
  ];
}

/** The one repair pass: the whole failure list, quoted back (generate.ts:163). */
export function buildFlowRepairUser(previousReply: string, failuresText: string): string {
  return [
    "Your previous funnel did not pass our checks.",
    "Fix EVERY issue below and return the corrected JSON object only, in the same shape as before:",
    failuresText,
    "",
    "Your previous reply was:",
    previousReply,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing the reply.
// ---------------------------------------------------------------------------

interface ModelQuestionNode {
  id: string;
  questionId: string;
  transition?: string;
}

interface ModelEdge {
  from: string;
  to: string;
  answer: string | null;
  transition?: string;
}

/**
 * Copy for ONE already-existing screen. Never an id, never a kind, never a band:
 * everything that decides WHAT a screen is comes from the template, and this
 * carries only what it SAYS.
 */
export interface ParsedScreenCopy {
  headline?: string;
  intro?: string;
  blocks?: FlowBlock[];
}

export interface ParsedFlowReply {
  entry: string | null;
  nodes: ModelQuestionNode[];
  edges: ModelEdge[];
  /** Screen copy, keyed by the id of a screen that already exists. Never empty keys. */
  screens: Record<string, ParsedScreenCopy>;
}

/**
 * THE ONLY BLOCK KINDS A MODEL MAY EMIT, anywhere in this file, in either mode.
 *
 * `testimonial` and `booking` are absent, and the absence is enforced HERE rather
 * than only by leaving them out of the prompt, because a prompt is a request and a
 * parser is a gate. Each is excluded for its own reason:
 *
 *   TESTIMONIAL - the charter clause is absolute: "AI never fabricates
 *   testimonials, reviews or outcome claims; a testimonial block renders only
 *   practice-entered quotes". A model asked for a funnel will happily invent
 *   "Best decision I ever made, Sarah, Enfield", and a fabricated patient quote on
 *   a live dental page is a regulatory problem, not a copy problem. The rail
 *   refuses to have one written (flow-assist.ts) and blockToAdd refuses to add one
 *   without both fields (flow-inspect.ts); this is the third door, because the
 *   writer's merge path writes blocks straight onto the graph and would otherwise
 *   pass neither of the other two.
 *
 *   BOOKING - it is not furniture. A booking block wires the result screen to the
 *   practice's real Dentally calendar (C1), so emitting one is a claim that
 *   same-day booking is switched on and configured. That is a fact about the
 *   practice's setup, which a model has no way to know and no business asserting.
 */
export const WRITABLE_BLOCK_KINDS: readonly FlowBlockKind[] = ["trust-strip", "faq", "image"];

/**
 * The other half of that list, spelled out so the two together are exhaustive.
 *
 * A NEW BLOCK KIND MUST LAND IN ONE OF THESE TWO, and the sibling test fails until
 * it does. That is the whole reason this constant exists rather than being implied
 * by absence: "a model may write it" is a judgement about what a model can be
 * trusted to assert, and a kind that arrives while nobody is looking would
 * otherwise inherit whichever answer the code happened to give it.
 */
export const UNWRITABLE_BLOCK_KINDS: readonly FlowBlockKind[] = ["testimonial", "booking"];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A trimmed, capped identifier. null when unusable. */
function idOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > FLOW_LIMITS.nodeId) return null;
  return s;
}

/**
 * A patient-facing line, house-cleaned: dashes replaced (the one house-style slip
 * a model makes most, normalised rather than retried over, exactly as
 * generate.ts:178 does) and whitespace collapsed.
 *
 * A line OVER the length cap is DROPPED, not truncated. Half a sentence in front
 * of a patient reads worse than no lead-in at all, and the step is perfectly
 * readable without one.
 */
function cleanLineTo(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // The spaces AROUND the dash go with it. The house one-liner (generate.ts:179,
  // next/route.ts:60) replaces the character alone, which turns the model's usual
  // "Great — and when suits you?" into "Great , and when suits you?" - correct on
  // the ban, wrong in front of a patient. The trailing-comma trim covers a line
  // that ended on the dash.
  const s = v
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,+$/, "")
    .trim();
  if (!s || s.length > max) return undefined;
  return s;
}

/** A transition-shaped line: the commonest cap, kept as its own name. */
function cleanLine(v: unknown): string | undefined {
  return cleanLineTo(v, FLOW_LIMITS.transition);
}

/** Extract the JSON object from a reply. null when there is not one. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the PRACTICE is, as opposed to what the model may write about it. */
export interface FlowWriterContext {
  /** The practice's own name. A fact; never something a model supplies. */
  practiceName?: string | null;
}

/**
 * One content block from the model, or null.
 *
 * DROP, NEVER REJECT, and never poison the funnel: a block the model got wrong
 * costs that block and nothing else. Every failure below is a silent drop for the
 * same reason parseFlowReply drops junk nodes - a funnel missing one faq is a
 * funnel; a rejected reply is a repair call spent on furniture.
 *
 * THE PRACTICE'S NAME IS NOT COPY. A trust strip's first line is the practice's
 * own name, so it is taken from `context` and the model's version is discarded
 * unread - the same rule flow-assist.ts refuses to write, enforced here by
 * overwriting rather than by asking. With no name to put there, the block goes:
 * a trust strip headed by a practice that does not exist is worse than no strip.
 */
function parseScreenBlock(raw: unknown, context: FlowWriterContext): FlowBlock | null {
  if (!isObj(raw)) return null;
  // TWO LOCKS ON THE SAME DOOR, and they fail independently. This one is the
  // allowlist. The other is that there is NO CODE BELOW THAT BUILDS A TESTIMONIAL
  // OR A BOOKING BLOCK - so even a kind wrongly added to the list above falls out
  // of the bottom of this function as null, and the sibling test reads this source
  // to prove no such branch has been added since.
  const kind = WRITABLE_BLOCK_KINDS.find((k) => k === raw.kind);
  if (!kind) return null;

  if (kind === "trust-strip") {
    const practiceName = cleanLineTo(context.practiceName, FLOW_LIMITS.practiceName);
    if (!practiceName) return null;
    const chips = (Array.isArray(raw.chips) ? raw.chips : [])
      .map((c) => cleanLineTo(c, FLOW_LIMITS.chipLabel))
      .filter((c): c is string => typeof c === "string")
      .slice(0, FLOW_LIMITS.chips);
    // Rule 12's minimum, applied at the parse so a strip that would fail
    // validation never becomes a validation failure the model has to repair.
    if (chips.length < 1) return null;
    return { kind: "trust-strip", practiceName, chips };
  }

  if (kind === "faq") {
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((it) => {
        if (!isObj(it)) return null;
        const q = cleanLineTo(it.q, FLOW_LIMITS.faqQuestion);
        const a = cleanLineTo(it.a, FLOW_LIMITS.faqAnswer);
        return q && a ? { q, a } : null;
      })
      .filter((it): it is { q: string; a: string } => it !== null)
      .slice(0, FLOW_LIMITS.faqItems);
    if (items.length < 2) return null; // rule 12: one question is not a faq
    return { kind: "faq", items };
  }

  if (kind !== "image") return null; // unreachable today; the lock, not the comment

  // A PICTURE IS A KEY IN OUR MANIFEST, AND FIT FOR THIS SLOT (rule 13). An
  // unknown key is a model that invented a filename or reached for a URL, and the
  // answer to all of those is the same: no picture, same funnel.
  const image = assessImage(typeof raw.image === "string" ? raw.image.trim() : "");
  if (!image || image.slot !== "hero") return null;
  // The manifest's own alt is the fallback, and it is a better one than a model's:
  // it describes what the picture SHOWS, and the sibling test already holds every
  // entry in the manifest to the compliance scanners.
  const alt = cleanLineTo(raw.alt, FLOW_LIMITS.imageAlt) ?? cleanLineTo(image.alt, FLOW_LIMITS.imageAlt);
  if (!alt) return null;
  return { kind: "image", image: image.key, alt };
}

/**
 * The `screens` key: copy for screens that already exist, keyed by their id.
 *
 * An entry with nothing usable in it is dropped rather than kept empty, so the
 * merge downstream can treat "a key is present" as "there is something to apply".
 */
function parseScreens(raw: unknown, context: FlowWriterContext): Record<string, ParsedScreenCopy> {
  const out: Record<string, ParsedScreenCopy> = {};
  if (!isObj(raw)) return out;

  for (const [key, value] of Object.entries(raw)) {
    const id = idOf(key);
    if (!id || !isObj(value)) continue;

    const copy: ParsedScreenCopy = {};
    const headline = cleanLineTo(value.headline, FLOW_LIMITS.headline);
    const intro = cleanLineTo(value.intro, FLOW_LIMITS.intro);
    if (headline) copy.headline = headline;
    if (intro) copy.intro = intro;

    const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
      .map((b) => parseScreenBlock(b, context))
      .filter((b): b is FlowBlock => b !== null)
      .slice(0, FLOW_LIMITS.blocksPerNode);
    if (blocks.length > 0) copy.blocks = blocks;

    if (copy.headline || copy.intro || copy.blocks) out[id] = copy;
  }
  return out;
}

/**
 * Read the model's question nodes and edges. Anything it should not have sent
 * (a result node, a node with no questionId, a malformed edge) is DROPPED here
 * rather than rejected outright: whatever the drop breaks - an edge now pointing
 * at nothing, a core question now missing - is caught by validateFlow with a
 * message naming the exact node, which is a far better repair instruction than
 * "your JSON was wrong somewhere".
 *
 * null means there was no readable object with question nodes in it at all.
 */
export function parseFlowReply(text: string, context: FlowWriterContext = {}): ParsedFlowReply | null {
  const raw = parseJsonObject(text);
  if (!raw || !Array.isArray(raw.nodes)) return null;

  const nodes: ModelQuestionNode[] = [];
  for (const n of raw.nodes) {
    if (!isObj(n)) continue;
    const id = idOf(n.id);
    const questionId = idOf(n.questionId);
    if (!id || !questionId) continue;
    const node: ModelQuestionNode = { id, questionId };
    const transition = cleanLine(n.transition);
    if (transition) node.transition = transition;
    nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const edges: ModelEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!isObj(e)) continue;
    const from = idOf(e.from);
    const to = idOf(e.to);
    if (!from || !to) continue;
    // A missing answer is the default route: the model omitting the key is
    // common and harmless, because rule 3 still checks the coverage.
    const answer = e.answer === undefined || e.answer === null ? null : idOf(e.answer);
    if (answer === null && e.answer !== undefined && e.answer !== null) continue; // unusable answer
    const edge: ModelEdge = { from, to, answer };
    const transition = cleanLine(e.transition);
    if (transition) edge.transition = transition;
    edges.push(edge);
  }

  return { entry: idOf(raw.entry), nodes, edges, screens: parseScreens(raw.screens, context) };
}

// ---------------------------------------------------------------------------
// The pinned scaffold: the parts of a funnel the model does not get to write.
// ---------------------------------------------------------------------------

interface Scaffold {
  welcome: Extract<FlowNode, { kind: "welcome" }> | null;
  contact: Extract<FlowNode, { kind: "contact" }>;
  results: Extract<FlowNode, { kind: "outcome" }>[];
  /** contact -> result, one per band, exactly as the template wires them. */
  bandEdges: FlowEdge[];
}

/**
 * Taken FROM the goal's template rather than written here, on purpose: the
 * template's result copy is already walked by flow-templates.test.ts against
 * scanBannedText and the NHS/private regexes, so pinning to it inherits that
 * proof instead of quietly creating a second, unscanned set of patient-facing
 * strings that has to be kept in step by hand.
 */
function scaffoldFor(goal: string | null | undefined): Scaffold | null {
  const template = templateForGoal(goal).build();
  const contact = template.nodes.find((n) => n.kind === "contact");
  const results = template.nodes.filter((n): n is Extract<FlowNode, { kind: "outcome" }> => n.kind === "outcome");
  if (!contact || contact.kind !== "contact" || results.length === 0) return null;
  const entryNode = template.nodes.find((n) => n.id === template.entry);
  const welcome = entryNode && entryNode.kind === "welcome" ? entryNode : null;
  return {
    welcome,
    contact,
    results,
    bandEdges: template.edges.filter((e) => e.from === contact.id),
  };
}

/**
 * A scaffold screen wearing the model's words, or the scaffold screen untouched.
 *
 * The screen is the TEMPLATE'S - its id, its kind and, for a result, its band are
 * copied across before a single authored field is looked at, so a `screens` entry
 * can change what a screen says and can never change which screen it is. An absent
 * field leaves the template's own (a result headline the model did not rewrite
 * keeps OUTCOME_HEADLINES rather than losing its heading).
 */
function withScreenCopy(node: FlowNode, copy: ParsedScreenCopy | undefined): FlowNode {
  if (!copy) return node;
  if (node.kind === "welcome") {
    const out: FlowNode = { id: node.id, kind: "welcome" };
    const headline = copy.headline ?? node.headline;
    const intro = copy.intro ?? node.intro;
    const blocks = copy.blocks ?? node.blocks;
    if (headline !== undefined) out.headline = headline;
    if (intro !== undefined) out.intro = intro;
    if (blocks !== undefined) out.blocks = blocks.map(cloneFlowBlock);
    return out;
  }
  if (node.kind === "outcome") {
    const out: FlowNode = { id: node.id, kind: "outcome", band: node.band };
    const headline = copy.headline ?? node.headline;
    const blocks = copy.blocks ?? node.blocks;
    if (headline !== undefined) out.headline = headline;
    if (blocks !== undefined) out.blocks = blocks.map(cloneFlowBlock);
    return out;
  }
  // A `screens` entry naming the CONTACT step, or a question. Neither has a
  // headline to write: the contact step's wording is hand-written JSX in the
  // runtime, and a question's lead-in already has its own field on the node.
  return node;
}

/**
 * Wrap the model's questions in the pinned scaffold: welcome in front, contact
 * and the three results behind. This is what makes contact capture structural
 * rather than something the model is trusted to remember.
 *
 * The `screens` copy lands HERE, on the scaffold's own screens, which is why the
 * model never needs to emit one: it addresses a screen that already exists by id,
 * and an id that names nothing is simply never asked for.
 */
export function assembleFlowGraph(parsed: ParsedFlowReply, goal: string | null | undefined): FlowGraph | null {
  const scaffold = scaffoldFor(goal);
  if (!scaffold) return null;

  const first =
    parsed.entry && parsed.nodes.some((n) => n.id === parsed.entry) ? parsed.entry : parsed.nodes[0]!.id;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  if (scaffold.welcome) {
    nodes.push(withScreenCopy(scaffold.welcome, parsed.screens[scaffold.welcome.id]));
    edges.push({ from: scaffold.welcome.id, to: first, answer: null });
  }
  for (const n of parsed.nodes) {
    const node: FlowNode = { id: n.id, kind: "question", questionId: n.questionId };
    if (n.transition) node.transition = n.transition;
    nodes.push(node);
  }
  // Edges out of the contact step are the scaffold's business, not the model's:
  // they carry the BAND, which is decided server-side after scoring. One from the
  // model would either duplicate a band route or invent one (rules 2 and 3).
  for (const e of parsed.edges) {
    if (e.from === scaffold.contact.id) continue;
    const edge: FlowEdge = { from: e.from, to: e.to, answer: e.answer };
    if (e.transition) edge.transition = e.transition;
    edges.push(edge);
  }

  nodes.push(
    scaffold.contact,
    ...scaffold.results.map((r) => withScreenCopy(r, parsed.screens[r.id])),
  );
  edges.push(...scaffold.bandEdges);

  // A funnel that now carries content blocks has to SAY it needs the version that
  // can hold them, or rule 1 refuses the owner's save (schema_version_too_old) on
  // words we just asked a model to write.
  return withRequiredSchemaVersion({
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: scaffold.welcome ? scaffold.welcome.id : first,
    nodes,
    edges,
  });
}

export interface PinScaffoldOptions {
  /**
   * Keep patient-facing COPY that the graph already carries on the welcome and
   * result screens, instead of restoring the template's.
   *
   * OFF BY DEFAULT, and that is the important half. The default is "the scaffold
   * wins outright", which is what makes "the model cannot write the result copy"
   * a property of this function rather than of whoever calls it. A caller that
   * has DELIBERATELY asked a model for that copy - the AI-writer lane - opts in
   * here, and takes on the one obligation the default does not have: the
   * compliance scan must run AFTER the pin, because the words that survive it
   * are now the model's rather than the template's already-scanned ones.
   *
   * What the flag does NOT relax, ever: the band, the node id, the node kind and
   * the contact step, all of which are forced from the scaffold either way.
   */
  keepAuthoredCopy?: boolean;
}

/**
 * One pinned screen, keeping whatever copy the graph's own version of it carries.
 *
 * Identity comes from the SCAFFOLD and copy comes from the GRAPH - never the
 * other way round. The band in particular is scoring, not wording: it is decided
 * server-side by scoreAssessment after the submission, so a node sitting at
 * `result-high` is the high result whatever it says about itself.
 */
function mergeAuthoredCopy(pin: FlowNode, authored: FlowNode): FlowNode {
  if (pin.kind === "welcome" && authored.kind === "welcome") {
    const node: FlowNode = { id: pin.id, kind: "welcome" };
    const headline = authored.headline ?? pin.headline;
    const intro = authored.intro ?? pin.intro;
    const blocks = authored.blocks ?? pin.blocks;
    if (headline !== undefined) node.headline = headline;
    if (intro !== undefined) node.intro = intro;
    if (blocks !== undefined) node.blocks = blocks.map(cloneFlowBlock);
    return node;
  }
  if (pin.kind === "outcome" && authored.kind === "outcome") {
    const node: FlowNode = { id: pin.id, kind: "outcome", band: pin.band };
    const headline = authored.headline ?? pin.headline;
    const blocks = authored.blocks ?? pin.blocks;
    if (headline !== undefined) node.headline = headline;
    if (blocks !== undefined) node.blocks = blocks.map(cloneFlowBlock);
    return node;
  }
  // Everything else - the contact step, and a graph node whose kind no longer
  // matches the scaffold's for that id - is replaced outright. A contact step
  // carries no authored copy at all (its wording is hand-written JSX in the
  // runtime), so there is nothing to keep and nothing to lose.
  return pin;
}

/**
 * Re-pin the scaffold AFTER validation - the generate-run.ts:63-67 move.
 *
 * IT IS A WHOLESALE OVERWRITE BY ID, not the no-op it reads as. Today's assembly
 * already supplies these nodes and parseFlowReply cannot emit a welcome or an
 * outcome node, so there has never been anything on one for the overwrite to
 * destroy - but that is a fact about the current parser, not about this function,
 * and writing it down as "it swaps nodes for identical ones" is how a later lane
 * teaches a model to author welcome copy and never notices it being deleted.
 *
 * So: the overwrite is the DEFAULT and is stated as such, and a caller that means
 * to keep authored copy says so with `keepAuthoredCopy` and inherits the
 * scan-after-pin obligation documented on it.
 */
export function pinScaffoldNodes(
  graph: FlowGraph,
  goal: string | null | undefined,
  options?: PinScaffoldOptions,
): FlowGraph {
  const scaffold = scaffoldFor(goal);
  if (!scaffold) return graph;
  const keepAuthoredCopy = options?.keepAuthoredCopy === true;
  const pinned = new Map<string, FlowNode>();
  if (scaffold.welcome) pinned.set(scaffold.welcome.id, scaffold.welcome);
  pinned.set(scaffold.contact.id, scaffold.contact);
  for (const r of scaffold.results) pinned.set(r.id, r);

  const nodes = graph.nodes.map((n) => {
    const pin = pinned.get(n.id);
    if (!pin) return n;
    return keepAuthoredCopy ? mergeAuthoredCopy(pin, n) : pin;
  });
  const edges = [
    ...graph.edges.filter((e) => e.from !== scaffold.contact.id),
    ...scaffold.bandEdges,
  ];
  return { schemaVersion: graph.schemaVersion, entry: graph.entry, nodes, edges };
}

// ---------------------------------------------------------------------------
// Rewrite: the same funnel, different words.
// ---------------------------------------------------------------------------

/**
 * THE FOUR FIELDS A REWRITE MAY CHANGE. Everything else about a funnel - which
 * screens exist and in what order, what each one asks, where every answer goes,
 * which band a result is, its answer-card pictures and its content blocks - is the
 * owner's, and a rewrite that touched any of it would be a redesign wearing a
 * copy button's label.
 *
 * BLOCK WORDING IS DELIBERATELY NOT HERE. A trust strip's chips and a faq's
 * answers are copy, but they are copy the owner placed deliberately, and
 * rewriting them wholesale from a reply keyed by screen would silently reword
 * furniture the owner may have typed by hand. The rail's per-line "write this for
 * me" (flow-assist.ts) is the control for those, one box at a time and one refusal
 * at a time.
 */
export const REWRITABLE_NODE_FIELDS: Readonly<Record<FlowNodeKind, readonly string[]>> = {
  welcome: ["headline", "intro"],
  question: ["transition"],
  outcome: ["headline"],
  /** The contact step's wording is hand-written JSX in the runtime. Nothing here. */
  contact: [],
};

/** The one field on a wire. Its own constant so the erase below reads as a pair. */
export const REWRITABLE_EDGE_FIELDS: readonly string[] = ["transition"];

/** Deep JSON with object keys sorted, so two equal shapes compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/**
 * The graph with every rewritable field erased: two funnels have the same
 * STRUCTURE exactly when these are equal.
 *
 * ERASE-THEN-COMPARE, not a field-by-field walk, and the difference is which way
 * it fails. A walk has to be extended by hand every time FlowNode grows a key, and
 * forgetting makes the new key silently rewritable - a model could then change it
 * and the guard would say the funnel was untouched. Erasing only what MAY change
 * fails the other way: a new key is structure until somebody says otherwise, so
 * the worst a forgotten entry can do is refuse a rewrite.
 */
function structureOnly(graph: FlowGraph): string {
  const nodes = graph.nodes.map((n) => {
    const copy: Record<string, unknown> = { ...n };
    for (const field of REWRITABLE_NODE_FIELDS[n.kind]) delete copy[field];
    return copy;
  });
  const edges = graph.edges.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    for (const field of REWRITABLE_EDGE_FIELDS) delete copy[field];
    return copy;
  });
  return stableJson({ entry: graph.entry, nodes, edges });
}

/** Do these two funnels differ ONLY in the words a rewrite is allowed to change? */
export function sameFlowStructure(a: FlowGraph, b: FlowGraph): boolean {
  return structureOnly(a) === structureOnly(b);
}

/**
 * The owner's funnel wearing the model's words.
 *
 * IT READS COPY AND NOTHING ELSE, which is what makes the structure guarantee a
 * property of this function rather than a hope about the reply. The model is asked
 * to echo the funnel back; whatever it actually sends, only four kinds of string
 * are ever taken out of it, and each is looked up AGAINST THE EXISTING GRAPH -
 * question lead-ins by node id, screen copy by screen id, edge lead-ins by the
 * wire's own from/to/answer. An id the model invented matches nothing and is
 * therefore ignored rather than added.
 *
 * A FIELD THE MODEL DID NOT REWRITE KEEPS THE OWNER'S OWN. "Rewrite my funnel"
 * cannot be allowed to mean "delete the lines you had no opinion about".
 */
export function applyRewrittenCopy(graph: FlowGraph, parsed: ParsedFlowReply): FlowGraph {
  const byNode = new Map<string, string>();
  for (const n of parsed.nodes) if (n.transition) byNode.set(n.id, n.transition);

  // KEYED BY THE WIRE ITSELF, and by JSON rather than by joining with a
  // separator: a node id is whatever the model sent, so any separator character
  // can also be IN one, and "a b" -> "c" would then key the same as "a" -> "b c".
  // Two different branches sharing one lead-in is exactly the silent, plausible
  // wrongness this whole path is built to refuse.
  const edgeKey = (from: string, to: string, answer: string | null): string =>
    JSON.stringify([from, to, answer]);

  const byEdge = new Map<string, string>();
  for (const e of parsed.edges) {
    const key = edgeKey(e.from, e.to, e.answer);
    if (e.transition && !byEdge.has(key)) byEdge.set(key, e.transition);
  }

  const nodes: FlowNode[] = graph.nodes.map((n) => {
    if (n.kind === "question") {
      // No rewrite for this step means THIS STEP IS UNCHANGED - not "this step
      // now has no lead-in". Written as a guard on the lookup rather than as a
      // `?? n.transition` fallback so there is exactly one way to express it and
      // no second, redundant one that a later edit could get wrong on its own.
      const rewritten = byNode.get(n.id);
      return rewritten === undefined ? n : { ...n, transition: rewritten };
    }
    const copy = parsed.screens[n.id];
    if (!copy) return n;
    if (n.kind === "welcome") {
      const out = { ...n };
      if (copy.headline) out.headline = copy.headline;
      if (copy.intro) out.intro = copy.intro;
      return out;
    }
    if (n.kind === "outcome") {
      const out = { ...n };
      if (copy.headline) out.headline = copy.headline;
      return out;
    }
    return n;
  });

  const edges: FlowEdge[] = graph.edges.map((e) => {
    // Addressed by the WIRE, never by its position in the array: a model that
    // reorders the edges it echoes back would otherwise put every lead-in on the
    // wrong branch, silently and plausibly.
    const rewritten = byEdge.get(edgeKey(e.from, e.to, e.answer));
    return rewritten === undefined ? e : { ...e, transition: rewritten };
  });

  return { schemaVersion: graph.schemaVersion, entry: graph.entry, nodes, edges };
}

/**
 * The parsed copy with every line that failed the compliance scan REMOVED.
 *
 * THIS IS WHAT "STRIP" MEANS ON A REWRITE, and it is not what it means on a draft.
 * stripFlowCopy deletes an offending field, which is right for a funnel the model
 * just invented - the alternative there is no funnel. Here the field already had
 * words in it, the owner's own, and deleting them because the MODEL's replacement
 * was non-compliant would punish the owner for the model's answer. So the bad line
 * is dropped from the REPLY instead, and applyRewrittenCopy then leaves that field
 * exactly as it found it.
 */
function scrubParsedCopy(parsed: ParsedFlowReply): ParsedFlowReply {
  const clean = (text: string | undefined): string | undefined =>
    text !== undefined && scanFlowCopyText("", text).length === 0 ? text : undefined;

  const screens: Record<string, ParsedScreenCopy> = {};
  for (const [id, copy] of Object.entries(parsed.screens)) {
    const next: ParsedScreenCopy = {};
    const headline = clean(copy.headline);
    const intro = clean(copy.intro);
    if (headline) next.headline = headline;
    if (intro) next.intro = intro;
    if (next.headline || next.intro) screens[id] = next;
  }

  return {
    entry: parsed.entry,
    nodes: parsed.nodes.map((n) => {
      const transition = clean(n.transition);
      return transition === undefined ? { id: n.id, questionId: n.questionId } : { ...n, transition };
    }),
    edges: parsed.edges.map((e) => {
      const transition = clean(e.transition);
      return transition === undefined ? { from: e.from, to: e.to, answer: e.answer } : { ...e, transition };
    }),
    screens,
  };
}

/** One line per screen and per wire: what it is now, so the model can reword it. */
function renderCurrentFunnel(graph: FlowGraph): string[] {
  const lines: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "welcome") {
      lines.push(
        `${n.id} | opening screen | headline: ${n.headline || "(empty)"} | intro: ${n.intro || "(empty)"}`,
      );
    } else if (n.kind === "question") {
      const q = questionById(n.questionId);
      lines.push(
        `${n.id} | question (${n.questionId}) asking “${q?.prompt ?? n.questionId}” | lead-in: ${n.transition || "(empty)"}`,
      );
    } else if (n.kind === "outcome") {
      lines.push(
        `${n.id} | result screen for an enquiry where ${BAND_PURPOSE[n.band] ?? n.band} | headline: ${n.headline || "(empty)"}`,
      );
    } else {
      lines.push(`${n.id} | the contact step, whose wording is not yours to change`);
    }
    // Blocks are listed so the model does not repeat what a screen already says,
    // and marked as untouchable so it does not try to send them back reworded.
    const blocks = blocksOf(n);
    if (blocks.length > 0) {
      lines.push(`    already on that screen (leave these alone): ${blocks.map((b) => b.kind).join(", ")}`);
    }
  }
  for (const e of graph.edges) {
    lines.push(
      `edge ${e.from} -> ${e.to} (answer: ${e.answer ?? "null"}) | lead-in: ${e.transition || "(empty)"}`,
    );
  }
  return lines;
}

/**
 * REWRITE THE WORDS OF A FUNNEL THAT ALREADY EXISTS.
 *
 * The system turn is the draft writer's compliance clauses verbatim (COPY_RULES),
 * because a rewrite that were allowed to say something a draft is not would be a
 * second, quieter set of rules for patient-facing copy.
 */
export function buildRewritePrompt(
  graph: FlowGraph,
  input: { goal: string; idealCustomer?: string | null; targetBudget?: string | null; practiceName?: string | null },
): FlowPrompt {
  const system = [
    "You rewrite the words on a smile-assessment funnel that a UK dental practice has already built.",
    "",
    "You change WORDING ONLY. Return the funnel exactly as it is - the same node ids, the same questionIds, the same edges, in the same order - with better words on it.",
    "",
    "Reply with ONLY this JSON object:",
    '{"nodes":[{"id":"<existing node id>","questionId":"<its existing questionId>","transition":"<the new lead-in>"}],"edges":[{"from":"<existing>","to":"<existing>","answer":"<existing option value or null>","transition":"<the new lead-in>"}],"screens":{"<existing screen id>":{"headline":"<new>","intro":"<new>"}}}',
    "",
    "HARD RULES:",
    "1. Never invent, rename, remove or reorder a node or an edge. Anything that is not already in the funnel below is thrown away.",
    "2. Leave a line out entirely if you would not improve it. A line you omit keeps the words it has; it is never emptied.",
    "3. A lead-in is under 14 words. A headline is one short line. An intro is one or two sentences.",
    "4. Content sections already on a screen (a trust strip, a faq, a picture) are not yours to change: do not send them back.",
    "",
    ...COPY_RULES,
    "",
    "Respond with ONLY the JSON object, no prose and no code fence.",
  ].join("\n");

  const ideal = (input.idealCustomer ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  const practice = (input.practiceName ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const user = [
    `Practice: ${practice || "not specified"}`,
    `Campaign goal: ${goalLabel(input.goal)}`,
    `Ideal patient for this campaign: ${ideal || "not specified"}`,
    `Budget focus: ${budgetLabel(input.targetBudget ?? "any")}`,
    "",
    "The funnel as it stands:",
    ...renderCurrentFunnel(graph),
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// Vetting one reply.
// ---------------------------------------------------------------------------

const UNREADABLE_FAILURE: FlowValidationFailure = {
  rule: 0,
  code: "unreadable",
  where: "flow",
  message:
    'the reply was not a JSON object carrying a "nodes" array of {id, questionId} entries chosen from the question bank',
};

const SCAFFOLD_FAILURE: FlowValidationFailure = {
  rule: 0,
  code: "no_scaffold",
  where: "flow",
  message: "no template exists for this goal, so the contact and result steps could not be pinned",
};

/**
 * Only reachable if pinning the scaffold onto an already-valid graph somehow
 * invalidated it, which the pin cannot do on the default path (it restores the
 * template's own screens, which validate, and the canonical band edges). It exists
 * so that even that path has a failure to quote rather than an empty repair prompt
 * - and it stops being impossible the moment a caller opts into keepAuthoredCopy,
 * which can carry copy that is too long or a block a screen may not hold.
 */
const POST_PIN_FAILURE: FlowValidationFailure = {
  rule: 0,
  code: "post_pin_invalid",
  where: "flow",
  message: "the funnel did not validate once the contact and result steps were pinned",
};

type Vetted =
  | { ok: true; graph: FlowGraph }
  | {
      ok: false;
      failures: FlowValidationFailure[];
      failuresText: string;
      /** Set only when the graph is structurally VALID and only its copy failed. */
      strippable: FlowGraph | null;
      reason: Exclude<FlowGenerateReason, "truncated" | "model-error">;
    };

/** parse -> assemble -> validate -> pin -> compliance scan. */
function vet(text: string, goal: string, context: FlowWriterContext): Vetted {
  const parsed = parseFlowReply(text, context);
  if (!parsed) {
    return {
      ok: false,
      failures: [UNREADABLE_FAILURE],
      failuresText: describeFlowFailures([UNREADABLE_FAILURE]),
      strippable: null,
      reason: "unreadable",
    };
  }

  const assembled = assembleFlowGraph(parsed, goal);
  if (!assembled) {
    return {
      ok: false,
      failures: [SCAFFOLD_FAILURE],
      failuresText: describeFlowFailures([SCAFFOLD_FAILURE]),
      strippable: null,
      reason: "invalid",
    };
  }

  const { graph, result } = normaliseAndValidateFlow(assembled);
  if (!graph) {
    return {
      ok: false,
      failures: result.failures,
      failuresText: describeFlowFailures(result.failures),
      strippable: null,
      reason: "invalid",
    };
  }

  // ORDER IS LOAD-BEARING: PIN, THEN SCAN - and this path is the reason the
  // ordering is a correctness dependency rather than a tidiness. The pin KEEPS the
  // model's screen copy (keepAuthoredCopy), so a scan running first would inspect
  // words that the pin had not yet let through, and the words a patient actually
  // reads would ship unscanned. Pinned twice by flow-generate.test.ts: once on the
  // behaviour, once on the literal source order inside this function.
  //
  // What the opt-in does NOT relax, and what therefore still cannot be written by
  // a model: the screen ids, the node kinds, each result's band, the contact step
  // and the band routes out of it. Copy in, identity out.
  const pinnedGraph = pinScaffoldNodes(graph, goal, { keepAuthoredCopy: true });
  const hits = scanFlowCopy(pinnedGraph);
  if (hits.length > 0) {
    return {
      ok: false,
      failures: [],
      failuresText: describeFlowCopyHits(hits),
      strippable: pinnedGraph,
      reason: "invalid",
    };
  }
  return { ok: true, graph: pinnedGraph };
}

/**
 * The last gate before anything is returned: a graph that does not validate is
 * not a graph we hand back, whatever produced it. Cheap, pure, and the reason
 * "never render unvalidated" is a property of this file rather than a habit.
 */
function finalise(graph: FlowGraph): FlowGraph | null {
  return validateFlow(graph).ok ? graph : null;
}

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

export async function generateFlow(input: GenerateFlowInput): Promise<GenerateFlowResult> {
  // TWO MODES, AND THE SPLIT IS AT THE TOP because their FLOORS are opposite: a
  // draft that fails ends on the goal's template, and a rewrite that fails ends on
  // the owner's own funnel. Nothing below this line can reach templateResult on a
  // rewrite, which is the property that makes "Rewrite the words" safe to put
  // beside a funnel somebody spent an afternoon building.
  if (input.mode === "rewrite") {
    return input.graph
      ? await rewriteFlowCopy(input.graph, input)
      : { graph: templateForGoal(input.goal).build(), source: "template", reason: "invalid", failures: [] };
  }

  const { goal, callModel } = input;
  const context: FlowWriterContext = { practiceName: input.practiceName };
  const { system, user } = buildFlowPrompt(input);

  let failures: FlowValidationFailure[] = [];
  let reason: FlowGenerateReason = "model-error";

  try {
    const first = await callModel(system, user);

    // Truncated: refuse BEFORE parsing. A reply cut off at the cap is not a
    // funnel with a few things wrong, it is half a sentence of JSON, and there is
    // nothing in it worth quoting back at the model. Straight to the template.
    if (first.stopReason === "max_tokens") {
      return templateResult(goal, "truncated", []);
    }

    const vetted = vet(first.text, goal, context);
    if (vetted.ok) {
      const graph = finalise(vetted.graph);
      if (graph) return { graph, source: "model", reason: null, failures: [] };
      failures = [POST_PIN_FAILURE];
      reason = "invalid";
    } else {
      failures = vetted.failures;
      reason = vetted.reason;
    }

    // ONE repair pass, quoting every failure at once.
    const failuresText = vetted.ok ? describeFlowFailures([POST_PIN_FAILURE]) : vetted.failuresText;
    const second = await callModel(system, buildFlowRepairUser(first.text, failuresText));
    if (second.stopReason === "max_tokens") return templateResult(goal, "truncated", failures);

    const revetted = vet(second.text, goal, context);
    if (revetted.ok) {
      const graph = finalise(revetted.graph);
      if (graph) return { graph, source: "model-repair", reason: null, failures: [] };
    } else {
      failures = revetted.failures;
      reason = revetted.reason;

      // THEN STRIP. The second reply is a structurally sound funnel whose only
      // problem is a line of copy: keep the funnel, drop the lines. Losing a
      // whole generated funnel over one word would be a worse trade for the
      // owner, and the stripped graph is re-validated below like any other.
      if (revetted.strippable) {
        const graph = finalise(stripFlowCopy(revetted.strippable));
        if (graph) return { graph, source: "model-stripped", reason: null, failures: [] };
      }
    }
  } catch {
    // A model or network error is an unusable reply by another name.
    return templateResult(goal, "model-error", failures);
  }

  return templateResult(goal, reason, failures);
}

/**
 * REWRITE, end to end. The same five steps as the draft pipeline, with two
 * differences and both of them are the point:
 *
 *   THE STRUCTURE IS NOT THE MODEL'S TO GET WRONG. applyRewrittenCopy reads copy
 *   and nothing else out of the reply, so there is no structural failure to
 *   validate against and the repair pass only ever has COPY to quote back. That is
 *   what makes the rewrite the cheap half: one class of failure, one kind of fix.
 *
 *   THE FLOOR IS THE OWNER'S FUNNEL, byte for byte. Not the template - never the
 *   template. Handing back a template here would delete a funnel somebody built,
 *   silently, in exchange for pressing a button labelled "rewrite the words".
 */
async function rewriteFlowCopy(
  graph: FlowGraph,
  input: GenerateFlowInput,
): Promise<GenerateFlowResult> {
  const { callModel } = input;
  const context: FlowWriterContext = { practiceName: input.practiceName };
  const { system, user } = buildRewritePrompt(graph, input);

  /**
   * The one gate on the way out: same funnel, and nothing a patient may not read.
   *
   * THE TWO CHECKS ARE NOT THE SAME KIND OF CHECK. The scan is live: the funnel
   * that arrived may itself carry wording a patient must not see (a draft saved
   * before the scanner existed), and a rewrite that leaves such a line in place
   * must not report success over it. The structure check is DEFENCE IN DEPTH and
   * cannot fail today - applyRewrittenCopy preserves structure by construction, and
   * the sibling tests prove it directly. It is here because "by construction" is a
   * property of the function as it is written this morning, and the cost of being
   * wrong about it is a funnel somebody built being quietly redesigned.
   */
  const settle = (
    candidate: FlowGraph,
    source: FlowGenerateSource,
  ): GenerateFlowResult | null => {
    if (!sameFlowStructure(graph, candidate)) return null;
    if (scanFlowCopy(candidate).length > 0) return null;
    return { graph: candidate, source, reason: null, failures: [] };
  };

  const unchanged = (reason: FlowGenerateReason): GenerateFlowResult => ({
    graph,
    source: "unchanged",
    reason,
    failures: [],
  });

  try {
    const first = await callModel(system, user);
    if (first.stopReason === "max_tokens") return unchanged("truncated");

    const parsed = parseFlowReply(first.text, context);
    if (!parsed) return unchanged("unreadable");

    const once = applyRewrittenCopy(graph, parsed);
    const hits = scanFlowCopy(once);
    if (hits.length === 0) {
      const settled = settle(once, "model");
      if (settled) return settled;
      return unchanged("invalid");
    }

    // ONE repair pass, quoting the offending phrases in the write gate's own
    // words - the same describeFlowCopyHits the save would answer with.
    const second = await callModel(system, buildFlowRepairUser(first.text, describeFlowCopyHits(hits)));
    if (second.stopReason === "max_tokens") return unchanged("truncated");

    const reparsed = parseFlowReply(second.text, context);
    if (reparsed) {
      const twice = applyRewrittenCopy(graph, reparsed);
      if (scanFlowCopy(twice).length === 0) {
        const settled = settle(twice, "model-repair");
        if (settled) return settled;
      }
      // THEN STRIP - by dropping the offending lines from the REPLY, not from the
      // funnel. Every field the model failed on keeps the owner's own words, and
      // the ones it got right still land, so a single bad sentence costs one line
      // of improvement rather than the whole rewrite.
      const stripped = applyRewrittenCopy(graph, scrubParsedCopy(reparsed));
      const settled = settle(stripped, "model-stripped");
      if (settled) return settled;
    }
    return unchanged("invalid");
  } catch {
    return unchanged("model-error");
  }
}

/**
 * The floor: the goal's hand-written template. It is validated here too - not
 * because it is expected to fail (flow-templates.test.ts proves it does not) but
 * because this function's contract is "the graph you get back is valid", and a
 * contract with an exception in it is not a contract.
 */
function templateResult(
  goal: string,
  reason: FlowGenerateReason,
  failures: FlowValidationFailure[],
): GenerateFlowResult {
  const graph = templateForGoal(goal).build();
  return { graph, source: "template", reason, failures };
}
