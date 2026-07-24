import { describe, it, expect } from "vitest";
import { groupCampaignsByGoal } from "./grouping";

interface Fixture {
  id: string;
  goal: string;
}

describe("groupCampaignsByGoal", () => {
  it("groups by goal, preserving first-seen order", () => {
    const campaigns: Fixture[] = [
      { id: "1", goal: "invisalign" },
      { id: "2", goal: "bonding" },
      { id: "3", goal: "invisalign" },
      { id: "4", goal: "general" },
      { id: "5", goal: "bonding" },
    ];
    const groups = groupCampaignsByGoal(campaigns);
    expect(groups.map((g) => g.key)).toEqual(["invisalign", "bonding", "general"]);
    expect(groups[0]!.campaigns.map((c) => c.id)).toEqual(["1", "3"]);
    expect(groups[1]!.campaigns.map((c) => c.id)).toEqual(["2", "5"]);
    expect(groups[2]!.campaigns.map((c) => c.id)).toEqual(["4"]);
  });

  it("labels each group via goalLabel (the same labels the admin API/UI use)", () => {
    const groups = groupCampaignsByGoal<Fixture>([
      { id: "1", goal: "bonding" },
      { id: "2", goal: "hygiene" },
    ]);
    expect(groups.find((g) => g.key === "bonding")?.label).toBe("Composite bonding");
    expect(groups.find((g) => g.key === "hygiene")?.label).toBe("Hygiene / check-ups");
  });

  it("falls back a blank goal to the general group, merging with an explicit 'general'", () => {
    const groups = groupCampaignsByGoal<Fixture>([
      { id: "1", goal: "" },
      { id: "2", goal: "general" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("general");
    expect(groups[0]!.campaigns.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("falls back an unknown goal key to a labelled group rather than throwing", () => {
    const groups = groupCampaignsByGoal<Fixture>([{ id: "1", goal: "something-unknown" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("something-unknown");
    expect(typeof groups[0]!.label).toBe("string");
  });

  it("returns an empty array for no campaigns", () => {
    expect(groupCampaignsByGoal([])).toEqual([]);
  });
});
