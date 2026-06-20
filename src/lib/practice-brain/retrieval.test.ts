import { describe, it, expect } from "vitest";
import { rankNodes, snippetFor } from "./retrieval";
import type { KnowledgeNode, Tier } from "./types";

function node(p: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n", clientId: "vitality", siteId: null, parentId: "h", kind: "item",
    title: "t", body: "b", rawInput: null, tier: 1 as Tier, tags: [],
    source: "manual_note", sourceRef: null, classification: null, status: "active",
    createdBy: null, createdAt: "", updatedAt: "", ...p,
  };
}

describe("rankNodes", () => {
  it("returns nothing for an empty or stopword-only query", () => {
    expect(rankNodes("", [node({})])).toEqual([]);
    expect(rankNodes("the a of", [node({})])).toEqual([]);
  });

  it("ranks a title match above a body-only match", () => {
    const titled = node({ id: "titled", title: "Implant consent script", body: "general note" });
    const bodied = node({ id: "bodied", title: "General note", body: "mentions implant once" });
    const r = rankNodes("implant", [bodied, titled]);
    expect(r[0].node.id).toBe("titled");
  });

  it("boosts tag overlap", () => {
    const tagged = node({ id: "tagged", title: "Note A", body: "x", tags: ["refunds"] });
    const plain = node({ id: "plain", title: "Note B", body: "x" });
    const r = rankNodes("refunds", [plain, tagged]);
    expect(r[0].node.id).toBe("tagged");
  });

  it("only ranks items, never branches", () => {
    const branch = node({ id: "br", kind: "branch", title: "Implants", body: null });
    const item = node({ id: "it", kind: "item", title: "Implant aftercare" });
    const r = rankNodes("implant", [branch, item]);
    expect(r.map((x) => x.node.id)).toEqual(["it"]);
  });

  it("respects the limit", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node({ id: `n${i}`, title: `refund policy ${i}` }));
    expect(rankNodes("refund", nodes, 3)).toHaveLength(3);
  });

  it("attaches a snippet containing the term", () => {
    const n = node({ title: "Refund policy", body: "Refunds are processed within 14 days of request." });
    const r = rankNodes("refund", [n]);
    expect(r[0].snippet.toLowerCase()).toContain("refund");
  });
});

describe("snippetFor", () => {
  it("windows around the first query term", () => {
    const n = node({ body: "Intro filler text. The autoclave must be run nightly and logged. Outro." });
    const s = snippetFor(n, ["autoclave"], 60);
    expect(s.toLowerCase()).toContain("autoclave");
    expect(s.length).toBeLessThanOrEqual(70);
  });

  it("falls back to the body start when no term hits", () => {
    const n = node({ body: "Some body text here." });
    expect(snippetFor(n, ["zzz"], 100)).toContain("Some body text");
  });
});
