// ===========================================================================
// THE FOURTH STATE, CARRIED FROM THE READ TO THE PAYLOAD.
//
// A day that has ENDED cannot be asked about at all: Dentally's availability
// endpoint refuses any window that is not in the future. That is not a failure
// and it is emphatically not "nobody was working" -- and the only way the grid
// can tell the reader which of the three it is, is if this fact survives the trip
// from the read to the payload. Drop it here and every elapsed column silently
// reverts to grey: a positive claim that the practice was shut, made about a
// question nobody was able to ask.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

// day-load carries `import "server-only"`, which does not resolve under the node
// test runner. Stubbed, exactly as every other suite here does it.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  availability: {
    rows: [] as unknown[],
    failed: false,
    unanswerableDayKeys: [] as string[],
  },
}));

vi.mock("@/lib/dentally/read", () => ({
  listDiaryAvailabilitySafe: async () => h.availability,
}));
vi.mock("./repository", () => ({
  listEntries: async () => ({ entries: [], failed: false }),
}));
vi.mock("./funding-source", () => ({
  resolveDayFunding: async () => ({ byPatientId: new Map(), failed: false }),
}));
vi.mock("./site-presence", () => ({
  readSharedPractitionerIds: async () => ({ shared: new Set<string>(), rosterUnknown: false }),
  availabilityTrustedHere: () => true,
}));

import { loadDiaryDay } from "./day-load";

const args = (dayKeys: string[]) => ({
  clientId: "vitality",
  siteId: "site-cc",
  dayKeys,
  practitionerIds: ["prac-1"],
  practitionersFailed: false,
  appointments: [],
});

beforeEach(() => {
  h.availability = { rows: [], failed: false, unanswerableDayKeys: [] };
});

describe("loadDiaryDay and the days Dentally cannot answer for", () => {
  it("carries the unanswerable days through to the payload", async () => {
    h.availability = { rows: [], failed: false, unanswerableDayKeys: ["2026-07-27"] };
    const payload = await loadDiaryDay(args(["2026-07-27", "2026-07-28"]));
    expect(payload.unanswerableDayKeys).toEqual(["2026-07-27"]);
  });

  it("does NOT raise the failure flag for them: nothing failed and no retry helps", async () => {
    h.availability = { rows: [], failed: false, unanswerableDayKeys: ["2026-07-27"] };
    const payload = await loadDiaryDay(args(["2026-07-27"]));
    expect(payload.availabilityFailed).toBe(false);
  });

  it("reports NO unanswerable days when the read actually failed", async () => {
    // An outage must not be dressed up as a calendar fact: "that date has passed"
    // is a calm sentence, and a column that says it while Dentally is down is
    // lying about why it is empty.
    h.availability = { rows: [], failed: true, unanswerableDayKeys: [] };
    const payload = await loadDiaryDay(args(["2026-07-27"]));
    expect(payload.availabilityFailed).toBe(true);
    expect(payload.unanswerableDayKeys).toEqual([]);
  });

  it("reports NO unanswerable days when the practitioner read failed and nothing was asked", async () => {
    const payload = await loadDiaryDay({ ...args(["2026-07-27"]), practitionersFailed: true });
    expect(payload.availabilityFailed).toBe(true);
    expect(payload.unanswerableDayKeys).toEqual([]);
  });

  it("says nothing is unanswerable on an ordinary readable day", async () => {
    const payload = await loadDiaryDay(args(["2026-07-31"]));
    expect(payload.unanswerableDayKeys).toEqual([]);
    expect(payload.availabilityFailed).toBe(false);
  });
});
