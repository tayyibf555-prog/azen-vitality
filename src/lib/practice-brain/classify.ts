import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import type { ClassificationResult, Tier } from "./types";

const CONFIDENCE_THRESHOLD = 0.6;

export function stripEmDash(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .trim();
}

function clampTier(value: unknown): Tier {
  const n = Math.round(Number(value));
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return 4;
}

function firstWords(s: string, n = 6): string {
  const words = s.trim().split(/\s+/).slice(0, n).join(" ");
  return words.length > 0 ? words : "Untitled note";
}

export function buildClassifyPrompt(rawInput: string, branches: string[]) {
  const system = [
    "You are the librarian for a UK dental practice's internal knowledge hub.",
    "Classify the note as ONE JSON object and output nothing else.",
    "Rules:",
    "- Pick the single best branch from the provided list, or propose a new short branch name. Set branchIsNew true only if you propose a new one.",
    "- Assign a sensitivity tier: 1 General (all staff: scripts, public SOPs, pricing), 2 Operational (coordinators and up: internal workflows, follow-up cadences), 3 Management (managers and owner: performance, financials, HR-adjacent), 4 Confidential (owner only: commercials, contracts, strategy).",
    "- If you are unsure of the branch or tier, pick the higher (more restrictive) tier and lower your confidence.",
    "- Write a concise title (max 8 words) and a cleaned body that tidies the note while keeping every fact.",
    "- Use sentence case for the title (capitalise the first word only, plus proper nouns). Do not use Title Case.",
    "- Extract 3 to 8 lowercase tags.",
    "- confidence is your certainty about branch and tier, from 0 to 1.",
    "- Never invent clinical content: no diagnosis, imaging, charting, or treatment decisions. Operations only.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    'Output ONLY: {"branch":"","branchIsNew":false,"title":"","body":"","tier":1,"tags":[],"confidence":0,"reasoning":""}',
  ].join("\n");

  const user = [
    `Existing branches: ${branches.join(", ")}`,
    "",
    "Note:",
    rawInput.trim(),
  ].join("\n");

  return { system, user };
}

export function failClosed(rawInput: string): ClassificationResult {
  return {
    branch: "",
    branchIsNew: false,
    title: stripEmDash(firstWords(rawInput)),
    body: stripEmDash(rawInput.trim()),
    tier: 4,
    tags: [],
    confidence: 0,
    reasoning: "Automatic fallback: classification could not be completed.",
    needsReview: true,
  };
}

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function classifyKnowledge(
  rawInput: string,
  branches: string[],
  client: Anthropic = new Anthropic(),
): Promise<ClassificationResult> {
  if (!rawInput.trim()) throw new Error("empty input");
  const { system, user } = buildClassifyPrompt(rawInput, branches);
  try {
    const msg = await client.messages.create({
      model: SONNET,
      thinking: NO_THINKING,
      // The model echoes the full cleaned body, so a long note needs real headroom;
      // 700 guaranteed truncated JSON (and the old fallback then stored the mangled
      // output as the note). Sonnet 5's tokenizer also runs ~30% larger.
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    });
    // A truncated response is unusable JSON: fail closed to the ORIGINAL note rather
    // than parsing a half-written object.
    if (msg.stop_reason === "max_tokens") return failClosed(rawInput);
    return parseClassification(extractText(msg), rawInput);
  } catch {
    return failClosed(rawInput);
  }
}

/**
 * Parse the classifier's JSON. `rawInput` is the ORIGINAL note: on a parse failure
 * we fall closed to it, NEVER to the model's (possibly truncated/mangled) `text`,
 * so a broken classification can never overwrite the user's note body with garbage.
 * Defaults to `text` only for backward-compatible single-arg callers (tests).
 */
export function parseClassification(text: string, rawInput: string = text): ClassificationResult {
  let raw: Record<string, unknown>;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no json object");
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return failClosed(rawInput);
  }

  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  const lowConfidence = confidence < CONFIDENCE_THRESHOLD || branch.length === 0;
  const tier = lowConfidence ? 4 : clampTier(raw.tier);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()).slice(0, 8)
    : [];

  return {
    branch,
    branchIsNew: raw.branchIsNew === true,
    title: stripEmDash(typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled note"),
    body: stripEmDash(typeof raw.body === "string" ? raw.body : ""),
    tier,
    tags,
    confidence,
    reasoning: typeof raw.reasoning === "string" ? stripEmDash(raw.reasoning) : "",
    needsReview: lowConfidence,
  };
}
