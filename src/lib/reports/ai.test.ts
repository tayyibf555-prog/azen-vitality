import { describe, it, expect, vi } from "vitest";

// buildReportPrompt is pure, but it lives beside the snapshot module whose imports
// reach the enquiry store. The mock keeps a prompt test off the database.
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listLeads: vi.fn(),
  countLeadsInWindow: vi.fn(),
}));

import { buildReportPrompt } from "./ai";
import { SNAPSHOT_LEAD_LIMIT, type ReportSnapshot } from "./snapshot";

// ---------------------------------------------------------------------------
// THE MODEL IS TOLD WHICH FIGURES ARE TOTALS AND WHICH ARE SAMPLES.
//
// A busy month is now reviewed rather than refused: the enquiry and booking counts
// are counted in Postgres, so they are exact however many there were. The average
// first response and the source mix still need the enquiry rows, and that read is
// bounded, so past the bound they describe the period's most recent enquiries only.
//
// The whole point of unlocking the review for a busy period is lost if the model
// then reads a sampled average aloud as the period's average. So the difference goes
// into the prompt, in the same breath as the numbers.
// ---------------------------------------------------------------------------

function snap(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    period: "month",
    windowLabel: "last 30 days",
    enquiries: 912,
    contacted: 500,
    booked: 240,
    enquiryToBookedRate: 0.26,
    avgFirstResponseSeconds: 62,
    topSource: { source: "smile-assessment", count: 210 },
    hasEnoughData: true,
    readFailed: false,
    truncated: true,
    countsExact: true,
    ...over,
  };
}

describe("the review prompt separates counted figures from sampled ones", () => {
  it("names the sampled figures when the period outran the detail read", () => {
    const { user } = buildReportPrompt(snap(), "month", "Vitality Dental");

    expect(user).toContain("Enquiries received: 912.");
    expect(user).toContain("exact totals for the whole period");
    expect(user).toContain(`the ${SNAPSHOT_LEAD_LIMIT} most recent enquiries in the period`);
    expect(user, "a sampled average narrated as the period's average is the failure").toContain(
      "never state it as the figure for every enquiry in the period",
    );
  });

  it("says nothing of the sort for a period read whole", () => {
    // The control. A caveat on figures that carry none is its own kind of wrong: it
    // teaches the owner to discount numbers that are exact.
    const { user } = buildReportPrompt(
      snap({ truncated: false, enquiries: 46, booked: 12, contacted: 41 }),
      "month",
      "Vitality Dental",
    );

    expect(user).toContain("Enquiries received: 46.");
    expect(user).not.toContain("most recent enquiries");
    expect(user).not.toContain("exact totals");
  });
});
