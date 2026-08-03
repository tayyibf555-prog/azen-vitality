import { describe, it, expect } from "vitest";
import {
  offArchItems,
  regionOrigin,
  surfaceDraft,
  surfaceOrigin,
  surfaceStyle,
  toothFunding,
  toothMarks,
  unreadSurfaceCount,
  unreadSurfaceItems,
  unreadValuesFor,
} from "./render-state";
import { regionForIndex } from "./surfaces";
import type { ChartItem, DraftEntry, PlanRow, SurfaceOrigin } from "./types";

function item(over: Partial<ChartItem> = {}): ChartItem {
  return {
    id: "i1",
    teeth: [16],
    rawTeeth: "16",
    surfaces: ["occlusal"],
    rawSurfaces: "O",
    surfaceIndices: [],
    unrecognisedSurfaces: [],
    wholeTooth: false,
    region: null,
    baseChart: false,
    completed: false,
    completedAt: null,
    charged: false,
    notes: null,
    nomenclature: "Filling",
    price: 0,
    value: 0,
    durationMin: 0,
    nhsTreatmentCat: null,
    udaBand: null,
    position: 0,
    planId: null,
    treatmentId: null,
    practitionerId: null,
    paymentPlanId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

const PLANS: PlanRow[] = [
  { id: "p-live", label: "Plan 1", status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" },
  { id: "p-cold", label: "Plan 2", status: "unaccepted", acceptedAt: null },
];

const DRAFT_ENTRY: DraftEntry = {
  tooth: 16,
  surfaces: ["mesial"],
  treatmentCode: "121",
  treatmentName: "NHS Urgent Filling",
  dentition: "permanent",
};

describe("surfaceStyle", () => {
  const ORIGINS: SurfaceOrigin[] = [
    "dentally-completed",
    "dentally-planned",
    "dentally-unaccepted",
    "dentally-base",
    "draft",
    "none",
  ];

  // The test that stops our own planning ever being drawn as a Dentally
  // finding. A dashed outline and a glyph survive a photocopy and a
  // red-green deficiency; a different shade of the same fill does not.
  it("makes the draft the ONLY dashed, glyphed, unfilled origin", () => {
    const draft = surfaceStyle("draft");
    expect(draft.dashed).toBe(true);
    expect(draft.glyph).toBe("draft");
    expect(draft.fillVar).toBeNull();
    for (const o of ORIGINS.filter((x) => x !== "draft")) {
      expect(surfaceStyle(o).dashed).toBe(false);
      expect(surfaceStyle(o).glyph).toBe("none");
    }
  });

  it("gives the four Dentally origins four distinct fills, so an unaccepted plan cannot look like the live one", () => {
    const fills = [
      surfaceStyle("dentally-completed").fillVar,
      surfaceStyle("dentally-planned").fillVar,
      surfaceStyle("dentally-unaccepted").fillVar,
      surfaceStyle("dentally-base").fillVar,
    ];
    expect(new Set(fills).size).toBe(4);
    expect(fills.every((f) => typeof f === "string" && f.startsWith("--chart-"))).toBe(true);
  });

  it("labels every origin, so the legend renders from the same source as the chart and cannot drift", () => {
    for (const o of ORIGINS) {
      expect(surfaceStyle(o).label.length).toBeGreaterThan(0);
      expect(surfaceStyle(o).lineVar.startsWith("--")).toBe(true);
    }
    expect(new Set(ORIGINS.map((o) => surfaceStyle(o).label)).size).toBe(ORIGINS.length);
  });

  // globals.css keeps these variables OUTSIDE @theme inline on purpose, so an
  // interpolated Tailwind class renders transparent. A raw hex here would be a
  // second colour system, which house style forbids.
  it("carries no raw hex anywhere, only CSS custom property names", () => {
    for (const o of ORIGINS) {
      const s = surfaceStyle(o);
      expect(JSON.stringify(s)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(JSON.stringify(s)).not.toMatch(/\brgb|\bhsl|\boklch/);
    }
  });
});

describe("surfaceOrigin", () => {
  it("reports nothing when nothing is charted, which is not the same as a failed read", () => {
    expect(surfaceOrigin(16, "occlusal", [], PLANS, {})).toBe("none");
  });

  it("distinguishes completed, planned, unaccepted and base-chart findings", () => {
    expect(surfaceOrigin(16, "occlusal", [item({ completed: true })], PLANS, {})).toBe(
      "dentally-completed",
    );
    expect(surfaceOrigin(16, "occlusal", [item({ planId: "p-live" })], PLANS, {})).toBe(
      "dentally-planned",
    );
    expect(surfaceOrigin(16, "occlusal", [item({ planId: "p-cold" })], PLANS, {})).toBe(
      "dentally-unaccepted",
    );
    expect(surfaceOrigin(16, "occlusal", [item({ baseChart: true })], PLANS, {})).toBe(
      "dentally-base",
    );
  });

  it("treats an item on a plan we could not read as planned, never as unaccepted", () => {
    // A failed or partial plans read must not demote a live finding into a
    // declined one: that would understate treatment the patient agreed to.
    expect(surfaceOrigin(16, "occlusal", [item({ planId: "p-missing" })], [], {})).toBe(
      "dentally-planned",
    );
  });

  it("lets a completed finding outrank a plan on the same surface, because done outranks intended", () => {
    const items = [item({ id: "a", planId: "p-cold" }), item({ id: "b", completed: true })];
    expect(surfaceOrigin(16, "occlusal", items, PLANS, {})).toBe("dentally-completed");
  });

  it("ignores an item on another tooth or another surface", () => {
    expect(surfaceOrigin(26, "occlusal", [item()], PLANS, {})).toBe("none");
    expect(surfaceOrigin(16, "mesial", [item()], PLANS, {})).toBe("none");
  });

  it("resolves a draft-only surface to draft", () => {
    expect(surfaceOrigin(16, "mesial", [], PLANS, { "16:121": DRAFT_ENTRY })).toBe("draft");
  });

  // Dentally owns the fill; our draft draws ON TOP. The draft must still be
  // visible, so it is reported separately rather than being hidden by
  // precedence.
  it("leaves Dentally owning the fill where a draft sits on a surface Dentally already holds, and still reports the draft", () => {
    const draft = { "16:121": { ...DRAFT_ENTRY, surfaces: ["occlusal"] as DraftEntry["surfaces"] } };
    expect(surfaceOrigin(16, "occlusal", [item({ completed: true })], PLANS, draft)).toBe(
      "dentally-completed",
    );
    expect(surfaceDraft(16, "occlusal", draft)).toBe(true);
    expect(surfaceDraft(16, "mesial", draft)).toBe(false);
  });
});

describe("toothMarks", () => {
  // A per-surface renderer alone draws a clean, unmarked tooth for a planned
  // extraction, because an extraction carries no surfaces. That is the most
  // direct route from this screen to a wrong-site event.
  it("marks a surfaceless extraction, so a planned extraction can never draw as a clean tooth", () => {
    const extraction = item({
      id: "x",
      surfaces: [],
      rawSurfaces: "",
      wholeTooth: true,
      nomenclature: "Extraction",
      planId: "p-live",
    });
    const marks = toothMarks(16, [extraction], {});
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({
      origin: "dentally-planned",
      nomenclature: "Extraction",
      itemId: "x",
    });
  });

  it("returns nothing for a tooth that only carries surface work, so the ring means something", () => {
    expect(toothMarks(16, [item()], {})).toEqual([]);
  });

  it("marks a bridge on every abutment it names", () => {
    const bridge = item({
      id: "b",
      teeth: [16, 14],
      rawTeeth: "16,14",
      surfaces: [],
      wholeTooth: true,
      completed: true,
    });
    expect(toothMarks(16, [bridge], {})).toHaveLength(1);
    expect(toothMarks(14, [bridge], {})).toHaveLength(1);
    expect(toothMarks(15, [bridge], {})).toHaveLength(0);
  });
});

describe("toothFunding", () => {
  // A tooth can carry an NHS filling AND a private crown. Returning one code by
  // unstated precedence would print a funding rail that is simply untrue.
  it("returns EVERY distinct code on the tooth, in NHS, private, UDC, unknown order", () => {
    const items = [
      item({ id: "a", paymentPlanId: 2 }),
      item({ id: "b", paymentPlanId: 1 }),
      item({ id: "c", paymentPlanId: 1 }),
    ];
    expect(toothFunding(16, items)).toEqual(["nhs", "private"]);
  });

  it("resolves a plan id outside this practice's whitelist to unknown, never to private", () => {
    expect(toothFunding(16, [item({ paymentPlanId: 999999 })])).toEqual(["unknown"]);
    expect(toothFunding(16, [item({ paymentPlanId: null })])).toEqual(["unknown"]);
    expect(toothFunding(16, [item({ paymentPlanId: 47752 })])).toEqual(["udc"]);
  });

  it("returns nothing for a tooth with no items at all", () => {
    expect(toothFunding(16, [])).toEqual([]);
    expect(toothFunding(26, [item()])).toEqual([]);
  });
});

describe("offArchItems", () => {
  const permanent = item({ id: "p", teeth: [16], rawTeeth: "16" });
  const deciduous = item({ id: "d", teeth: [55], rawTeeth: "55" });
  const mixed = item({ id: "m", teeth: [16, 55], rawTeeth: "16,55" });

  // Silently gone was the failure. A count is the floor.
  it("counts the other dentition's items, in both directions", () => {
    expect(offArchItems([permanent, deciduous], "permanent").map((i) => i.id)).toEqual(["d"]);
    expect(offArchItems([permanent, deciduous], "deciduous").map((i) => i.id)).toEqual(["p"]);
  });

  it("does not count an item that has at least one tooth in the drawn arch", () => {
    expect(offArchItems([mixed], "permanent")).toEqual([]);
    expect(offArchItems([mixed], "deciduous")).toEqual([]);
  });

  it("counts nothing when both dentitions are drawn", () => {
    expect(offArchItems([permanent, deciduous], "combined")).toEqual([]);
    expect(offArchItems([permanent, deciduous], "base")).toEqual([]);
  });

  it("does not claim a tooth-less item is off-arch, because it is unplaced instead", () => {
    expect(offArchItems([item({ id: "u", teeth: [], rawTeeth: "whole mouth" })], "permanent")).toEqual(
      [],
    );
  });
});

/**
 * The third way a finding can be invisible on the arch.
 *
 * A whole-tooth item has no surfaces and gets the crown ring. An unplaced item
 * has no teeth and gets a status-bar count. But an item with a REAL tooth and a
 * surface index we cannot place has neither, and before unreadSurfaceItems
 * existed it drew precisely nothing: a molar restoration on Dentally's surface 6
 * rendered as a clean, unmarked tooth.
 */
describe("surfaces we could not place", () => {
  const numbered = item({ surfaces: [], rawSurfaces: "6", unrecognisedSurfaces: ["6"] });

  it("marks a tooth whose only finding names a surface index we cannot place", () => {
    expect(unreadSurfaceItems(16, [numbered])).toHaveLength(1);
    // A different tooth is not marked by it.
    expect(unreadSurfaceItems(26, [numbered])).toHaveLength(0);
  });

  it("does not mark a tooth whose surfaces were read, or a whole-tooth item", () => {
    expect(unreadSurfaceItems(16, [item()])).toHaveLength(0);
    expect(
      unreadSurfaceItems(16, [item({ surfaces: [], rawSurfaces: "", wholeTooth: true })]),
    ).toHaveLength(0);
    // A partly-read value still fills its known regions, so the arch already
    // shows the finding and a second mark would be noise.
    expect(
      unreadSurfaceItems(16, [item({ surfaces: ["mesial"], unrecognisedSurfaces: ["X"] })]),
    ).toHaveLength(0);
  });

  it("counts them across the whole read, for the always-visible status line", () => {
    expect(unreadSurfaceCount([numbered, item(), numbered])).toBe(2);
    expect(unreadSurfaceCount([])).toBe(0);
  });
});

/**
 * THE INTEGRATION SEAM, and the defect it was built to close.
 *
 * The renderer walked SURFACE NAMES and live Dentally sends INDICES, so on a real
 * patient `item.surfaces` was empty on every row: nothing filled, and because
 * unreadSurfaceItems keyed on `unrecognisedSurfaces` a placeable index got no
 * "could not place" ring either. A patient with a full restorative history drew
 * thirty-two clean teeth — a positive clinical claim manufactured by two halves of
 * one feature disagreeing about the vocabulary.
 *
 * Every case below is written against REGIONS, because a region is the thing that
 * gets painted, and the two vocabularies have to meet on it.
 */
describe("filling from Dentally's surface indices", () => {
  /** A live row: no letters, just the numbers Dentally actually sends. */
  const live = (indices: number[], teeth = [16], over: Partial<ChartItem> = {}) => ({
    ...item({ teeth, surfaces: [], rawSurfaces: indices.join(","), ...over }),
    surfaceIndices: indices,
  });
  const regionOf = (fdi: number, index: number) => {
    const region = regionForIndex(fdi, index);
    if (!region) throw new Error(`no region ${index} on ${fdi}`);
    return region;
  };

  it("fills the region an index names, on a tooth that holds it", () => {
    const items = [live([3], [16], { completed: true })];
    // 3 is the bottom trapezoid on every tooth, which on an UPPER RIGHT tooth is
    // the lingual side. The surface NAME is only the click target; the fill is
    // decided by the index.
    expect(regionOrigin(16, "lingual", regionOf(16, 3), items, PLANS, {})).toBe(
      "dentally-completed",
    );
    // ...and nothing else on that tooth is filled by it.
    expect(regionOrigin(16, "buccal", regionOf(16, 1), items, PLANS, {})).toBe("none");
  });

  it("gives each centre quadrant of a molar its own answer", () => {
    const items = [live([7])];
    expect(regionOrigin(16, "occlusal", regionOf(16, 7), items, PLANS, {})).toBe(
      "dentally-planned",
    );
    // The other three quadrants are NOT filled. Rolling a molar's centre up to one
    // occlusal answer would paint the whole table for a filling on one quadrant.
    for (const other of [5, 6, 8]) {
      expect(regionOrigin(16, "occlusal", regionOf(16, other), items, PLANS, {})).toBe("none");
    }
  });

  it("still fills every region of a NAMED surface, so the mock and the draft are unchanged", () => {
    // "O" is the whole occlusal table, so on a molar it lights all four quadrants.
    const named = [item({ surfaces: ["occlusal"], completed: true })];
    for (const q of [5, 6, 7, 8]) {
      expect(regionOrigin(16, "occlusal", regionOf(16, q), named, PLANS, {})).toBe(
        "dentally-completed",
      );
    }
    // And a draft, which is stored as letters and has no index to offer.
    expect(regionOrigin(16, "mesial", regionOf(16, 2), [], PLANS, { "16:121": DRAFT_ENTRY })).toBe(
      "draft",
    );
  });

  it("draws an index on the tooth that holds it and NOWHERE on a sibling that does not", () => {
    // One row, two teeth, one index: a bridge keeps the molar's 7 and the incisor
    // beside it has no seventh region. Clamping 7 onto the incisor's centre would
    // record a filling on a surface Dentally never named.
    const bridge = [live([7], [16, 11])];
    expect(regionOrigin(16, "occlusal", regionOf(16, 7), bridge, PLANS, {})).toBe(
      "dentally-planned",
    );
    expect(regionOrigin(11, "occlusal", regionOf(11, 5), bridge, PLANS, {})).toBe("none");
    // And the incisor says so, rather than silently showing nothing.
    expect(unreadSurfaceItems(11, bridge)).toHaveLength(1);
    expect(unreadValuesFor(11, bridge)).toEqual(["7"]);
    // The molar drew it, so the molar is not marked.
    expect(unreadSurfaceItems(16, bridge)).toHaveLength(0);
  });

  it("no longer rings a tooth whose index we CAN place", () => {
    // The whole point: a live single-surface filling fills its region and gets no
    // "we could not place this" mark. Both at once was the old broken pair.
    const items = [live([5], [11])];
    expect(regionOrigin(11, "occlusal", regionOf(11, 5), items, PLANS, {})).toBe(
      "dentally-planned",
    );
    expect(unreadSurfaceItems(11, items)).toHaveLength(0);
    expect(unreadSurfaceCount(items)).toBe(0);
  });

  it("counts a row that draws on none of its teeth, and only such a row", () => {
    const unplaceable = item({ surfaces: [], rawSurfaces: "zz", unrecognisedSurfaces: ["ZZ"] });
    // An examination names no tooth and no surface. Counting it printed a large
    // "could not place" figure on every patient.
    const exam = item({ id: "exam", teeth: [], rawTeeth: "", surfaces: [] });
    expect(unreadSurfaceCount([unplaceable, live([5], [11]), exam, item()])).toBe(1);
  });

  it("rolls the regions up when a caller asks by surface name", () => {
    const items = [live([7])];
    // surfaceOrigin is the roll-up: ANY region of the occlusal box side is filled.
    expect(surfaceOrigin(16, "occlusal", items, PLANS, {})).toBe("dentally-planned");
    expect(surfaceOrigin(16, "buccal", items, PLANS, {})).toBe("none");
  });
});
