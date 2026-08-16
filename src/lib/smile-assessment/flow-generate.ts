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
// WHY A MODEL/NETWORK ERROR AND AN UNUSABLE REPLY ARE THE SAME THING. Both mean
// "no usable funnel from the model", and both end on the template. There is no
// state in which this function returns something a patient should not see, and
// no state in which it returns nothing.
//
// PURE APART FROM THE INJECTED callModel, so the whole pipeline runs in the node
// test env with no network and no Anthropic SDK (flow-generate.test.ts). The
// route (api/smile-assessment/flow-generate) owns the model, its budget and its
// guards; this file owns the thinking.

import { QUIZ_QUESTIONS, Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";
import { budgetLabel, goalLabel } from "./campaign";
import {
  FLOW_LIMITS,
  FLOW_SCHEMA_VERSION,
  blockCopyFields,
  cloneFlowBlock,
  type FlowBlock,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";
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

/** Where the returned graph came from. Surfaced to the owner by the builder UI. */
export type FlowGenerateSource = "model" | "model-repair" | "model-stripped" | "template";

/** Why the model's graph was not used. null when it was. */
export type FlowGenerateReason = "truncated" | "unreadable" | "invalid" | "model-error" | null;

export interface GenerateFlowInput {
  /** Campaign goal key (GOAL_CATALOG). Picks the branch bias and the fallback template. */
  goal: string;
  /** The owner's free-text description of who the campaign is for. Internal only. */
  idealCustomer?: string | null;
  /** Target budget key (BUDGET_CATALOG). */
  targetBudget?: string | null;
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

export function buildFlowPrompt(input: {
  goal: string;
  idealCustomer?: string | null;
  targetBudget?: string | null;
}): FlowPrompt {
  const system = [
    "You design the question flow for a smile-assessment funnel on a UK dental practice's website.",
    "You choose questions ONLY from the bank supplied below. You never invent a question, an option value or an id.",
    "",
    "Reply with ONLY this JSON object:",
    '{"entry":"<node id>","nodes":[{"id":"<your id>","questionId":"<bank id>","transition":"<optional line>"}],"edges":[{"from":"<node id>","to":"<node id>","answer":"<option value or null>","transition":"<optional line>"}]}',
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
    "",
    "TRANSITIONS are optional one-line lead-ins shown as the patient arrives at a step.",
    "Rules for them: under 14 words, warm, plain British English, no dashes of any kind.",
    "Never give clinical advice, never say whether a treatment is suitable, never mention NHS or private care or plans or schemes or bands, never mention prices, guarantees, reviews or ratings, and never claim to be the best at anything.",
    "",
    "Respond with ONLY the JSON object, no prose and no code fence.",
  ].join("\n");

  const ideal = (input.idealCustomer ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  const user = [
    `Campaign goal: ${goalLabel(input.goal)}`,
    `Ideal patient for this campaign: ${ideal || "not specified"}`,
    `Budget focus: ${budgetLabel(input.targetBudget ?? "any")}`,
    "",
    "Question bank (id | dimension | prompt | options as value=label):",
    renderQuestionBank(),
  ].join("\n");

  return { system, user };
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

export interface ParsedFlowReply {
  entry: string | null;
  nodes: ModelQuestionNode[];
  edges: ModelEdge[];
}

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
function cleanLine(v: unknown): string | undefined {
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
  if (!s || s.length > FLOW_LIMITS.transition) return undefined;
  return s;
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
export function parseFlowReply(text: string): ParsedFlowReply | null {
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

  return { entry: idOf(raw.entry), nodes, edges };
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
 * Wrap the model's questions in the pinned scaffold: welcome in front, contact
 * and the three results behind. This is what makes contact capture structural
 * rather than something the model is trusted to remember.
 */
export function assembleFlowGraph(parsed: ParsedFlowReply, goal: string | null | undefined): FlowGraph | null {
  const scaffold = scaffoldFor(goal);
  if (!scaffold) return null;

  const first =
    parsed.entry && parsed.nodes.some((n) => n.id === parsed.entry) ? parsed.entry : parsed.nodes[0]!.id;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  if (scaffold.welcome) {
    nodes.push(scaffold.welcome);
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

  nodes.push(scaffold.contact, ...scaffold.results);
  edges.push(...scaffold.bandEdges);

  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: scaffold.welcome ? scaffold.welcome.id : first,
    nodes,
    edges,
  };
}

/**
 * Re-pin the scaffold AFTER validation - the generate-run.ts:63-67 move. The
 * assembly above already supplies these nodes, so on any reply that got this far
 * this is a no-op; it stays because "the model cannot touch the contact step or
 * the result copy" should be enforced by the code that returns the graph, not
 * inferred from the code that built it three steps earlier.
 */
export function pinScaffoldNodes(graph: FlowGraph, goal: string | null | undefined): FlowGraph {
  const scaffold = scaffoldFor(goal);
  if (!scaffold) return graph;
  const pinned = new Map<string, FlowNode>();
  if (scaffold.welcome) pinned.set(scaffold.welcome.id, scaffold.welcome);
  pinned.set(scaffold.contact.id, scaffold.contact);
  for (const r of scaffold.results) pinned.set(r.id, r);

  const nodes = graph.nodes.map((n) => pinned.get(n.id) ?? n);
  const edges = [
    ...graph.edges.filter((e) => e.from !== scaffold.contact.id),
    ...scaffold.bandEdges,
  ];
  return { schemaVersion: graph.schemaVersion, entry: graph.entry, nodes, edges };
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
 * invalidated it, which the pin cannot do (it swaps nodes for identical ones and
 * restores the canonical band edges). It exists so that even that impossible path
 * has a failure to quote rather than an empty repair prompt.
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
function vet(text: string, goal: string): Vetted {
  const parsed = parseFlowReply(text);
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

  const pinnedGraph = pinScaffoldNodes(graph, goal);
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
  const { goal, callModel } = input;
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

    const vetted = vet(first.text, goal);
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

    const revetted = vet(second.text, goal);
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
