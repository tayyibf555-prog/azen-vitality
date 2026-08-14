import { describe, it, expect } from "vitest";
import { MAX_BACKDATE_DAYS, validateAdjustment } from "./adjust";
import type { ClockEvent, ClockKind } from "@/lib/clock/types";

const NOW = new Date("2026-06-12T10:00:00Z");

function tap(kind: ClockKind, iso: string, staffId = "s1"): ClockEvent {
  return {
    id: `${staffId}-${kind}-${iso}`,
    clientId: "vitality",
    siteId: "site-cc",
    staffId,
    kind,
    occurredAt: iso,
    source: "manual",
  };
}

function input(over: Partial<Parameters<typeof validateAdjustment>[0]> = {}) {
  return {
    staffId: "s1",
    kind: "out" as ClockKind,
    occurredAt: "2026-06-11T16:30:00Z",
    reason: "Forgot to clock out; left at half past five.",
    ...over,
  };
}

describe("validateAdjustment", () => {
  it("RECORDS THE MISSING CLOCK OUT: the case the whole route exists for", () => {
    // Clocked in yesterday morning, never clocked out, clocked in again today.
    const events = [tap("in", "2026-06-11T08:00:00Z"), tap("in", "2026-06-12T08:00:00Z")];
    expect(validateAdjustment(input(), events, NOW)).toEqual({ ok: true });
  });

  it("accepts a correction for somebody with no history at all", () => {
    expect(validateAdjustment(input({ kind: "in" }), [], NOW)).toEqual({ ok: true });
  });

  it("refuses a time in the future", () => {
    const check = validateAdjustment(input({ occurredAt: "2026-06-12T18:00:00Z" }), [], NOW);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("future");
  });

  it("refuses a time it cannot read, rather than guessing one", () => {
    expect(validateAdjustment(input({ occurredAt: "yesterday teatime" }), [], NOW).ok).toBe(false);
  });

  it("REFUSES A TIME WITH NO TIME ZONE", () => {
    // A browser's datetime-local field yields "2026-06-11T17:30". Date.parse
    // resolves that against the LOCAL clock, so the manager's laptop means half
    // past five in London and the UTC server means half past five UTC: in British
    // Summer Time that is an hour of somebody's pay, silently.
    const check = validateAdjustment(input({ occurredAt: "2026-06-11T17:30" }), [], NOW);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("time zone");
  });

  it("accepts an explicit offset as well as Z", () => {
    expect(validateAdjustment(input({ occurredAt: "2026-06-11T17:30:00+01:00" }), [], NOW).ok).toBe(true);
  });

  it("refuses a reach further back than the correction window", () => {
    const old = new Date(NOW.getTime() - (MAX_BACKDATE_DAYS + 1) * 86_400_000).toISOString();
    const check = validateAdjustment(input({ occurredAt: old }), [], NOW);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("cannot reach back");
  });

  it("allows the previous month, which is the month being paid", () => {
    const lastMonth = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    expect(validateAdjustment(input({ occurredAt: lastMonth }), [], NOW).ok).toBe(true);
  });

  it("A REASON IS MANDATORY", () => {
    // A hand-written attendance record with no explanation is the thing an
    // employment dispute asks about first.
    expect(validateAdjustment(input({ reason: "" }), [], NOW).ok).toBe(false);
    expect(validateAdjustment(input({ reason: "   " }), [], NOW).ok).toBe(false);
    expect(validateAdjustment(input({ reason: "x" }), [], NOW).ok).toBe(false);
  });

  it("refuses an over-long reason rather than silently truncating the record", () => {
    expect(validateAdjustment(input({ reason: "a".repeat(400) }), [], NOW).ok).toBe(false);
  });

  it("refuses a kind that is neither in nor out", () => {
    expect(validateAdjustment(input({ kind: "break" as ClockKind }), [], NOW).ok).toBe(false);
  });

  it("refuses an exact duplicate, so a double submit records one entry", () => {
    const events = [tap("in", "2026-06-11T08:00:00Z"), tap("out", "2026-06-11T16:30:00Z")];
    const check = validateAdjustment(input(), events, NOW);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("already recorded");
  });

  it("REFUSES A SECOND CLOCK OUT IN A ROW", () => {
    const events = [tap("in", "2026-06-11T08:00:00Z"), tap("out", "2026-06-11T15:00:00Z")];
    const check = validateAdjustment(input({ occurredAt: "2026-06-11T16:30:00Z" }), events, NOW);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("already clocked out");
  });

  it("refuses a second clock in in a row", () => {
    const events = [tap("in", "2026-06-11T08:00:00Z")];
    const check = validateAdjustment(
      input({ kind: "in", occurredAt: "2026-06-11T09:00:00Z" }),
      events,
      NOW,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("already clocked in");
  });

  it("refuses a correction whose NEXT neighbour is the same kind", () => {
    // Inserting an "in" before an existing "in" leaves two arrivals in a row.
    const events = [tap("in", "2026-06-11T12:00:00Z")];
    const check = validateAdjustment(
      input({ kind: "in", occurredAt: "2026-06-11T08:00:00Z" }),
      events,
      NOW,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("two arrivals in a row");
  });

  it("ignores other people's events entirely", () => {
    // Somebody else's clock-out must not block this person's correction.
    const events = [tap("out", "2026-06-11T15:00:00Z", "s2"), tap("in", "2026-06-11T08:00:00Z")];
    expect(validateAdjustment(input(), events, NOW).ok).toBe(true);
  });

  it("is order independent: the events may arrive in any order", () => {
    const events = [tap("in", "2026-06-12T08:00:00Z"), tap("in", "2026-06-11T08:00:00Z")];
    expect(validateAdjustment(input(), events, NOW)).toEqual({ ok: true });
    expect(validateAdjustment(input(), [...events].reverse(), NOW)).toEqual({ ok: true });
  });

  it("ignores an event whose stored time cannot be read", () => {
    const events = [tap("in", "2026-06-11T08:00:00Z"), tap("out", "not-a-time")];
    expect(validateAdjustment(input(), events, NOW).ok).toBe(true);
  });
});
