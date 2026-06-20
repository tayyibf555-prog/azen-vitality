/**
 * Practice Brain retrieval core (Phase 1 of the self-learning co-pilot).
 *
 * Keyword ranking over the knowledge tree. The co-pilot is only ever handed nodes the asker
 * is cleared for: `searchKnowledge` applies the deterministic clearance filter BEFORE ranking,
 * so retrieval is the security boundary (the LLM never sees above-tier knowledge).
 *
 * Pilot scale (hundreds of nodes) ranks fine in memory, which keeps the ranker pure and
 * unit-testable. A Postgres full-text / pgvector path replaces this transparently in Phase 5.
 */

import type { KnowledgeNode, Tier } from "./types";
import { visibleNodes } from "./clearance";
import { listActiveNodes } from "./repository";

export interface RankedNode {
  node: KnowledgeNode;
  score: number;
  snippet: string;
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "for", "with",
  "how", "do", "does", "i", "we", "you", "what", "when", "where", "why", "our", "my",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/** A short body excerpt centred on the first query term, for showing alongside an answer. */
export function snippetFor(node: KnowledgeNode, queryTokens: string[], len = 180): string {
  const body = node.body ?? "";
  if (!body) return node.title;
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) {
    return body.slice(0, len).trim() + (body.length > len ? "..." : "");
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, start + len);
  return (start > 0 ? "..." : "") + body.slice(start, end).trim() + (end < body.length ? "..." : "");
}

/** Pure keyword ranker. Items only (branches are structure, not answerable knowledge). */
export function rankNodes(query: string, nodes: KnowledgeNode[], limit = 6): RankedNode[] {
  const q = tokenize(query);
  if (q.length === 0) return [];
  return nodes
    .filter((n) => n.kind === "item")
    .map((n) => {
      const title = (n.title ?? "").toLowerCase();
      const body = (n.body ?? "").toLowerCase();
      const tags = n.tags.map((t) => t.toLowerCase());
      let score = 0;
      for (const t of q) {
        if (title.includes(t)) score += 5;
        if (tags.includes(t)) score += 3;
        score += Math.min(body.split(t).length - 1, 3);
      }
      return { node: n, score, snippet: snippetFor(n, q) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title))
    .slice(0, limit);
}

/** Clearance-filtered retrieval: load active nodes, drop above-tier, rank, return top-K. */
export async function searchKnowledge(
  clientId: string,
  query: string,
  maxTier: Tier,
  limit = 6,
): Promise<RankedNode[]> {
  const all = await listActiveNodes(clientId);
  return rankNodes(query, visibleNodes(all, maxTier), limit);
}
