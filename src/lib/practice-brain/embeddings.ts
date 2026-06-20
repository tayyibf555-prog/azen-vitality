/**
 * Practice Brain — semantic (embedding) layer (Phase 5).
 *
 * All code in this file is guarded behind `isSemanticEnabled()`.
 * When VOYAGE_API_KEY is absent, every function is a no-op / returns null,
 * and the retrieval path is byte-for-byte identical to keyword-only (Phase 1–4).
 *
 * Activation: set VOYAGE_API_KEY=<key> in the environment. No other changes needed.
 *
 * NOTE: snippetFor lives here (rather than retrieval.ts) so that blendRankings
 * can call it without creating a circular import cycle.  retrieval.ts re-exports it.
 */

import type { KnowledgeNode } from "./types";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** True only when a Voyage API key is present. All semantic paths check this first. */
export function isSemanticEnabled(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

// ---------------------------------------------------------------------------
// Snippet helper (shared with retrieval.ts via re-export)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RankedNode type (imported from retrieval in consumers; defined inline here
// to avoid a circular dep — this is the canonical shape both modules share).
// ---------------------------------------------------------------------------

export interface RankedNode {
  node: KnowledgeNode;
  score: number;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Pure math — unit-tested, no I/O
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * Returns 0 for empty vectors, mismatched lengths, or zero-magnitude inputs.
 */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface SemanticScore {
  id: string;
  score: number;
}

/**
 * Blend keyword and semantic rankings into a single ranked list.
 *
 * Both score lists are min-max normalised to 0..1 independently.
 * For every node id appearing in either list: combined = 0.5*kw + 0.5*sem (missing side = 0).
 * Nodes not found in `nodes` or whose kind ≠ "item" are dropped.
 * Returns the top-`limit` results sorted descending by combined score.
 *
 * Pure — no I/O, unit-tested.
 */
export function blendRankings(
  keyword: RankedNode[],
  semantic: SemanticScore[],
  nodes: KnowledgeNode[],
  limit: number,
): RankedNode[] {
  const nodeById = new Map<string, KnowledgeNode>(nodes.map((n) => [n.id, n]));

  // Min-max normalise keyword scores.
  const kwMin = keyword.length > 0 ? Math.min(...keyword.map((r) => r.score)) : 0;
  const kwMax = keyword.length > 0 ? Math.max(...keyword.map((r) => r.score)) : 0;
  const kwRange = kwMax - kwMin || 1;
  const kwNorm = new Map<string, number>(
    keyword.map((r) => [r.node.id, (r.score - kwMin) / kwRange]),
  );

  // Min-max normalise semantic scores.
  const semMin = semantic.length > 0 ? Math.min(...semantic.map((s) => s.score)) : 0;
  const semMax = semantic.length > 0 ? Math.max(...semantic.map((s) => s.score)) : 0;
  const semRange = semMax - semMin || 1;
  const semNorm = new Map<string, number>(
    semantic.map((s) => [s.id, (s.score - semMin) / semRange]),
  );

  // Union of all ids from both lists.
  const allIds = new Set<string>([
    ...keyword.map((r) => r.node.id),
    ...semantic.map((s) => s.id),
  ]);

  // Derive query tokens from keyword snippet text for snippet generation in blended results.
  // We extract tokens from the first keyword snippet to approximate the original query terms.
  const queryTokens = keyword.length > 0
    ? keyword[0].snippet.toLowerCase().match(/[a-z0-9]+/g) ?? []
    : [];

  const results: RankedNode[] = [];
  for (const id of allIds) {
    const n = nodeById.get(id);
    if (!n || n.kind !== "item") continue;
    const kw = kwNorm.get(id) ?? 0;
    const sem = semNorm.get(id) ?? 0;
    const combined = 0.5 * kw + 0.5 * sem;
    results.push({ node: n, score: combined, snippet: snippetFor(n, queryTokens) });
  }

  return results
    .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Network — embed via Voyage AI
// ---------------------------------------------------------------------------

/**
 * Embed a single text using the Voyage AI embeddings API.
 * Returns null (never throws) when:
 * - Semantic is disabled (no VOYAGE_API_KEY)
 * - Any network or parse error occurs
 *
 * Semantic retrieval is best-effort — a null result always falls back to keyword.
 */
export async function embed(text: string | null | undefined): Promise<number[] | null> {
  if (!isSemanticEnabled()) return null;
  if (!text) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ input: text, model: "voyage-3.5" }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data: { embedding: number[] }[] };
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) return null;
    return vec as number[];
  } catch {
    return null;
  }
}
