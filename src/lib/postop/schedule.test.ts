import { describe, it, expect } from "vitest";
import { dueAtFor, isStale, decideSend, notBeforeFor, SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR } from "./schedule";
import { DEFAULT_POSTOP_CONFIG } from "./types";

const CONFIG = DEFAULT_POSTOP_CONFIG;

/** The London wall-clock hour of an ISO instant, for readable assertions. */
function londonHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(iso)),
  );
}

function londonDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

describe("when the check-in becomes due", () => {
  it("is 20 hours after the procedure, when that lands inside the send window", () => {
    // 2026-08-18 is BST. A procedure finishing at 10:00 becomes due at 06:00 the
    // next day, which the window pushes to 08:00.
    const due = dueAtFor("2026-08-18T09:00:00.000Z", CONFIG);
    expect(due).not.toBeNull();
    expect(londonDate(due as string)).toBe("2026-08-19");
    expect(londonHour(due as string)).toBe(SEND_WINDOW_START_HOUR);
  });

  it("an afternoon procedure lands in the next day's late morning, not at dawn", () => {
    // 15:00 BST + 20h = 11:00 the next day. Already inside the window, untouched.
    const due = dueAtFor("2026-08-18T14:00:00.000Z", CONFIG);
    expect(londonDate(due as string)).toBe("2026-08-19");
    expect(londonHour(due as string)).toBe(11);
  });

  it("a late-evening procedure is pushed to the following morning, never the night", () => {
    // 19:30 BST + 20h = 15:30 next day. Inside the window.
    const due = dueAtFor("2026-08-18T18:30:00.000Z", CONFIG);
    expect(londonHour(due as string)).toBeGreaterThanOrEqual(SEND_WINDOW_START_HOUR);
    expect(londonHour(due as string)).toBeLessThan(SEND_WINDOW_END_HOUR);
  });

  it("never falls inside quiet hours, whatever the procedure time", () => {
    for (let h = 0; h < 24; h += 1) {
      const iso = `2026-08-18T${String(h).padStart(2, "0")}:00:00.000Z`;
      const due = dueAtFor(iso, CONFIG);
      expect(due, iso).not.toBeNull();
      const hour = londonHour(due as string);
      expect(hour, `${iso} -> ${due}`).toBeGreaterThanOrEqual(SEND_WINDOW_START_HOUR);
      expect(hour, `${iso} -> ${due}`).toBeLessThan(SEND_WINDOW_END_HOUR);
    }
  });

  it("refuses an unreadable procedure time rather than sending now", () => {
    expect(dueAtFor("", CONFIG)).toBeNull();
    expect(dueAtFor("not a date", CONFIG)).toBeNull();
  });
});

describe("staleness — the guard that makes the quiet-hours clamp safe", () => {
  const PROC = "2026-08-18T09:00:00.000Z";

  it("is not stale the next morning", () => {
    expect(isStale(PROC, new Date("2026-08-19T09:00:00.000Z"), CONFIG)).toBe(false);
  });

  it("is stale after the configured ceiling", () => {
    expect(isStale(PROC, new Date("2026-08-20T10:00:00.000Z"), CONFIG)).toBe(true);
  });

  it("treats an unreadable time as STALE, not as fresh", () => {
    expect(isStale("nonsense", new Date(), CONFIG)).toBe(true);
  });
});

describe("decideSend", () => {
  const target = (over: Partial<{ procedureAt: string; dueAt: string }> = {}) => ({
    procedureAt: "2026-08-18T09:00:00.000Z",
    dueAt: "2026-08-19T07:00:00.000Z",
    ...over,
  });

  it("waits before the due time", () => {
    const d = decideSend(target(), new Date("2026-08-19T06:00:00.000Z"), CONFIG);
    expect(d).toEqual({ action: "wait", until: "2026-08-19T07:00:00.000Z" });
  });

  it("sends at or after the due time", () => {
    expect(decideSend(target(), new Date("2026-08-19T07:00:00.000Z"), CONFIG).action).toBe("send");
    expect(decideSend(target(), new Date("2026-08-19T09:00:00.000Z"), CONFIG).action).toBe("send");
  });

  it("drops a stale target rather than sending a check-in three days late", () => {
    const d = decideSend(target(), new Date("2026-08-21T09:00:00.000Z"), CONFIG);
    expect(d).toEqual({ action: "drop", reason: "stale" });
  });

  it("CHECKS STALENESS BEFORE DUENESS, so a stale target is never merely parked", () => {
    // Representable only through a clock skew or a bad Dentally timestamp: a target
    // that is both stale and not yet due. Parking it would keep a message that can
    // only get more wrong the longer it waits.
    const d = decideSend(
      target({ dueAt: "2099-01-01T00:00:00.000Z" }),
      new Date("2026-08-21T09:00:00.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "drop", reason: "stale" });
  });

  it("drops an undatable target", () => {
    expect(decideSend(target({ procedureAt: "" }), new Date(), CONFIG)).toEqual({
      action: "drop",
      reason: "undatable",
    });
    expect(
      decideSend(target({ dueAt: "rubbish" }), new Date("2026-08-19T09:00:00.000Z"), CONFIG),
    ).toEqual({ action: "drop", reason: "undatable" });
  });
});

describe("notBeforeFor — quiet hours on the outbox row", () => {
  it("an approval inside the window queues for immediately", () => {
    const at = new Date("2026-08-19T10:00:00.000Z"); // 11:00 London
    expect(notBeforeFor(at)).toBe(at.toISOString());
  });

  it("an approval at 22:30 queues for 08:00 the next morning", () => {
    const at = new Date("2026-08-19T21:30:00.000Z"); // 22:30 London
    const nb = notBeforeFor(at);
    expect(londonDate(nb)).toBe("2026-08-20");
    expect(londonHour(nb)).toBe(SEND_WINDOW_START_HOUR);
  });

  it("an approval at 06:00 queues for 08:00 the same morning", () => {
    const at = new Date("2026-08-19T05:00:00.000Z"); // 06:00 London
    const nb = notBeforeFor(at);
    expect(londonDate(nb)).toBe("2026-08-19");
    expect(londonHour(nb)).toBe(SEND_WINDOW_START_HOUR);
  });

  it("never returns an instant inside quiet hours, at any hour of the day", () => {
    for (let h = 0; h < 24; h += 1) {
      const at = new Date(`2026-08-19T${String(h).padStart(2, "0")}:15:00.000Z`);
      const hour = londonHour(notBeforeFor(at));
      expect(hour, at.toISOString()).toBeGreaterThanOrEqual(SEND_WINDOW_START_HOUR);
      expect(hour, at.toISOString()).toBeLessThan(SEND_WINDOW_END_HOUR);
    }
  });

  it("uses the diary's window, so the practice has ONE definition of quiet hours", () => {
    expect(SEND_WINDOW_START_HOUR).toBe(8);
    expect(SEND_WINDOW_END_HOUR).toBe(20);
  });
});
