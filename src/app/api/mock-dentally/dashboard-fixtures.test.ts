// ===========================================================================
// THE MOCK MUST NOT BE TIDIER THAN THE PRACTICE.
//
// The diary draws SEVEN state marks, exactly the notation the practice was
// trained on: P pending, C confirmed, a clock for arrived, S in surgery, a tick
// for completed, X cancelled, DNA did-not-attend. The generated book emitted
// only four of them (Completed / Cancelled / Did-not-attend / Confirmed) plus
// "booked", so pending, arrived and in-surgery were unreachable on screen: three
// correctly-built treatments that nobody could ever have reviewed.
//
// A mock tidier than production has hidden four defects in this repo already, so
// the vocabulary is pinned here rather than left to a screenshot.
//
// stateFor is tested DIRECTLY with an explicit clock rather than by sampling
// generatedAppointments() at whatever hour the suite happens to run, so nothing
// in this file is a time bomb: the only clock it knows is the one it passes in.
// ===========================================================================

import { describe, it, expect } from "vitest";

import { normaliseAppointmentState } from "@/lib/dentally/appointment-state";
import { generatedAppointments, stateFor } from "./_dashboard-fixtures";

/** The seven marks the diary can draw. "booked" is deliberately NOT among them. */
const DIARY_STATES = [
  "pending",
  "confirmed",
  "arrived",
  "in_surgery",
  "completed",
  "cancelled",
  "did_not_attend",
] as const;

/** A seeded-looking generator that walks a fixed ramp, so every branch is reachable. */
function ramp(step = 0.01): () => number {
  let v = -step;
  return () => {
    v += step;
    return Math.min(0.999, v);
  };
}

/** Every state `stateFor` can return for one (daysBack, slotHour, nowHour) case. */
function reachable(daysBack: number, slotHour: number, nowHour: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const rand = () => i / 1000;
    out.add(normaliseAppointmentState(stateFor(rand, daysBack, slotHour, nowHour)));
  }
  return out;
}

describe("stateFor emits Dentally's whole state vocabulary", () => {
  it("never emits the mock's legacy 'booked', in any branch", () => {
    const seen = new Set<string>();
    for (const daysBack of [-30, -1, 0, 1, 45]) {
      for (let slotHour = 8; slotHour <= 18; slotHour += 1) {
        for (const nowHour of [8, 11, 14, 17]) {
          for (const s of reachable(daysBack, slotHour, nowHour)) seen.add(s);
        }
      }
    }
    expect(seen.has("booked")).toBe(false);
    // and nothing invented either: every value maps to a mark the diary draws.
    expect([...seen].sort()).toEqual([...DIARY_STATES].sort());
  });

  it("puts nothing that has already happened on a FUTURE day", () => {
    const future = reachable(-3, 10, 11);
    expect(future.has("completed")).toBe(false);
    expect(future.has("arrived")).toBe(false);
    expect(future.has("in_surgery")).toBe(false);
    expect(future.has("did_not_attend")).toBe(false);
    // A patient CAN cancel a future booking, and the diary must be able to show it.
    expect(future.has("cancelled")).toBe(true);
    expect(future.has("pending")).toBe(true);
    expect(future.has("confirmed")).toBe(true);
  });

  it("puts a patient in the chair at the slot that contains NOW", () => {
    const live = reachable(0, 14, 14);
    expect(live.has("in_surgery")).toBe(true);
    expect(live.has("arrived")).toBe(true);
    // Nothing later today can have been sat in yet.
    const later = reachable(0, 17, 14);
    expect(later.has("in_surgery")).toBe(false);
    expect(later.has("completed")).toBe(false);
  });

  it("settles a past day into completed, cancelled and missed, with a small unclosed tail", () => {
    const past = reachable(4, 10, 14);
    expect(past.has("completed")).toBe(true);
    expect(past.has("cancelled")).toBe(true);
    expect(past.has("did_not_attend")).toBe(true);
    // The rows a practice forgot to close off. Real books carry these, and the
    // dashboard must not silently file them under a donut slice.
    expect(past.has("pending")).toBe(true);
    expect(past.has("confirmed")).toBe(true);
  });

  it("keeps completed dominant on a past day and confirmed dominant on a future one", () => {
    // A share, not a mark: a book that is 40% cancelled is not a practice.
    const share = (daysBack: number, slotHour: number, want: string): number => {
      const rand = ramp(0.001);
      let hits = 0;
      for (let i = 0; i < 1000; i += 1) {
        if (normaliseAppointmentState(stateFor(rand, daysBack, slotHour, 14)) === want) hits += 1;
      }
      return hits / 1000;
    };
    expect(share(4, 10, "completed")).toBeGreaterThan(0.6);
    expect(share(-4, 10, "confirmed")).toBeGreaterThan(0.5);
    expect(share(4, 10, "cancelled")).toBeLessThan(0.2);
    expect(share(4, 10, "did_not_attend")).toBeLessThan(0.15);
  });
});

describe("the generated book itself", () => {
  it("serves no 'booked' row anywhere in the rolling window", () => {
    const states = new Set(generatedAppointments().map((a) => normaliseAppointmentState(a.state)));
    expect(states.has("booked")).toBe(false);
    // Everything it does serve is a mark the diary can draw.
    for (const s of states) expect(DIARY_STATES as readonly string[]).toContain(s);
  });

  it("carries pending, cancelled and did-not-attend rows a reviewer can actually find", () => {
    const rows = generatedAppointments().map((a) => normaliseAppointmentState(a.state));
    for (const wanted of ["pending", "confirmed", "completed", "cancelled", "did_not_attend"]) {
      expect(rows.filter((s) => s === wanted).length).toBeGreaterThan(0);
    }
  });
});
