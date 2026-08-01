import { describe, it, expect } from "vitest";
import { relativeLabel } from "./relative";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}
function ahead(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("relativeLabel: past", () => {
  it("reads the last minute as 'just now'", () => {
    expect(relativeLabel(ago(0), NOW)).toBe("just now");
    expect(relativeLabel(ago(20_000), NOW)).toBe("just now");
  });

  it("counts minutes", () => {
    expect(relativeLabel(ago(3 * MIN), NOW)).toBe("3 min ago");
    expect(relativeLabel(ago(59 * MIN), NOW)).toBe("59 min ago");
  });

  it("counts hours", () => {
    expect(relativeLabel(ago(2 * HOUR), NOW)).toBe("2 hr ago");
    expect(relativeLabel(ago(23 * HOUR), NOW)).toBe("23 hr ago");
  });

  it("counts days, and pluralises", () => {
    expect(relativeLabel(ago(DAY), NOW)).toBe("1 day ago");
    expect(relativeLabel(ago(5 * DAY), NOW)).toBe("5 days ago");
  });

  it("counts weeks", () => {
    expect(relativeLabel(ago(7 * DAY), NOW)).toBe("1 week ago");
    expect(relativeLabel(ago(21 * DAY), NOW)).toBe("3 weeks ago");
  });

  it("caps weeks at 4 so a month boundary cannot read '5 weeks'", () => {
    expect(relativeLabel(ago(30 * DAY), NOW)).toBe("4 weeks ago");
  });

  it("counts months", () => {
    expect(relativeLabel(ago(31 * DAY), NOW)).toBe("1 month ago");
    expect(relativeLabel(ago(92 * DAY), NOW)).toBe("3 months ago");
  });

  it("caps months at 11 so '12 months ago' and '1 year ago' are not both reachable", () => {
    expect(relativeLabel(ago(364 * DAY), NOW)).toBe("11 months ago");
  });

  it("counts years", () => {
    expect(relativeLabel(ago(365 * DAY), NOW)).toBe("1 year ago");
    expect(relativeLabel(ago(4 * 365 * DAY), NOW)).toBe("4 years ago");
  });

  // The regression the study named: the old helper rendered this as "730 days ago".
  it("REGRESSION: a visit two years ago does not read in days", () => {
    const label = relativeLabel(ago(730 * DAY), NOW);
    expect(label).toBe("2 years ago");
    expect(label).not.toContain("day");
  });
});

describe("relativeLabel: future", () => {
  it("uses the future tense for minutes and hours", () => {
    expect(relativeLabel(ahead(20 * MIN), NOW)).toBe("in 20 min");
    expect(relativeLabel(ahead(5 * HOUR), NOW)).toBe("in 5 hr");
  });

  it("uses the future tense for days and weeks", () => {
    expect(relativeLabel(ahead(2 * DAY), NOW)).toBe("in 2 days");
    expect(relativeLabel(ahead(14 * DAY), NOW)).toBe("in 2 weeks");
  });

  // The regression the study named: a recall due in three months read "just now".
  it("REGRESSION: a recall due in three months reads 'in 3 months'", () => {
    const label = relativeLabel(ahead(91 * DAY), NOW);
    expect(label).toBe("in 3 months");
    expect(label).not.toBe("just now");
  });

  it("uses the future tense for years", () => {
    expect(relativeLabel(ahead(2 * 365 * DAY), NOW)).toBe("in 2 years");
  });
});

describe("relativeLabel: bad input", () => {
  it("returns an empty string rather than 'Invalid Date ago'", () => {
    expect(relativeLabel("not-a-date", NOW)).toBe("");
    expect(relativeLabel("", NOW)).toBe("");
  });
});
