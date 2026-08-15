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

/** Bumped when the stored shape changes. Rule 1 of flow-validate rejects a mismatch. */
export const FLOW_SCHEMA_VERSION = 1;

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

export type FlowNode =
  | { id: string; kind: "welcome"; headline?: string; intro?: string }
  | { id: string; kind: "question"; questionId: string; transition?: string }
  | { id: string; kind: "contact" }
  | { id: string; kind: "outcome"; band: FlowBand; headline?: string };

export type FlowNodeKind = FlowNode["kind"];

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
//   `edge.transition`, `outcome.headline`, `welcome.headline` and `welcome.intro`
//   are the only free text an owner (or the generator) can put in front of a
//   patient here.
//   TRIPWIRE: they never pass through QUIZ_QUESTIONS, so the jargon walk above
//   cannot see them. The write path MUST run scanBannedText
//   (src/lib/landing/compliance.ts) plus the NHS/private regexes over every one of
//   them before the row is stored. Read-time coercion below caps their length; it
//   does NOT and cannot judge their content.

/** Caps applied by normaliseFlow. Authored copy is short by design. */
export const FLOW_LIMITS = {
  nodeId: 64,
  questionId: 64,
  headline: 90,
  intro: 240,
  transition: 140,
  nodes: 60,
  edges: 200,
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

function normaliseNode(raw: unknown): FlowNode | null {
  if (!isObj(raw)) return null;
  const id = reqStr(raw.id, FLOW_LIMITS.nodeId);
  if (!id) return null;

  switch (raw.kind) {
    case "welcome": {
      const headline = optStr(raw.headline, FLOW_LIMITS.headline);
      const intro = optStr(raw.intro, FLOW_LIMITS.intro);
      if (!headline.ok || !intro.ok) return null;
      const node: FlowNode = { id, kind: "welcome" };
      if (headline.value) node.headline = headline.value;
      if (intro.value) node.intro = intro.value;
      return node;
    }
    case "question": {
      const questionId = reqStr(raw.questionId, FLOW_LIMITS.questionId);
      if (!questionId) return null;
      const transition = optStr(raw.transition, FLOW_LIMITS.transition);
      if (!transition.ok) return null;
      const node: FlowNode = { id, kind: "question", questionId };
      if (transition.value) node.transition = transition.value;
      return node;
    }
    case "contact":
      return { id, kind: "contact" };
    case "outcome": {
      if (!isFlowBand(raw.band)) return null;
      const headline = optStr(raw.headline, FLOW_LIMITS.headline);
      if (!headline.ok) return null;
      const node: FlowNode = { id, kind: "outcome", band: raw.band };
      if (headline.value) node.headline = headline.value;
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
