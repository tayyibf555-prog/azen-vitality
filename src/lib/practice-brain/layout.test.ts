import { describe, it, expect } from "vitest";
import { layoutConstellation } from "./layout";
import type { Tier } from "./types";

const hubs = [
  { id: "h1", title: "Reception", tier: 1 as Tier, leaves: [{ id: "l1", title: "Script", tier: 1 as Tier }] },
  { id: "h2", title: "Sales", tier: 2 as Tier, leaves: [] },
  { id: "h3", title: "Marketing", tier: 1 as Tier, leaves: [{ id: "l2", title: "Brand", tier: 1 as Tier }, { id: "l3", title: "Ads", tier: 1 as Tier }] },
];

describe("layoutConstellation", () => {
  it("places one hub per input and is deterministic", () => {
    const a = layoutConstellation(hubs, { width: 680, height: 560 });
    const b = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(a.hubs).toHaveLength(3);
    expect(a).toEqual(b);
  });

  it("keeps every placed point inside the canvas", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    for (const h of c.hubs) {
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.x).toBeLessThanOrEqual(680);
      expect(h.y).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeLessThanOrEqual(560);
    }
    for (const leaf of c.leaves) {
      expect(leaf.x).toBeGreaterThanOrEqual(0);
      expect(leaf.x).toBeLessThanOrEqual(680);
      expect(leaf.y).toBeGreaterThanOrEqual(0);
      expect(leaf.y).toBeLessThanOrEqual(560);
    }
  });

  it("emits leaves for hubs that have them", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(c.leaves.filter((l) => l.hubId === "h3")).toHaveLength(2);
    expect(c.leaves.filter((l) => l.hubId === "h2")).toHaveLength(0);
  });

  it("centres the core", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(c.center).toEqual({ x: 340, y: 280 });
  });
});
