// The AUTHORED FUNNEL GRAPH: the shape a practice owner draws in the funnel
// builder, stored as `smile_assessment_campaign.flow` (jsonb) and walked by the
// deterministic public runtime.
//
// TWO MODES, ONE BANK. The adaptive mode (funnel.ts + /api/smile-assessment/next)
// lets the model pick the next question from the bank one at a time. The
// deterministic mode walks THIS graph instead. Both only ever ask questions that
// exist in quiz.ts, so both score identically through scoreAssessment and neither
// can corrupt a submission.
//
// PURITY + BUNDLE SAFETY. This module deliberately imports NOTHING - in
// particular not ./quiz. The graph references questions by id only, so the
// browser can walk it (flow-runtime.ts) without the question bank, and therefore
// without the OPTION WEIGHTS, ever entering the public bundle. The public payload
// for a question is built server-side in the shape of `questionPayload`
// (src/app/api/smile-assessment/next/route.ts:75-81): { id, prompt, options:
// [{ value, label }] }. Weights are practice IP and the scoring model; they must
// never be published. flow-validate.ts and flow-templates.ts DO import the bank -
// they are owner/server-side only.

// ---------------------------------------------------------------------------
// SCHEMA VERSION. Bumped when the stored shape changes; rule 1 of flow-validate
// rejects a version this build cannot read.
//
// THE BUMP IS NOT THE WHOLE STORY, AND THE OTHER HALF IS WHY THIS IS A SET.
// Rule 1 was `=== FLOW_SCHEMA_VERSION`, which means a bump does not upgrade the
// stored funnels: it INVALIDATES them. Every campaign whose owner drew a funnel
// under v1 would fail rule 1 on the next read, the public page would quietly fall
// back to the adaptive funnel, and nothing anywhere would say so - the exact
// silent failure the rule 10 note rails against. So a version this build can
// still read EXACTLY stays readable, and the set says which those are.
//
// v1 -> v2 is additive and optional: content blocks on the welcome/result screens
// and images on a question's answer cards (A2). Both are cosmetic by
// construction - parseResponses and scoreAssessment never see them - so a v1
// graph IS a v2 graph with none of them, which is what makes it safe to keep
// reading. The reverse is guarded instead of assumed: a graph that USES a v2
// feature while declaring v1 is rejected (rule 1, `schema_version_too_old`),
// because an older deployed reader coerces the unknown keys away and would serve
// that funnel silently stripped of everything the owner added.
// ---------------------------------------------------------------------------

/** The version this build WRITES. */
export const FLOW_SCHEMA_VERSION = 2;

/** The first version allowed to carry content blocks or answer-card images. */
export const FLOW_SCHEMA_VERSION_BLOCKS = 2;

/**
 * Every version this build can read exactly. Rule 1 checks membership, not
 * equality. Removing an entry is a breaking change for every stored funnel on it.
 */
export const SUPPORTED_FLOW_SCHEMA_VERSIONS: readonly number[] = [1, FLOW_SCHEMA_VERSION_BLOCKS];

/**
 * The three result bands. Declared here rather than imported from scoring.ts on
 * purpose: scoring.ts pulls in the weighted question bank, and this module is
 * reachable from the browser (see the bundle-safety note above). Kept in lockstep
 * with `AssessmentBand` in scoring.ts by flow-runtime.test.ts.
 */
export type FlowBand = "high" | "medium" | "low";

export const FLOW_BANDS: readonly FlowBand[] = ["high", "medium", "low"];

export function isFlowBand(value: unknown): value is FlowBand {
  return value === "high" || value === "medium" || value === "low";
}

// ---------------------------------------------------------------------------
// The graph.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CONTENT BLOCKS (A2). Presentational furniture an owner may add to the two
// screens that are not a question: the welcome and the three results.
//
// THEY ARE COSMETIC, AND THAT IS ENFORCED RATHER THAN INTENDED. A block carries
// no id a submission could reference, no option value an edge could route on and
// no weight. walkFlow never reads one; parseResponses (submit/route.ts:91) never
// sees one; scoreAssessment (scoring.ts:64) never sees one. flow-blocks.test.ts
// pins it: the same funnel with and without blocks scores byte-identically.
//
// WHY THE SET IS CLOSED AND SMALL. Every kind here is a thing a practice can
// legitimately say about itself on a page it paid to send traffic to. There is no
// "custom HTML" block and there never will be: this is jsonb an owner types into,
// rendered on a public page, and the moment it can carry markup it can carry a
// script. The four kinds render as four components with typed props.
//
// A TESTIMONIAL IS PRACTICE-ENTERED, NEVER GENERATED. The AI lane may polish the
// grammar of a quote a practice already holds; it may not invent one. That is a
// programme constraint (charter, patient-facing copy) and it is also why every
// string in here goes through the write-time compliance scan in flow-copy.ts -
// including the alt text, which a screen reader reads out loud like any other
// patient-facing sentence.
// ---------------------------------------------------------------------------

export const FLOW_BLOCK_KINDS = ["trust-strip", "testimonial", "faq", "image"] as const;
export type FlowBlockKind = (typeof FLOW_BLOCK_KINDS)[number];

export function isFlowBlockKind(value: unknown): value is FlowBlockKind {
  return typeof value === "string" && (FLOW_BLOCK_KINDS as readonly string[]).includes(value);
}

/** One question-and-answer pair in a faq block. */
export interface FlowFaqItem {
  q: string;
  a: string;
}

export type FlowBlock =
  /** The practice name plus a few short reassurance chips ("Open Saturdays"). */
  | { kind: "trust-strip"; practiceName: string; chips: string[] }
  /** A quote the practice already holds, and who said it. Never AI-invented. */
  | { kind: "testimonial"; quote: string; attribution: string }
  /** The two to six things a patient asks before they will leave a number. */
  | { kind: "faq"; items: FlowFaqItem[] }
  /** A picture from the curated manifest (src/lib/assess/image-library.ts). */
  | { kind: "image"; image: string; alt: string };

/**
 * A picture for one answer card. `value` is an OPTION VALUE of the node's own
 * bank question and `image` is a manifest KEY, never a path or a URL (rule 13).
 *
 * WHY IT HANGS OFF THE NODE AND NOT THE BANK. quiz.ts is the practice IP and it
 * is shared by every campaign on the platform; a picture is a per-funnel
 * authoring choice. Keeping it here also keeps CUT 2 intact - the node still
 * names its question by id and still owns no prompt or label of its own - and it
 * keeps the public question payload (PublicFlowQuestion) exactly the shape the
 * adaptive funnel already sends, so the two modes cannot drift.
 */
export interface FlowOptionImage {
  value: string;
  image: string;
}

export type FlowNode =
  | { id: string; kind: "welcome"; headline?: string; intro?: string; blocks?: FlowBlock[] }
  | {
      id: string;
      kind: "question";
      questionId: string;
      transition?: string;
      optionImages?: FlowOptionImage[];
    }
  | { id: string; kind: "contact" }
  | { id: string; kind: "outcome"; band: FlowBand; headline?: string; blocks?: FlowBlock[] };

export type FlowNodeKind = FlowNode["kind"];

/** The node kinds a content block may sit on. Rule 12 enforces it. */
export const FLOW_BLOCK_SCREEN_KINDS: readonly FlowNodeKind[] = ["welcome", "outcome"];

/**
 * Blocks belong to the screens that are not an ask. A question screen's job is one
 * question, and a wall of furniture under it is the drop-off. The contact screen's
 * job is the form, and anything else on it is a reason not to fill it in.
 */
export function acceptsBlocks(kind: FlowNodeKind): boolean {
  return FLOW_BLOCK_SCREEN_KINDS.includes(kind);
}

/** The blocks on a node, or an empty list for a kind that cannot carry any. */
export function blocksOf(node: FlowNode): FlowBlock[] {
  return node.kind === "welcome" || node.kind === "outcome" ? (node.blocks ?? []) : [];
}

/** The answer-card pictures on a node, or an empty list. */
export function optionImagesOf(node: FlowNode): FlowOptionImage[] {
  return node.kind === "question" ? (node.optionImages ?? []) : [];
}

/**
 * EVERY AUTHORED STRING IN ONE BLOCK, with the field path an owner can find it by
 * and the cap it must fit. THE one list, deliberately: three modules need to know
 * what strings a block carries and they must never disagree about it.
 *
 *   flow-validate.ts (rule 12) - is each one present and within its cap?
 *   flow-copy.ts               - scan each one for non-compliant wording.
 *   flow-generate.ts           - drop a block whose wording did not pass.
 *
 * A new field on a block kind that is not added here is a field that renders to a
 * patient unscanned and uncapped. That is why this lives in flow.ts, next to the
 * type it describes, rather than in whichever module needed it first. The picture
 * REFERENCE is not in the list on purpose: a manifest key is not copy, and rule 13
 * holds it to the manifest instead.
 */
export function blockCopyFields(block: FlowBlock): { field: string; text: string; max: number }[] {
  switch (block.kind) {
    case "trust-strip":
      return [
        { field: "practiceName", text: block.practiceName, max: FLOW_LIMITS.practiceName },
        ...block.chips.map((c, i) => ({ field: `chips[${i}]`, text: c, max: FLOW_LIMITS.chipLabel })),
      ];
    case "testimonial":
      return [
        { field: "quote", text: block.quote, max: FLOW_LIMITS.quote },
        { field: "attribution", text: block.attribution, max: FLOW_LIMITS.attribution },
      ];
    case "faq":
      return block.items.flatMap((item, i) => [
        { field: `items[${i}].q`, text: item.q, max: FLOW_LIMITS.faqQuestion },
        { field: `items[${i}].a`, text: item.a, max: FLOW_LIMITS.faqAnswer },
      ]);
    case "image":
      return [{ field: "alt", text: block.alt, max: FLOW_LIMITS.imageAlt }];
    default:
      // Unreachable for a typed block. It is here so that a cast-in or hostile
      // block makes a caller say no, rather than throw on the way to saying it.
      return [];
  }
}

/** Does this graph use anything that needs FLOW_SCHEMA_VERSION_BLOCKS? */
export function flowUsesV2Content(graph: FlowGraph): boolean {
  return graph.nodes.some((n) => blocksOf(n).length > 0 || optionImagesOf(n).length > 0);
}

/** The lowest schema version that can honestly describe this graph. */
export function requiredFlowSchemaVersion(graph: FlowGraph): number {
  return flowUsesV2Content(graph) ? FLOW_SCHEMA_VERSION_BLOCKS : 1;
}

/**
 * The graph with a schemaVersion that can carry its content. Editors that ADD a
 * block or an answer-card picture must run their result through this, or rule 1
 * refuses the save (`schema_version_too_old`).
 *
 * NEVER DOWNGRADES. Removing the last block from a v2 funnel does not make it a v1
 * funnel again: the version records what a reader must understand to have read
 * this row correctly, and walking it backwards would flip a stored value back and
 * forth on every edit for no gain.
 */
export function withRequiredSchemaVersion(graph: FlowGraph): FlowGraph {
  const wanted = Math.max(graph.schemaVersion, requiredFlowSchemaVersion(graph));
  return wanted === graph.schemaVersion ? graph : { ...graph, schemaVersion: wanted };
}

export interface FlowEdge {
  from: string;
  to: string;
  /**
   * What routes a patient down this edge, or null for the default/else edge.
   *
   * - From a `question` node: an OPTION VALUE of that question (quiz.ts).
   * - From the `contact` node: a BAND ("high" | "medium" | "low"). This is the
   *   only way a graph can satisfy all of "one contact node", "contact before
   *   every outcome" and "all three bands present, none orphaned" at once (rules
   *   6, 7 and 5 of flow-validate.ts). The band is decided SERVER-SIDE by
   *   scoreAssessment after submit; it is never a patient answer.
   * - From a `welcome` node: always null (nothing has been answered yet).
   */
  answer: string | null;
  /**
   * Optional warm lead-in shown when the patient arrives at `to` VIA THIS EDGE,
   * i.e. tailored to the answer just given. Overrides the destination question
   * node's own `transition`. Patient-facing copy: compliance-scanned at WRITE
   * time (see the tripwire below).
   */
  transition?: string;
}

export interface FlowGraph {
  schemaVersion: number;
  entry: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---------------------------------------------------------------------------
// DELIBERATE v1 CUTS. Each is a load-bearing constraint, not an oversight. The
// tripwire named in each comment is the thing that breaks if the cut is undone.
// ---------------------------------------------------------------------------
//
// CUT 1 - NO MULTI-CHOICE. Every answer is a single option value.
//   TRIPWIRE: the whole stack is single-select and typed for it -
//   `responses: Record<string, string>` (types.ts:25), `ResponseRow.responses`
//   (repository.ts:23), `parseResponses` (api/smile-assessment/submit/route.ts:95)
//   and `scoreAssessment` (scoring.ts:70). Multi-choice changes the DB contract
//   AND the scoring model (what is the denominator for a question answered
//   twice?). It is a schema change, not a builder feature.
//
// CUT 2 - NO CUSTOM QUESTIONS AND NO PROMPT/OPTION OVERRIDES. A question node
//   carries an id and nothing else.
//   TRIPWIRE: area16-18-patient-copy-jargon.test.ts:26-31 walks QUIZ_QUESTIONS to
//   prove no NHS/private jargon reaches a patient. An authored prompt or option
//   label bypasses that walk entirely. Worse, a custom question would be silently
//   dropped by parseResponses (submit/route.ts:95) and ignored by scoreAssessment
//   (scoring.ts:70-77): the funnel would LOOK like it worked and score wrong, with
//   no error anywhere. Referencing the bank makes both failures structurally
//   impossible.
//
// CUT 3 - AUTHORED COPY IS SCANNED AT WRITE TIME. `question.transition`,
//   `edge.transition`, `outcome.headline`, `welcome.headline`, `welcome.intro`
//   and every string inside a content block are the only free text an owner (or
//   the generator) can put in front of a patient here.
//   TRIPWIRE: they never pass through QUIZ_QUESTIONS, so the jargon walk above
//   cannot see them. The write path MUST run scanBannedText
//   (src/lib/landing/compliance.ts) plus the NHS/private regexes over every one of
//   them before the row is stored. Read-time coercion below caps their length; it
//   does NOT and cannot judge their content. collectFlowCopy (flow-copy.ts) is the
//   list of what gets scanned, and adding an authored string anywhere in this file
//   without adding it there ships that string unscanned.
//
// CUT 4 - A PICTURE IS A KEY, NOT A URL. Block images and answer-card images
//   store a key into the curated manifest (src/lib/assess/image-library.ts).
//   TRIPWIRE: a URL field on a public, owner-authored, ad-destination page is an
//   arbitrary third-party request from a page a practice paid to send traffic to,
//   and no length cap or regex makes that safe. Keys make it structurally
//   impossible: nothing shaped like a URL is in the manifest, so nothing shaped
//   like a URL resolves, so nothing shaped like a URL renders. Rule 13 rejects an
//   unknown key at write time.

/** Caps applied by normaliseFlow. Authored copy is short by design. */
export const FLOW_LIMITS = {
  nodeId: 64,
  questionId: 64,
  headline: 90,
  intro: 240,
  transition: 140,
  nodes: 60,
  edges: 200,
  // --- content blocks (A2) -------------------------------------------------
  // Counts are caps here and MINIMUMS in rule 12: coercion is about shape, the
  // rules are about meaning, and "a faq with one question is not a faq" is
  // meaning. Lengths are deliberately tight - these render as chips, a pull quote
  // and an accordion on a phone, and copy that overflows them is copy that was
  // written for a different surface.
  blocksPerNode: 4,
  practiceName: 60,
  chipLabel: 28,
  chips: 6,
  quote: 240,
  attribution: 60,
  faqQuestion: 90,
  faqAnswer: 240,
  faqItems: 6,
  imageRef: 64,
  imageAlt: 120,
  /** Answer-card pictures on one question. The longest bank question has 8 options. */
  optionImages: 12,
} as const;

// ---------------------------------------------------------------------------
// Coercion. Mirrors normaliseFormConfig (src/lib/onboarding/form.ts:75) - the
// house pattern for "an owner-authored jsonb config behind a public slug" - with
// ONE deliberate difference, spelled out because it matters:
//
//   normaliseFormConfig REPAIRS to an empty-but-valid config, because an
//   onboarding form with no extra questions is still a usable form.
//
//   normaliseFlow is ALL-OR-NOTHING. A partially repaired graph is a BROKEN QUIZ:
//   silently dropping one malformed node can remove the funding question and cap
//   every lead at "medium" (scoring.ts:98-105), so the practice quietly gets zero
//   fast-tracked leads. Anything it cannot read exactly, it refuses - the caller
//   then falls back to the adaptive funnel, which always works. Loud failure, and
//   a working quiz either way.
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A required, non-empty, length-capped string. null = unusable. */
function reqStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

/**
 * An optional string. `{ ok: false }` = present but unusable (wrong type or over
 * the cap) which fails the whole graph; a blank string normalises to ABSENT, so a
 * cleared field can never render as an empty line.
 */
function optStr(v: unknown, max: number): { ok: true; value?: string } | { ok: false } {
  if (v === undefined || v === null) return { ok: true };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim();
  if (!s) return { ok: true };
  if (s.length > max) return { ok: false };
  return { ok: true, value: s };
}

/** A required list of non-empty, length-capped strings. null = unusable. */
function reqStrList(v: unknown, maxCount: number, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxCount) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = reqStr(item, maxLen);
    if (!s) return null; // a blank chip is a hole in the row of chips
    out.push(s);
  }
  return out;
}

/**
 * One block, or null when it cannot be read exactly. Note what is NOT checked
 * here: that there are at least two faq items, at least one chip, or that an
 * image key is in the manifest. Those are rules (12 and 13), they carry a message
 * an owner can act on, and validateFlow reports all of them at once.
 */
function normaliseBlock(raw: unknown): FlowBlock | null {
  if (!isObj(raw)) return null;
  switch (raw.kind) {
    case "trust-strip": {
      const practiceName = reqStr(raw.practiceName, FLOW_LIMITS.practiceName);
      const chips = reqStrList(raw.chips, FLOW_LIMITS.chips, FLOW_LIMITS.chipLabel);
      if (!practiceName || !chips) return null;
      return { kind: "trust-strip", practiceName, chips };
    }
    case "testimonial": {
      const quote = reqStr(raw.quote, FLOW_LIMITS.quote);
      const attribution = reqStr(raw.attribution, FLOW_LIMITS.attribution);
      if (!quote || !attribution) return null;
      return { kind: "testimonial", quote, attribution };
    }
    case "faq": {
      if (!Array.isArray(raw.items) || raw.items.length > FLOW_LIMITS.faqItems) return null;
      const items: FlowFaqItem[] = [];
      for (const it of raw.items) {
        if (!isObj(it)) return null;
        const q = reqStr(it.q, FLOW_LIMITS.faqQuestion);
        const a = reqStr(it.a, FLOW_LIMITS.faqAnswer);
        if (!q || !a) return null;
        items.push({ q, a });
      }
      return { kind: "faq", items };
    }
    case "image": {
      const image = reqStr(raw.image, FLOW_LIMITS.imageRef);
      const alt = reqStr(raw.alt, FLOW_LIMITS.imageAlt);
      if (!image || !alt) return null;
      return { kind: "image", image, alt };
    }
    default:
      return null;
  }
}

type OptBlocks = { ok: true; value?: FlowBlock[] } | { ok: false };

/** Optional blocks on a screen that may carry them. Empty normalises to ABSENT. */
function optBlocks(v: unknown): OptBlocks {
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v) || v.length > FLOW_LIMITS.blocksPerNode) return { ok: false };
  if (v.length === 0) return { ok: true };
  const out: FlowBlock[] = [];
  for (const b of v) {
    const block = normaliseBlock(b);
    if (!block) return { ok: false };
    out.push(block);
  }
  return { ok: true, value: out };
}

type OptOptionImages = { ok: true; value?: FlowOptionImage[] } | { ok: false };

function optOptionImages(v: unknown): OptOptionImages {
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v) || v.length > FLOW_LIMITS.optionImages) return { ok: false };
  if (v.length === 0) return { ok: true };
  const out: FlowOptionImage[] = [];
  for (const raw of v) {
    if (!isObj(raw)) return { ok: false };
    const value = reqStr(raw.value, FLOW_LIMITS.questionId);
    const image = reqStr(raw.image, FLOW_LIMITS.imageRef);
    if (!value || !image) return { ok: false };
    out.push({ value, image });
  }
  return { ok: true, value: out };
}

/**
 * A v2 property carrying CONTENT while sitting on a node kind that cannot render
 * it. REFUSED rather than dropped, per the all-or-nothing doctrine above:
 * silently discarding an owner's furniture is the failure mode where the save
 * says "done" and the screen comes back empty. Rule 12 says the same thing with a
 * better message for a graph that never went through here (the builder holds one
 * in memory).
 *
 * An EMPTY array is not misplaced content, it is no content, so it normalises to
 * absent like every other cleared field here. A builder that initialises the key
 * on every node it touches must not be able to brick an otherwise perfect save
 * over a pair of empty brackets.
 */
function misplaced(raw: Record<string, unknown>, key: string): boolean {
  const v = raw[key];
  if (v === undefined || v === null) return false;
  return !Array.isArray(v) || v.length > 0;
}

function normaliseNode(raw: unknown): FlowNode | null {
  if (!isObj(raw)) return null;
  const id = reqStr(raw.id, FLOW_LIMITS.nodeId);
  if (!id) return null;

  switch (raw.kind) {
    case "welcome": {
      const headline = optStr(raw.headline, FLOW_LIMITS.headline);
      const intro = optStr(raw.intro, FLOW_LIMITS.intro);
      const blocks = optBlocks(raw.blocks);
      if (!headline.ok || !intro.ok || !blocks.ok) return null;
      if (misplaced(raw, "optionImages")) return null;
      const node: FlowNode = { id, kind: "welcome" };
      if (headline.value) node.headline = headline.value;
      if (intro.value) node.intro = intro.value;
      if (blocks.value) node.blocks = blocks.value;
      return node;
    }
    case "question": {
      const questionId = reqStr(raw.questionId, FLOW_LIMITS.questionId);
      if (!questionId) return null;
      const transition = optStr(raw.transition, FLOW_LIMITS.transition);
      const optionImages = optOptionImages(raw.optionImages);
      if (!transition.ok || !optionImages.ok) return null;
      if (misplaced(raw, "blocks")) return null;
      const node: FlowNode = { id, kind: "question", questionId };
      if (transition.value) node.transition = transition.value;
      if (optionImages.value) node.optionImages = optionImages.value;
      return node;
    }
    case "contact":
      if (misplaced(raw, "blocks") || misplaced(raw, "optionImages")) return null;
      return { id, kind: "contact" };
    case "outcome": {
      if (!isFlowBand(raw.band)) return null;
      const headline = optStr(raw.headline, FLOW_LIMITS.headline);
      const blocks = optBlocks(raw.blocks);
      if (!headline.ok || !blocks.ok) return null;
      if (misplaced(raw, "optionImages")) return null;
      const node: FlowNode = { id, kind: "outcome", band: raw.band };
      if (headline.value) node.headline = headline.value;
      if (blocks.value) node.blocks = blocks.value;
      return node;
    }
    default:
      return null;
  }
}

function normaliseEdge(raw: unknown): FlowEdge | null {
  if (!isObj(raw)) return null;
  const from = reqStr(raw.from, FLOW_LIMITS.nodeId);
  const to = reqStr(raw.to, FLOW_LIMITS.nodeId);
  if (!from || !to) return null;
  // A missing `answer` reads as the default edge: the generator omitting the key
  // is common and harmless, because coverage is still checked by rule 3.
  let answer: string | null = null;
  if (raw.answer !== undefined && raw.answer !== null) {
    answer = reqStr(raw.answer, FLOW_LIMITS.questionId);
    if (answer === null) return null;
  }
  const transition = optStr(raw.transition, FLOW_LIMITS.transition);
  if (!transition.ok) return null;
  const edge: FlowEdge = { from, to, answer };
  if (transition.value) edge.transition = transition.value;
  return edge;
}

/**
 * Coerce a stored (or model-produced) blob into a FlowGraph, or null when it
 * cannot be read exactly. Returns a FRESH object, so a caller can never mutate
 * the stored value through it.
 *
 * Note what this does NOT do: it does not check schemaVersion against
 * FLOW_SCHEMA_VERSION, that a question id is in the bank, or that the routing
 * makes sense. Those are RULES, and rules belong to validateFlow, which reports
 * every one of them at once so the AI repair pass can quote them back. This
 * function is only about SHAPE.
 */
export function normaliseFlow(raw: unknown): FlowGraph | null {
  if (!isObj(raw)) return null;
  if (typeof raw.schemaVersion !== "number" || !Number.isFinite(raw.schemaVersion)) return null;
  const entry = reqStr(raw.entry, FLOW_LIMITS.nodeId);
  if (!entry) return null;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  if (raw.nodes.length === 0 || raw.nodes.length > FLOW_LIMITS.nodes) return null;
  if (raw.edges.length > FLOW_LIMITS.edges) return null;

  const nodes: FlowNode[] = [];
  for (const n of raw.nodes) {
    const node = normaliseNode(n);
    if (!node) return null;
    nodes.push(node);
  }
  const edges: FlowEdge[] = [];
  for (const e of raw.edges) {
    const edge = normaliseEdge(e);
    if (!edge) return null;
    edges.push(edge);
  }
  return { schemaVersion: raw.schemaVersion, entry, nodes, edges };
}

// ---------------------------------------------------------------------------
// Tiny shared accessors (used by validate, the runtime and the builder UI).
// ---------------------------------------------------------------------------

export function nodeMap(graph: FlowGraph): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const n of graph.nodes) {
    if (!map.has(n.id)) map.set(n.id, n); // first wins; duplicates are a rule-1 failure
  }
  return map;
}

/** Outgoing edges in DECLARATION ORDER, which is what makes the walk deterministic. */
export function edgesFrom(graph: FlowGraph, nodeId: string): FlowEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

export function nodesOfKind<K extends FlowNodeKind>(
  graph: FlowGraph,
  kind: K,
): Extract<FlowNode, { kind: K }>[] {
  return graph.nodes.filter((n): n is Extract<FlowNode, { kind: K }> => n.kind === kind);
}

// ---------------------------------------------------------------------------
// DEEP COPIES. `{ ...node }` was enough while every field was a string: it is not
// any more. A shallow copy of a welcome node shares its `blocks` ARRAY with the
// original, so the "fresh graph, nothing downstream can mutate the campaign row's
// copy" promise made by toPublicFlow (campaign.ts:278) and by the builder's edit
// helpers would be quietly false for exactly the new fields.
// ---------------------------------------------------------------------------

export function cloneFlowBlock(b: FlowBlock): FlowBlock {
  switch (b.kind) {
    case "trust-strip":
      return { kind: "trust-strip", practiceName: b.practiceName, chips: [...b.chips] };
    case "testimonial":
      return { kind: "testimonial", quote: b.quote, attribution: b.attribution };
    case "faq":
      return { kind: "faq", items: b.items.map((i) => ({ q: i.q, a: i.a })) };
    case "image":
      return { kind: "image", image: b.image, alt: b.alt };
  }
}

export function cloneFlowNode(node: FlowNode): FlowNode {
  switch (node.kind) {
    case "welcome": {
      const copy = { ...node };
      if (node.blocks) copy.blocks = node.blocks.map(cloneFlowBlock);
      return copy;
    }
    case "outcome": {
      const copy = { ...node };
      if (node.blocks) copy.blocks = node.blocks.map(cloneFlowBlock);
      return copy;
    }
    case "question": {
      const copy = { ...node };
      if (node.optionImages) {
        copy.optionImages = node.optionImages.map((o) => ({ value: o.value, image: o.image }));
      }
      return copy;
    }
    case "contact":
      return { ...node };
  }
}

/** A graph nothing downstream shares a reference with. */
export function cloneFlowGraph(graph: FlowGraph): FlowGraph {
  return {
    schemaVersion: graph.schemaVersion,
    entry: graph.entry,
    nodes: graph.nodes.map(cloneFlowNode),
    edges: graph.edges.map((e) => ({ ...e })),
  };
}
