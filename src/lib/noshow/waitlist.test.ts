import { describe, it, expect } from "vitest";
import { matches, pickCandidate } from "./waitlist";
import type { FreedSlot, WaitlistEntry } from "./types";

function entry(overrides: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: "w1",
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    patientName: "Sam Lee",
    treatment: null,
    practitionerPref: null,
    earliestAt: null,
    latestAt: null,
    durationMin: 30,
    consent: { sms: true, email: true, marketing: false },
    status: "waiting",
    createdAt: "2026-06-20T09:00:00.000Z",
    ...overrides,
  };
}

const slot: FreedSlot = {
  appointmentId: "appt-9",
  siteId: "site-cc",
  startAt: "2026-06-29T10:00:00.000Z",
  durationMin: 30,
  practitioner: "Dr Khan",
};

describe("matches", () => {
  it("matches a waiting entry at the same site that fits the slot", () => {
    expect(matches(entry(), slot)).toBe(true);
  });

  it("rejects a non-waiting entry", () => {
    expect(matches(entry({ status: "offered" }), slot)).toBe(false);
  });

  it("rejects a different site", () => {
    expect(matches(entry({ siteId: "site-rv" }), slot)).toBe(false);
  });

  it("rejects a practitioner-preference mismatch but allows no-preference", () => {
    expect(matches(entry({ practitionerPref: "Dr Other" }), slot)).toBe(false);
    expect(matches(entry({ practitionerPref: "Dr Khan" }), slot)).toBe(true);
    expect(matches(entry({ practitionerPref: null }), slot)).toBe(true);
  });

  it("rejects when the patient needs more time than the freed slot", () => {
    expect(matches(entry({ durationMin: 60 }), slot)).toBe(false);
  });

  it("honours the patient's acceptable window", () => {
    expect(matches(entry({ earliestAt: "2026-06-30T00:00:00Z" }), slot)).toBe(false); // slot before earliest
    expect(matches(entry({ latestAt: "2026-06-28T00:00:00Z" }), slot)).toBe(false); // slot after latest
    expect(matches(entry({ earliestAt: "2026-06-28T00:00:00Z", latestAt: "2026-06-30T00:00:00Z" }), slot)).toBe(true);
  });
});

describe("pickCandidate", () => {
  it("picks the longest-waiting eligible entry", () => {
    const a = entry({ id: "a", createdAt: "2026-06-22T09:00:00Z" });
    const b = entry({ id: "b", createdAt: "2026-06-19T09:00:00Z" }); // waiting longest
    const c = entry({ id: "c", createdAt: "2026-06-25T09:00:00Z" });
    expect(pickCandidate([a, b, c], slot)!.id).toBe("b");
  });

  it("skips excluded ids (already offered)", () => {
    const a = entry({ id: "a", createdAt: "2026-06-19T09:00:00Z" });
    const b = entry({ id: "b", createdAt: "2026-06-22T09:00:00Z" });
    expect(pickCandidate([a, b], slot, new Set(["a"]))!.id).toBe("b");
  });

  it("returns null when nobody is eligible", () => {
    expect(pickCandidate([entry({ siteId: "site-rv" })], slot)).toBeNull();
    expect(pickCandidate([], slot)).toBeNull();
  });
});
