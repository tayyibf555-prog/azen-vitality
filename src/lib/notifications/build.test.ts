// The notifications feed is built from REAL sources only (no-show, onboarding,
// lead). The fabricated compliance source has been removed, so no item is ever
// sample-tagged: compliance notifications return once the practice's real records
// are connected. The DB-backed sources are mocked to deterministic values so the
// test is pure and fast.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/noshow/repository", () => ({
  listTargets: async () => [
    { appointmentId: "a1", patientName: "Pat Test", appointmentStartAt: "2026-07-16T10:00:00Z" },
  ],
}));
vi.mock("@/lib/onboarding/repository", () => ({
  countNewSubmissions: async () => ({ count: 2, newestAt: "2026-07-16T08:00:00Z" }),
}));
vi.mock("@/lib/smile-assessment/repository", () => ({
  listResponses: async () => [
    { id: "r1", leadId: null, firstName: "Sam", treatmentInterest: "Invisalign", createdAt: "2026-07-16T07:00:00Z" },
  ],
}));

import { buildNotifications } from "./build";

describe("buildNotifications is real-sourced and never fabricated", () => {
  it("produces the real sources, no compliance items, and nothing sample-tagged", async () => {
    const items = await buildNotifications({ clientId: "vitality", clientSlug: "vitality", siteIds: ["site-cc"] });

    // The mocked real sources each contribute at least one item.
    expect(items.length).toBeGreaterThan(0);

    // No fabricated compliance items, and nothing carries the sample tag.
    const compliance = items.filter((i) => i.type === "compliance");
    expect(compliance.length).toBe(0);
    for (const item of items) expect(item.sample).toBeUndefined();
  });
});
