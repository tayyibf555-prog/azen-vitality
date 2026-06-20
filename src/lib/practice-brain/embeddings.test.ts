import { describe, it, expect } from "vitest";
import { cosineSim, blendRankings } from "./embeddings";
import type { KnowledgeNode, Tier } from "./types";
import type { RankedNode } from "./retrieval";
import type { SemanticScore } from "./embeddings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(p: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n", clientId: "vitality", siteId: null, parentId: null, kind: "item",
    title: "t", body: "b", rawInput: null, tier: 1 as Tier, tags: [],
    source: "manual_note", sourceRef: null, classification: null, status: "active",
    createdBy: null, createdAt: "", updatedAt: "", ...p,
  };
}

function ranked(n: KnowledgeNode, score: number): RankedNode {
  return { node: n, score, snippet: n.body ?? "" };
}

// ---------------------------------------------------------------------------
// cosineSim
// ---------------------------------------------------------------------------

describe("cosineSim", () => {
  it("returns ~1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSim(v, v)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([1, 2], [])).toBe(0);
    expect(cosineSim([], [1, 2])).toBe(0);
  });

  it("returns 0 for zero-magnitude vector", () => {
    expect(cosineSim([0, 0], [1, 2])).toBe(0);
    expect(cosineSim([1, 2], [0, 0])).toBe(0);
  });

  it("handles negative components correctly", () => {
    // [1,0] and [-1,0] are opposite → cosine = -1
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});

// ---------------------------------------------------------------------------
// blendRankings
// ---------------------------------------------------------------------------

describe("blendRankings", () => {
  it("a node strong in both ranks above one strong in only one", () => {
    const strongBoth = node({ id: "both", title: "Strong both", body: "relevant body" });
    const strongKwOnly = node({ id: "kwonly", title: "Keyword only", body: "relevant" });

    const keyword: RankedNode[] = [
      ranked(strongBoth, 10),
      ranked(strongKwOnly, 8),
    ];
    const semantic: SemanticScore[] = [
      { id: "both", score: 0.9 },
      // kwonly missing from semantic → semantic score = 0
    ];
    const nodes = [strongBoth, strongKwOnly];

    const result = blendRankings(keyword, semantic, nodes, 10);
    expect(result[0].node.id).toBe("both");
    expect(result[1].node.id).toBe("kwonly");
  });

  it("respects the limit", () => {
    const ns = Array.from({ length: 10 }, (_, i) =>
      node({ id: `n${i}`, title: `node ${i}`, body: `body ${i}` }),
    );
    const keyword: RankedNode[] = ns.map((n, i) => ranked(n, i + 1));
    const semantic: SemanticScore[] = ns.map((n, i) => ({ id: n.id, score: (i + 1) / 10 }));
    const result = blendRankings(keyword, semantic, ns, 3);
    expect(result).toHaveLength(3);
  });

  it("drops ids not present in nodes", () => {
    const realNode = node({ id: "real" });
    const keyword: RankedNode[] = [ranked(realNode, 5)];
    const semantic: SemanticScore[] = [
      { id: "real", score: 0.8 },
      { id: "ghost", score: 0.9 }, // not in nodes
    ];
    const result = blendRankings(keyword, semantic, [realNode], 10);
    expect(result.map((r) => r.node.id)).toEqual(["real"]);
  });

  it("only includes items (not branches)", () => {
    const item = node({ id: "item", kind: "item" });
    const branch = node({ id: "branch", kind: "branch" });
    const keyword: RankedNode[] = [ranked(item, 5), ranked(branch, 8)];
    const semantic: SemanticScore[] = [
      { id: "item", score: 0.7 },
      { id: "branch", score: 0.9 },
    ];
    const result = blendRankings(keyword, semantic, [item, branch], 10);
    expect(result.map((r) => r.node.id)).toEqual(["item"]);
  });

  it("handles empty keyword list (semantic only)", () => {
    const n1 = node({ id: "a", title: "Alpha" });
    const n2 = node({ id: "b", title: "Beta" });
    const semantic: SemanticScore[] = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.5 },
    ];
    const result = blendRankings([], semantic, [n1, n2], 10);
    expect(result[0].node.id).toBe("a");
    expect(result).toHaveLength(2);
  });

  it("handles empty semantic list (keyword only)", () => {
    const n1 = node({ id: "a", title: "Alpha" });
    const n2 = node({ id: "b", title: "Beta" });
    const keyword: RankedNode[] = [ranked(n1, 10), ranked(n2, 2)];
    const result = blendRankings(keyword, [], [n1, n2], 10);
    expect(result[0].node.id).toBe("a");
    expect(result).toHaveLength(2);
  });

  it("returns empty list when both inputs are empty", () => {
    const result = blendRankings([], [], [], 10);
    expect(result).toHaveLength(0);
  });
});
