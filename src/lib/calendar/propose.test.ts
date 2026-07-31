import { describe, expect, it } from "vitest";
import { SUITABILITY_SEED } from "./suitability-seed";
import {
  proposalBreakdown,
  proposeSlots,
  type ProposalClinician,
  type ProposalDay,
  type ProposalInput,
} from "./propose";

const BOUNDS = { startMin: 480, endMin: 1200 };

function clinician(over: Partial<ProposalClinician> = {}): ProposalClinician {
  return {
    practitionerId: "prac-1",
    practitionerName: "Dana Hale",
    siteId: "site-cc",
    windows: [{ startMin: 540, endMin: 1020 }],
    booked: [],
    breaks: [],
    ...over,
  };
}

function day(clinicians: ProposalClinician[], dayKey = "2026-07-31"): ProposalDay {
  return { dayKey, bounds: BOUNDS, clinicians };
}

function input(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    familySlug: "restorative",
    durationMin: 30,
    previousPractitionerId: null,
    days: [day([clinician()])],
    caps: SUITABILITY_SEED,
    ...over,
  };
}

describe("proposeSlots: the filter", () => {
  it("NEVER proposes a hygienist for a surgical treatment", () => {
    const res = proposeSlots(
      input({
        familySlug: "surgical",
        days: [day([clinician({ practitionerId: "prac-4", practitionerName: "Priya Raman" })])],
      }),
    );
    expect(res).toEqual([]);
  });

  it("excludes an 'unknown' capability rather than treating it as 'can'", () => {
    const res = proposeSlots(
      input({
        familySlug: "surgical",
        days: [day([clinician({ practitionerId: "prac-21", practitionerName: "Marcus Bell" })])],
      }),
    );
    expect(res).toEqual([]);
  });

  it("excludes a slot overlapping a booked appointment EVEN WHEN the window covers it", () => {
    const res = proposeSlots(
      input({
        days: [
          day([
            clinician({
              windows: [{ startMin: 540, endMin: 660 }],
              booked: [{ startMin: 540, endMin: 630 }],
            }),
          ]),
        ],
      }),
    );
    expect(res.map((p) => p.startMin)).toEqual([630]);
  });

  it("excludes a slot overlapping a break", () => {
    const res = proposeSlots(
      input({
        days: [
          day([
            clinician({
              windows: [{ startMin: 540, endMin: 630 }],
              breaks: [{ startMin: 540, endMin: 600 }],
            }),
          ]),
        ],
      }),
    );
    expect(res.map((p) => p.startMin)).toEqual([600]);
  });

  it("requires the WHOLE span inside ONE window, never spanning a gap", () => {
    const res = proposeSlots(
      input({
        durationMin: 60,
        days: [
          day([clinician({ windows: [{ startMin: 540, endMin: 570 }, { startMin: 600, endMin: 630 }] })]),
        ],
      }),
    );
    expect(res).toEqual([]);
  });

  it("clips to the day's drawn extent", () => {
    const res = proposeSlots(
      input({
        days: [{ dayKey: "2026-07-31", bounds: { startMin: 540, endMin: 600 }, clinicians: [clinician()] }],
      }),
    );
    expect(res.map((p) => p.startMin)).toEqual([540, 545]);
  });

  it("returns [] when the treatment cannot be classified", () => {
    expect(proposeSlots(input({ familySlug: null }))).toEqual([]);
  });

  it("returns [] when there are no clinicians at all", () => {
    expect(proposeSlots(input({ days: [day([])] }))).toEqual([]);
  });

  it("honours the site override: prac-2 can do implants at site-cc only", () => {
    const atCc = proposeSlots(
      input({
        familySlug: "implant",
        days: [day([clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei", siteId: "site-cc" })])],
      }),
    );
    expect(atCc.length).toBeGreaterThan(0);

    const atRv = proposeSlots(
      input({
        familySlug: "implant",
        days: [day([clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei", siteId: "site-rv" })])],
      }),
    );
    expect(atRv).toEqual([]);
  });
});

describe("proposeSlots: the ordering", () => {
  it("puts every 'can' before every 'supervised'", () => {
    const res = proposeSlots(
      input({
        familySlug: "surgical",
        days: [
          day([
            // prac-3 is 'supervised' on surgical; prac-2 'can'. prac-3 is listed
            // first and opens EARLIER, so only the level rule can reorder them.
            clinician({
              practitionerId: "prac-3",
              practitionerName: "Jin Kim",
              windows: [{ startMin: 540, endMin: 600 }],
            }),
            clinician({
              practitionerId: "prac-2",
              practitionerName: "Femi Osei",
              windows: [{ startMin: 900, endMin: 960 }],
            }),
          ]),
        ],
      }),
    );
    expect(res[0].level).toBe("can");
    expect(res[0].practitionerId).toBe("prac-2");
    expect(res.map((p) => p.level)).toEqual(["can", "can", "supervised", "supervised"]);
  });

  it("puts the clinician the patient already had first, within a level", () => {
    const clinicians = [
      clinician({ practitionerId: "prac-1", practitionerName: "Dana Hale", windows: [{ startMin: 540, endMin: 570 }] }),
      clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei", windows: [{ startMin: 600, endMin: 630 }] }),
    ];
    const withoutPrevious = proposeSlots(input({ days: [day(clinicians)] }));
    expect(withoutPrevious[0].practitionerId).toBe("prac-1"); // earliest wins

    const withPrevious = proposeSlots(input({ days: [day(clinicians)], previousPractitionerId: "prac-2" }));
    expect(withPrevious[0].practitionerId).toBe("prac-2"); // continuity of care wins
  });

  it("orders by earliest start across days", () => {
    const res = proposeSlots(
      input({
        days: [
          day([clinician({ windows: [{ startMin: 600, endMin: 630 }] })], "2026-08-01"),
          day([clinician({ windows: [{ startMin: 900, endMin: 930 }] })], "2026-07-31"),
        ],
      }),
    );
    expect(res.map((p) => p.dayKey)).toEqual(["2026-07-31", "2026-08-01"]);
  });

  it("is deterministic on a tie, by name under en-GB", () => {
    const res = proposeSlots(
      input({
        days: [
          day([
            clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei", windows: [{ startMin: 540, endMin: 570 }] }),
            clinician({ practitionerId: "prac-1", practitionerName: "Dana Hale", windows: [{ startMin: 540, endMin: 570 }] }),
          ]),
        ],
      }),
    );
    expect(res.map((p) => p.practitionerName)).toEqual(["Dana Hale", "Femi Osei"]);
  });
});

describe("proposeSlots: the caps", () => {
  it("caps at 6 proposals and at 2 per clinician-day", () => {
    const res = proposeSlots(
      input({
        days: [
          day(
            [
              clinician({ practitionerId: "prac-1", practitionerName: "Dana Hale" }),
              clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei" }),
              clinician({ practitionerId: "prac-3", practitionerName: "Jin Kim" }),
              clinician({ practitionerId: "prac-9", practitionerName: "Zoe Adeyemi" }),
            ],
            "2026-07-31",
          ),
        ],
      }),
    );
    // prac-9 has no seed rows, so it is excluded: three suitable clinicians,
    // two slots each.
    expect(res).toHaveLength(6);
    const perClinician = new Map<string, number>();
    for (const p of res) perClinician.set(p.practitionerId, (perClinician.get(p.practitionerId) ?? 0) + 1);
    expect([...perClinician.values()].every((n) => n <= 2)).toBe(true);
    expect(perClinician.size).toBe(3);
  });

  it("counts the same clinician on two DAYS separately", () => {
    const res = proposeSlots(
      input({
        days: [
          day([clinician({ windows: [{ startMin: 540, endMin: 660 }] })], "2026-07-31"),
          day([clinician({ windows: [{ startMin: 540, endMin: 660 }] })], "2026-08-01"),
        ],
      }),
    );
    expect(res).toHaveLength(4);
    expect(res.filter((p) => p.dayKey === "2026-07-31")).toHaveLength(2);
    expect(res.filter((p) => p.dayKey === "2026-08-01")).toHaveLength(2);
  });
});

describe("proposalBreakdown", () => {
  it("explains an empty result rather than leaving a confident blank", () => {
    const args = input({
      familySlug: "surgical",
      days: [
        day([
          // can do it, but fully booked
          clinician({
            practitionerId: "prac-2",
            practitionerName: "Femi Osei",
            windows: [{ startMin: 540, endMin: 600 }],
            booked: [{ startMin: 540, endMin: 600 }],
          }),
          // cannot do it at all
          clinician({ practitionerId: "prac-4", practitionerName: "Priya Raman" }),
          // no record either way
          clinician({ practitionerId: "prac-21", practitionerName: "Marcus Bell" }),
        ]),
      ],
    });
    expect(proposeSlots(args)).toEqual([]);
    expect(proposalBreakdown(args)).toEqual({
      capable: 1,
      capableWithNoFreeTime: 1,
      cannot: 1,
      unknown: 1,
    });
  });

  it("counts free time from the UNCAPPED candidate set, not from the six shown", () => {
    // Four capable clinicians, every one of them free: the cap shows six
    // proposals from three of them, but nobody has "no free time".
    const args = input({
      days: [
        day([
          clinician({ practitionerId: "prac-1", practitionerName: "Dana Hale" }),
          clinician({ practitionerId: "prac-2", practitionerName: "Femi Osei" }),
          clinician({ practitionerId: "prac-3", practitionerName: "Jin Kim" }),
          clinician({ practitionerId: "prac-4", practitionerName: "Priya Raman" }),
        ]),
      ],
    });
    expect(proposeSlots(args)).toHaveLength(6);
    const breakdown = proposalBreakdown(args);
    expect(breakdown.capable).toBe(3); // prac-4 cannot do restorative
    expect(breakdown.capableWithNoFreeTime).toBe(0);
    expect(breakdown.cannot).toBe(1);
  });

  it("counts every clinician as unknown when the treatment cannot be classified", () => {
    const args = input({ familySlug: null });
    expect(proposalBreakdown(args)).toEqual({
      capable: 0,
      capableWithNoFreeTime: 0,
      cannot: 0,
      unknown: 1,
    });
  });
});
