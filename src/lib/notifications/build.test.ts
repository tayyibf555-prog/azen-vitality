// The notifications feed's honesty pass: every item built from pure mock data
// (currently: compliance) must carry `sample: true` so the UI can show a visible
// "Sample" tag (mirrors the SampleNote precedent elsewhere in the dashboard).
// Real-sourced items (no-show, onboarding, lead) must stay untagged. The DB-backed
// sources are mocked to deterministic values so the test is pure and fast.
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

describe("buildNotifications sample-tagging", () => {
  it("tags every compliance-sourced item as sample, and leaves every other source untagged", async () => {
    const items = await buildNotifications({ clientId: "vitality", clientSlug: "vitality", siteIds: ["site-cc"] });

    const compliance = items.filter((i) => i.type === "compliance");
    const others = items.filter((i) => i.type !== "compliance");

    // The compliance mock fixtures include at least one overdue/due-soon item,
    // so this assertion is meaningful (not vacuously true over an empty array).
    expect(compliance.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);

    for (const item of compliance) expect(item.sample).toBe(true);
    for (const item of others) expect(item.sample).toBeUndefined();
  });
});
