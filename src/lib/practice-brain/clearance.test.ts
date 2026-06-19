import { describe, it, expect } from "vitest";
import { maxTierForRole, visibleNodes, childrenOf, branchCounts } from "./clearance";
import type { KnowledgeNode, Tier } from "./types";

function node(p: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n", clientId: "vitality", siteId: null, parentId: null, kind: "item",
    title: "t", body: "b", rawInput: null, tier: 1 as Tier, tags: [],
    source: "manual_note", sourceRef: null, classification: null, status: "active",
    createdBy: null, createdAt: "", updatedAt: "", ...p,
  };
}

describe("maxTierForRole", () => {
  it("maps coordinator to 2, owner and agency to 4", () => {
    expect(maxTierForRole("client_coordinator")).toBe(2);
    expect(maxTierForRole("client_owner")).toBe(4);
    expect(maxTierForRole("agency_admin")).toBe(4);
  });
});

describe("visibleNodes", () => {
  it("hides nodes above the viewer tier and non-active nodes", () => {
    const nodes = [
      node({ id: "a", tier: 1 }),
      node({ id: "b", tier: 3 }),
      node({ id: "c", tier: 2, status: "needs_review" }),
      node({ id: "d", tier: 2 }),
    ];
    const visible = visibleNodes(nodes, 2).map((n) => n.id);
    expect(visible).toEqual(["a", "d"]);
  });
});

describe("childrenOf", () => {
  it("returns nodes whose parentId matches", () => {
    const nodes = [
      node({ id: "root", kind: "branch", parentId: null }),
      node({ id: "x", parentId: "root" }),
      node({ id: "y", parentId: "other" }),
    ];
    expect(childrenOf(nodes, "root").map((n) => n.id)).toEqual(["x"]);
  });
});

describe("branchCounts", () => {
  it("counts direct children per branch among the given (already filtered) nodes", () => {
    const nodes = [
      node({ id: "h1", kind: "branch", parentId: null }),
      node({ id: "i1", parentId: "h1" }),
      node({ id: "i2", parentId: "h1" }),
      node({ id: "h2", kind: "branch", parentId: null }),
    ];
    const counts = branchCounts(nodes);
    expect(counts.h1).toBe(2);
    expect(counts.h2 ?? 0).toBe(0);
  });
});
