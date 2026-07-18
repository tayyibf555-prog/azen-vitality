import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import type { RankedNode } from "./retrieval";

export interface Citation {
  id: string;
  title: string;
}

export interface CopilotAnswer {
  answer: string;
  citations: Citation[];
  groundedIn: number;
}

function stripEmDash(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .trim();
}

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export function buildAskPrompt(
  question: string,
  ranked: RankedNode[],
): { system: string; user: string } {
  const system = [
    "You are the practice co-pilot for a dental practice knowledge hub.",
    "Answer the staff question USING ONLY the provided knowledge items.",
    "Cite the items you used by their id.",
    "The knowledge items are the practice's own operational expertise: answer in the practice's own voice, do not name or quote the item titles inside your answer text, and never attribute advice to named consultants, programmes, courses or external sources. The citedIds field, not your prose, records which items you used.",
    "If the provided knowledge does not contain the answer, say you do not have it in the brain yet and do not guess.",
    "Never invent clinical content: no diagnosis, imaging, charting, or treatment decisions.",
    "Use no em-dash characters.",
    "Be concise and practical.",
    'Output ONLY JSON: {"answer":"","citedIds":[]}',
  ].join("\n");

  const itemsText = ranked
    .map(
      (r) =>
        `id: ${r.node.id}\ntitle: ${r.node.title}\ncontent: ${r.node.body ?? r.snippet}`,
    )
    .join("\n\n");

  const user = [question, "", itemsText].join("\n");

  return { system, user };
}

export function parseCopilotAnswer(
  text: string,
  ranked: RankedNode[],
): CopilotAnswer {
  const groundedIn = ranked.length;
  const nodeMap = new Map(ranked.map((r) => [r.node.id, r.node.title]));

  let raw: Record<string, unknown>;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no json object");
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {
      answer: stripEmDash(text.trim()),
      citations: [],
      groundedIn,
    };
  }

  const answer = stripEmDash(
    typeof raw.answer === "string" ? raw.answer : text.trim(),
  );

  const citedIds = Array.isArray(raw.citedIds)
    ? raw.citedIds.filter((id): id is string => typeof id === "string")
    : [];

  const citations: Citation[] = citedIds
    .filter((id) => nodeMap.has(id))
    .map((id) => ({ id, title: nodeMap.get(id)! }));

  return { answer, citations, groundedIn };
}

export async function askCopilot(
  question: string,
  ranked: RankedNode[],
  client: Anthropic = new Anthropic(),
): Promise<CopilotAnswer> {
  if (ranked.length === 0) {
    return {
      answer: "I do not have anything about that in the brain yet.",
      citations: [],
      groundedIn: 0,
    };
  }

  const { system, user } = buildAskPrompt(question, ranked);
  try {
    const msg = await client.messages.create({
      model: SONNET,
      thinking: NO_THINKING,
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: user }],
    });
    return parseCopilotAnswer(extractText(msg), ranked);
  } catch {
    return {
      answer: "The co-pilot could not answer just now. Please try again.",
      citations: [],
      groundedIn: ranked.length,
    };
  }
}
