// ===========================================================================
// WHICH PRACTICE IS THIS CLINICIAN AT?
//
// The rule this file pins is the one that stops another practice's free time
// being painted as this practice's capacity. Availability carries no site and
// takes no site parameter, so the ONLY site-scoped signal is a booking here.
// ===========================================================================

import { describe, it, expect } from "vitest";
import { availabilityTrustedHere } from "./site-presence";

describe("availabilityTrustedHere", () => {
  it("trusts a clinician who works at exactly one of these practices", () => {
    expect(
      availabilityTrustedHere({
        sharedWithAnotherSite: false,
        rosterUnknown: false,
        bookedHere: false,
      }),
    ).toBe(true);
  });

  it("REFUSES a multi-site clinician with nothing booked here", () => {
    // This is the whole point. Their windows may be their session at the other
    // practice, and painting them white here offers that practice's gaps as this
    // one's capacity.
    expect(
      availabilityTrustedHere({
        sharedWithAnotherSite: true,
        rosterUnknown: false,
        bookedHere: false,
      }),
    ).toBe(false);
  });

  it("trusts a multi-site clinician once a booking here puts them in the building", () => {
    expect(
      availabilityTrustedHere({
        sharedWithAnotherSite: true,
        rosterUnknown: false,
        bookedHere: true,
      }),
    ).toBe(true);
  });

  it("demands corroboration from EVERYBODY when we could not read the other lists", () => {
    // With no roster picture we cannot tell who is multi-site, so nobody is
    // assumed to be single-site. The busy columns keep working; the empty ones
    // say they cannot be confirmed.
    expect(
      availabilityTrustedHere({
        sharedWithAnotherSite: false,
        rosterUnknown: true,
        bookedHere: false,
      }),
    ).toBe(false);
    expect(
      availabilityTrustedHere({
        sharedWithAnotherSite: false,
        rosterUnknown: true,
        bookedHere: true,
      }),
    ).toBe(true);
  });

  it("never trusts on the strength of sharing alone", () => {
    // A table of every input combination, so a later edit cannot quietly flip one.
    const rows: Array<[boolean, boolean, boolean, boolean]> = [
      // shared, rosterUnknown, bookedHere, expected
      [false, false, false, true],
      [false, false, true, true],
      [false, true, false, false],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, true, true],
      [true, true, false, false],
      [true, true, true, true],
    ];
    for (const [sharedWithAnotherSite, rosterUnknown, bookedHere, expected] of rows) {
      expect(
        availabilityTrustedHere({ sharedWithAnotherSite, rosterUnknown, bookedHere }),
      ).toBe(expected);
    }
  });
});
