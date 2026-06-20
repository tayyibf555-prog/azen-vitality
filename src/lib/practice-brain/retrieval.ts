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
import {
  isSemanticEnabled,
  embed,
  cosineSim,
  blendRankings,
  snippetFor as snippetForImpl,
} from "./embeddings";
import type { SemanticScore } from "./embeddings";

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

/**
 * A short body excerpt centred on the first query term, for showing alongside an answer.
 * Re-exported from embeddings.ts (canonical location) to avoid a circular import.
 */
export function snippetFor(node: KnowledgeNode, queryTokens: string[], len = 180): string {
  return snippetForImpl(node, queryTokens, len);
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
      return { node: n, score, snippet: snippetForImpl(n, q) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title))
    .slice(0, limit);
}

/** Clearance-filtered retrieval: load active nodes, drop above-tier, rank, return top-K.
 *
 * Keyword path (default — no VOYAGE_API_KEY): byte-for-byte identical to Phase 1–4.
 * Semantic path (VOYAGE_API_KEY present): blends keyword + cosine similarity rankings.
 * If embedding the query fails for any reason, falls back transparently to keyword-only.
 */
export async function searchKnowledge(
  clientId: string,
  query: string,
  maxTier: Tier,
  limit = 6,
): Promise<RankedNode[]> {
  const all = await listActiveNodes(clientId);
  const visible = visibleNodes(all, maxTier);

  // Keyword-only path: no VOYAGE_API_KEY — unchanged from pre-Phase 5.
  if (!isSemanticEnabled()) {
    return rankNodes(query, visible, limit);
  }

  // Semantic path: embed the query and blend with keyword rankings.
  const qvec = await embed(query);
  if (!qvec) {
    // Embedding failed (network error, bad response, etc.) — graceful keyword fallback.
    return rankNodes(query, visible, limit);
  }

  // Compute cosine similarity for every item node that has a stored embedding vector.
  const semanticScores: SemanticScore[] = visible
    .filter((n) => n.kind === "item" && Array.isArray(n.embedding) && (n.embedding as number[]).length > 0)
    .map((n) => ({
      id: n.id,
      score: cosineSim(qvec, n.embedding as number[]),
    }));

  // Blend: keyword ranked with 2× limit headroom so blend has enough candidates.
  return blendRankings(rankNodes(query, visible, limit * 2), semanticScores, visible, limit);
}
