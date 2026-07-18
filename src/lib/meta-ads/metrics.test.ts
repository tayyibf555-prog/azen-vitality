import { describe, it, expect } from "vitest";
import { parseInsights, sumLeadActions } from "./metrics";

// Insights parsing. Meta returns string-valued numbers and a nested actions array; a
// "lead" can arrive under several action_type strings. We sum only known lead types and
// never over-count. An empty response is honest "no data yet" (all null).

describe("sumLeadActions", () => {
  it("sums the value of every known lead action type", () => {
    const actions = [
      { action_type: "lead", value: "2" },
      { action_type: "onsite_conversion.lead_grouped", value: "3" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "1" },
    ];
    expect(sumLeadActions(actions)).toBe(6);
  });

  it("ignores non-lead action types", () => {
    const actions = [
      { action_type: "link_click", value: "50" },
      { action_type: "landing_page_view", value: "20" },
      { action_type: "lead", value: "4" },
    ];
    expect(sumLeadActions(actions)).toBe(4);
  });

  it("is 0 for missing / non-array actions", () => {
    expect(sumLeadActions(undefined)).toBe(0);
    expect(sumLeadActions(null)).toBe(0);
    expect(sumLeadActions("nope")).toBe(0);
  });
});

describe("parseInsights", () => {
  it("parses spend, impressions, clicks and derives leads from actions", () => {
    const json = {
      data: [
        {
          spend: "123.45",
          impressions: "10000",
          clicks: "250",
          actions: [
            { action_type: "lead", value: "7" },
            { action_type: "post_engagement", value: "999" },
          ],
        },
      ],
    };
    expect(parseInsights(json)).toEqual({
      spendGbp: 123.45,
      impressions: 10000,
      clicks: 250,
      leads: 7,
      raw: json.data[0],
    });
  });

  it("returns leads 0 when a row exists but has no lead actions", () => {
    const json = { data: [{ spend: "10", impressions: "100", clicks: "5" }] };
    const parsed = parseInsights(json);
    expect(parsed.leads).toBe(0);
    expect(parsed.spendGbp).toBe(10);
  });

  it("returns all-null when there is no data row yet (awaiting delivery)", () => {
    const json = { data: [] };
    expect(parseInsights(json)).toEqual({
      spendGbp: null,
      impressions: null,
      clicks: null,
      leads: null,
      raw: json,
    });
  });

  it("returns all-null for an empty / malformed response", () => {
    expect(parseInsights({}).impressions).toBeNull();
    expect(parseInsights(null).leads).toBeNull();
  });
});
