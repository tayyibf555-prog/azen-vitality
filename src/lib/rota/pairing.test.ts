import { describe, it, expect } from "vitest";
import { autoPair, unpairedAfter } from "./pairing";
import type { RotaConfig, RotaShift } from "./types";

const CONFIG: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 1,
  pairRoles: { clinical: "dentist", support: "nurse" },
};

function shift(over: Partial<RotaShift> & Pick<RotaShift, "id" | "staffId" | "role">): RotaShift {
  return {
    clientId: "vitality",
    siteId: "site-a",
    shiftDate: "2026-07-09",
    startTime: "09:00",
    endTime: "17:30",
    status: "scheduled",
    origin: "generated",
    pairedStaffId: null,
    ...over,
  } as RotaShift;
}

const dentist = (id: string) => shift({ id: `s-${id}`, staffId: id, role: "dentist" });
const nurse = (id: string) => shift({ id: `s-${id}`, staffId: id, role: "nurse" });

/** The pairing as a plain map, so an assertion reads as "who is with whom". */
function asMap(assignments: ReturnType<typeof autoPair>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of assignments) out[a.staffId] = a.pairedStaffId;
  return out;
}

describe("autoPair", () => {
  it("pairs a dentist with a nurse, both ways round", () => {
    // Both halves, always. A one-way pairing means one of the two screens tells
    // somebody the wrong thing about who they are working with.
    expect(asMap(autoPair([dentist("d1"), nurse("n1")], CONFIG))).toEqual({ d1: "n1", n1: "d1" });
  });

  it("is stable across runs: the same day always produces the same pairing", () => {
    // THE NAMED PROPERTY. Regeneration happens constantly (every page load, every
    // sweep tick). A pairing that reshuffled each time would tell the team something
    // different every morning for no reason at all.
    //
    // THE ROW ORDER HERE IS CHOSEN, not incidental. The support staff arrive n2 THEN
    // n1, so an implementation that simply took them in arrival order would pair
    // d1 with n2 -- a different answer from the sorted one. An earlier version of
    // this test used an order where both implementations happened to agree, so
    // deleting the sort left it green: it proved determinism against itself and
    // nothing about the rule.
    const day = [dentist("d1"), dentist("d2"), nurse("n2"), nurse("n1")];
    const first = autoPair(day, CONFIG);
    expect(asMap(first)).toEqual({ d1: "n1", n1: "d1", d2: "n2", n2: "d2" });
    expect(autoPair(day, CONFIG)).toEqual(first);
    // ...and it does not depend on the order the rows arrived in.
    const shuffled = [nurse("n2"), dentist("d2"), nurse("n1"), dentist("d1")];
    expect(asMap(autoPair(shuffled, CONFIG))).toEqual(asMap(first));
  });

  it("leaves the extra clinician unpaired rather than sharing a nurse", () => {
    // Two dentists, one nurse. Giving the nurse to both would read as a fully
    // staffed day and it is not one.
    const pairs = asMap(autoPair([dentist("d1"), dentist("d2"), nurse("n1")], CONFIG));
    expect(pairs).toEqual({ d1: "n1", n1: "d1" });
    expect(pairs.d2).toBeUndefined();
  });

  it("never pairs across sites", () => {
    const day = [dentist("d1"), shift({ id: "s-n1", staffId: "n1", role: "nurse", siteId: "site-b" })];
    expect(autoPair(day, CONFIG)).toEqual([]);
  });

  it("pairs within each site independently", () => {
    const day = [
      dentist("d1"),
      nurse("n1"),
      shift({ id: "s-d2", staffId: "d2", role: "dentist", siteId: "site-b" }),
      shift({ id: "s-n2", staffId: "n2", role: "nurse", siteId: "site-b" }),
    ];
    expect(asMap(autoPair(day, CONFIG))).toEqual({ d1: "n1", n1: "d1", d2: "n2", n2: "d2" });
  });

  it("leaves an existing sound pairing alone rather than re-deriving it", () => {
    // Whoever set it meant it. Re-deriving every run would overwrite a manager's
    // deliberate pairing with the alphabetical one.
    const day = [
      shift({ id: "s-d1", staffId: "d1", role: "dentist", pairedStaffId: "n2" }),
      shift({ id: "s-n2", staffId: "n2", role: "nurse", pairedStaffId: "d1" }),
      nurse("n1"),
    ];
    expect(autoPair(day, CONFIG)).toEqual([]);
  });

  it("re-derives a STALE pairing whose partner is not working that day", () => {
    const day = [
      shift({ id: "s-d1", staffId: "d1", role: "dentist", pairedStaffId: "n9" }),
      nurse("n1"),
    ];
    expect(asMap(autoPair(day, CONFIG))).toEqual({ d1: "n1", n1: "d1" });
  });

  it("re-derives a one-way pairing rather than leaving the two shifts disagreeing", () => {
    const day = [
      shift({ id: "s-d1", staffId: "d1", role: "dentist", pairedStaffId: "n1" }),
      shift({ id: "s-n1", staffId: "n1", role: "nurse", pairedStaffId: null }),
    ];
    expect(asMap(autoPair(day, CONFIG))).toEqual({ d1: "n1", n1: "d1" });
  });

  it("ignores cancelled and tombstoned shifts", () => {
    const day = [
      dentist("d1"),
      shift({ id: "s-n1", staffId: "n1", role: "nurse", status: "removed" }),
      shift({ id: "s-n2", staffId: "n2", role: "nurse", status: "cancelled" }),
    ];
    expect(autoPair(day, CONFIG)).toEqual([]);
  });

  it("does nothing at all when the practice has switched pairing off", () => {
    expect(autoPair([dentist("d1"), nurse("n1")], { ...CONFIG, pairRoles: null })).toEqual([]);
  });

  it("falls back to the default pair when a config predates pairing entirely", () => {
    // A stored config with no pairRoles key must not read as "pairing off", or every
    // practice already using the rota silently loses it.
    const legacy: RotaConfig = { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 };
    expect(asMap(autoPair([dentist("d1"), nurse("n1")], legacy))).toEqual({ d1: "n1", n1: "d1" });
  });

  it("honours a practice that pairs different roles", () => {
    const hygieneLed: RotaConfig = { ...CONFIG, pairRoles: { clinical: "hygienist", support: "nurse" } };
    const day = [shift({ id: "s-h1", staffId: "h1", role: "hygienist" }), nurse("n1"), dentist("d1")];
    expect(asMap(autoPair(day, hygieneLed))).toEqual({ h1: "n1", n1: "h1" });
  });

  it("skips rows with no id, since there is nothing to point a pairing at", () => {
    const unsaved = { ...dentist("d1"), id: undefined } as RotaShift;
    expect(autoPair([unsaved, nurse("n1")], CONFIG)).toEqual([]);
  });
});

describe("unpairedAfter", () => {
  it("names the clinician left without a partner", () => {
    const day = [dentist("d1"), dentist("d2"), nurse("n1")];
    expect(unpairedAfter(day, autoPair(day, CONFIG), CONFIG)).toEqual(["d2"]);
  });

  it("is empty when everybody has a partner", () => {
    const day = [dentist("d1"), nurse("n1")];
    expect(unpairedAfter(day, autoPair(day, CONFIG), CONFIG)).toEqual([]);
  });

  it("ignores roles that are not part of the pair at all", () => {
    const day = [shift({ id: "s-r1", staffId: "r1", role: "reception" })];
    expect(unpairedAfter(day, [], CONFIG)).toEqual([]);
  });
});
