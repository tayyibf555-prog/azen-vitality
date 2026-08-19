import { describe, it, expect } from "vitest";

/**
 * The pure rules behind the co-pilot's lead-sight tools.
 *
 * Every one of these is a rule the tools rely on being true and cannot restate,
 * so each is asserted on its own: the window (which calendar days "today" and
 * "this week" mean, and how far back a query has to reach to hold them), the
 * stages, and the read-backs an owner is shown before they confirm a send.
 */

import { londonDayKey } from "@/lib/time/london";
import type { SpeedToLeadAttempt, SpeedToLeadLead } from "@/lib/speed-to-lead/types";
import {
  NUDGE_REFUSED_STAGES,
  OPEN_LEAD_STAGES,
  countByLondonDay,
  inDayWindow,
  londonDayWindow,
  looksTruncated,
  nudgeRefusal,
  parseBand,
  parseLimit,
  parseWindowDays,
  summariseAttempts,
  waitingMinutes,
  wasSupplied,
} from "./lead-sight";

const DAY = 86_400_000;

function lead(over: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Amara Osei",
    email: null,
    phone: "+447700900001",
    channel: "sms",
    treatmentInterest: "Invisalign",
    source: "smile-assessment",
    score: 80,
    stage: "new",
    consent: { sms: true },
    createdAt: "2026-08-18T09:00:00.000Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-08-18T09:00:00.000Z",
    nurtureStep: 0,
    nurtureNextAt: null,
    ...over,
  };
}

function attempt(over: Partial<SpeedToLeadAttempt> = {}): SpeedToLeadAttempt {
  return {
    id: "att-1",
    leadId: "lead-1",
    channel: "sms",
    toAddress: "+447700900001",
    body: "hello",
    status: "sent",
    provider: "twilio",
    providerMessageId: "SM1",
    createdAt: "2026-08-18T09:05:00.000Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("parseWindowDays / parseLimit", () => {
  it("defaults when the model said nothing", () => {
    for (const absent of [undefined, null, ""]) {
      expect(parseWindowDays(absent, { def: 7, max: 90 })).toEqual({ ok: true, days: 7 });
      expect(parseLimit(absent, { def: 50, max: 100 })).toEqual({ ok: true, limit: 50 });
    }
  });

  it("accepts both ends of the range", () => {
    expect(parseWindowDays(1, { def: 7, max: 90 })).toEqual({ ok: true, days: 1 });
    expect(parseWindowDays(90, { def: 7, max: 90 })).toEqual({ ok: true, days: 90 });
  });

  it("REFUSES an out-of-range value rather than clamping it", () => {
    // Clamping would have the model report "the last 90 days" as "the last 4000",
    // or the reverse: the owner would be told a window that was never queried.
    const over = parseWindowDays(4000, { def: 7, max: 90 });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toMatch(/between 1 and 90/);
    expect(parseWindowDays(0, { def: 7, max: 90 }).ok).toBe(false);
    expect(parseWindowDays(-1, { def: 7, max: 90 }).ok).toBe(false);
  });

  it("refuses 1e20, which IS an integer to JavaScript", () => {
    // A lower bound alone lets this through to a query nobody asked for. Same
    // lesson the drop-off route's flowVersion bound records.
    expect(Number.isInteger(1e20)).toBe(true);
    expect(parseWindowDays(1e20, { def: 7, max: 90 }).ok).toBe(false);
  });

  it("refuses a fraction and a non-number", () => {
    expect(parseWindowDays(2.5, { def: 7, max: 90 }).ok).toBe(false);
    expect(parseWindowDays("lots", { def: 7, max: 90 }).ok).toBe(false);
  });

  it("names the argument it is complaining about", () => {
    // Two different arguments, two different messages: "days must be..." for a
    // window and "limit must be..." for a page size, so the model can fix the
    // right one.
    const d = parseWindowDays(999, { def: 7, max: 90 });
    const l = parseLimit(999, { def: 50, max: 100 });
    expect(d.ok === false && d.error).toMatch(/^days /);
    expect(l.ok === false && l.error).toMatch(/^limit /);
  });
});

describe("wasSupplied", () => {
  it("tells an omitted optional argument apart from a real one", () => {
    expect(wasSupplied(undefined)).toBe(false);
    expect(wasSupplied(null)).toBe(false);
    expect(wasSupplied("")).toBe(false);
    expect(wasSupplied(0)).toBe(true);
    expect(wasSupplied(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("londonDayWindow", () => {
  it("day 1 is today, in the practice's own timezone", () => {
    const now = new Date("2026-08-18T23:30:00Z"); // 00:30 on the 19th, London (BST)
    const w = londonDayWindow(now, 1);
    expect(w.keys).toEqual(["2026-08-19"]);
    expect(w.keys[0]).toBe(londonDayKey(now));
  });

  it("runs newest first, so keys[0] is today", () => {
    const w = londonDayWindow(new Date("2026-08-18T12:00:00Z"), 3);
    expect(w.keys).toEqual(["2026-08-18", "2026-08-17", "2026-08-16"]);
  });

  it("walks CALENDAR DATES, not 24-hour steps, so a 25-hour day loses nobody", () => {
    // British Summer Time ends on 25 October 2026: that London day is 25 hours
    // long. Stepping back 86_400_000 ms from 23:30 UTC lands at 00:30 BST on the
    // SAME London day, so a naive walk repeats "2026-10-25" and never asks for
    // "2026-10-23" at all - a whole day of enquiries missing from "the last three
    // days", silently.
    const now = new Date("2026-10-25T23:30:00Z");
    expect(londonDayKey(now)).toBe("2026-10-25");
    expect(londonDayKey(new Date(now.getTime() - DAY))).toBe("2026-10-25"); // the trap

    const w = londonDayWindow(now, 3);
    expect(w.keys).toEqual(["2026-10-25", "2026-10-24", "2026-10-23"]);
    expect(new Set(w.keys).size).toBe(3);
  });

  it("survives the spring-forward 23-hour day too", () => {
    const now = new Date("2026-03-29T12:00:00Z"); // clocks went forward at 01:00 UTC
    const w = londonDayWindow(now, 3);
    expect(w.keys).toEqual(["2026-03-29", "2026-03-28", "2026-03-27"]);
  });

  it("asks the database from a full day BEFORE the oldest day starts", () => {
    // The oldest key's UTC midnight is 01:00 London in summer, so querying from
    // it would silently drop anything submitted in that first London hour -
    // including, for a days:1 question, "today" between midnight and 1am.
    const now = new Date("2026-08-18T12:00:00Z");
    const w = londonDayWindow(now, 1);
    expect(w.keys).toEqual(["2026-08-18"]);
    expect(w.sinceIso).toBe("2026-08-17T00:00:00.000Z");

    // A submission at 00:30 London on the 18th is 23:30 UTC on the 17th.
    const earlyBird = Date.parse("2026-08-17T23:30:00Z");
    expect(Date.parse(w.sinceIso)).toBeLessThan(earlyBird);
    // ...and it really is inside the window the filter enforces.
    expect(inDayWindow("2026-08-17T23:30:00Z", w)).toBe(true);
  });
});

describe("inDayWindow", () => {
  const w = londonDayWindow(new Date("2026-08-18T12:00:00Z"), 2); // 18th + 17th

  it("admits the window's days and refuses the day before it", () => {
    expect(inDayWindow("2026-08-18T09:00:00Z", w)).toBe(true);
    expect(inDayWindow("2026-08-17T09:00:00Z", w)).toBe(true);
    expect(inDayWindow("2026-08-16T22:00:00Z", w)).toBe(false); // 23:00 on the 16th, London
  });

  it("judges the boundary by the LONDON day, not the UTC one", () => {
    // 23:00 UTC on the 16th is already midnight on the 17th in London, so it is
    // inside a window that starts on the 17th. An hour earlier is not. This is the
    // whole reason the window is expressed in day keys rather than in instants.
    expect(inDayWindow("2026-08-16T23:00:00Z", w)).toBe(true);
    expect(inDayWindow("2026-08-16T22:59:00Z", w)).toBe(false);
  });

  it("refuses an absent or unparseable timestamp instead of guessing", () => {
    expect(inDayWindow(null, w)).toBe(false);
    expect(inDayWindow(undefined, w)).toBe(false);
    expect(inDayWindow("not a date", w)).toBe(false);
  });
});

describe("countByLondonDay", () => {
  const w = londonDayWindow(new Date("2026-08-18T12:00:00Z"), 3);

  it("reports EVERY day of the window, including the empty ones", () => {
    // A missing key reads as missing data; a zero reads as "nobody came in".
    const rows = [{ at: "2026-08-18T08:00:00Z" }, { at: "2026-08-18T09:00:00Z" }, { at: "2026-08-16T09:00:00Z" }];
    expect(countByLondonDay(rows, (r) => r.at, w)).toEqual([
      { day: "2026-08-18", count: 2 },
      { day: "2026-08-17", count: 0 },
      { day: "2026-08-16", count: 1 },
    ]);
  });

  it("ignores a row outside the window rather than folding it into a day", () => {
    const rows = [{ at: "2026-08-14T09:00:00Z" }];
    expect(countByLondonDay(rows, (r) => r.at, w).every((d) => d.count === 0)).toBe(true);
  });

  it("buckets by the LONDON day, not the UTC one", () => {
    // 23:30 UTC on the 17th is 00:30 on the 18th in London: it belongs to the 18th.
    const rows = [{ at: "2026-08-17T23:30:00Z" }];
    expect(countByLondonDay(rows, (r) => r.at, w)[0]).toEqual({ day: "2026-08-18", count: 1 });
  });
});

describe("looksTruncated", () => {
  it("is conservative at the boundary", () => {
    // Exactly `limit` rows cannot be told apart from "there were more", and
    // "there may be more" is the safe direction to be wrong in.
    expect(looksTruncated(100, 100)).toBe(true);
    expect(looksTruncated(99, 100)).toBe(false);
    expect(looksTruncated(0, 100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the stages", () => {
  it("calls exactly the four live stages open", () => {
    expect(OPEN_LEAD_STAGES).toEqual(["new", "contacting", "contacted", "qualifying"]);
    for (const done of ["booked", "lost", "nurture_done"]) {
      expect(OPEN_LEAD_STAGES).not.toContain(done);
    }
  });

  it("refuses a nudge to a booked or lost lead, and says which", () => {
    expect(NUDGE_REFUSED_STAGES).toEqual(["booked", "lost"]);
    expect(nudgeRefusal("booked")).toMatch(/already booked/i);
    expect(nudgeRefusal("lost")).toMatch(/closed as lost/i);
    // Two different reasons, not one shared sentence: "they are already booked"
    // and "they cannot be reached" are different things to tell an owner.
    expect(nudgeRefusal("booked")).not.toBe(nudgeRefusal("lost"));
  });

  it("allows a nudge on every non-terminal stage, and on a finished nurture", () => {
    // nurture_done is deliberately nudgeable, mirroring the Resend button on the
    // worklist: the cadence is over, the person is not.
    for (const s of ["new", "contacting", "contacted", "qualifying", "nurture_done"] as const) {
      expect(nudgeRefusal(s)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------

describe("summariseAttempts", () => {
  it("counts the tries and the failures", () => {
    const s = summariseAttempts([
      attempt({ id: "a1", status: "failed", createdAt: "2026-08-18T09:00:00Z" }),
      attempt({ id: "a2", status: "failed", createdAt: "2026-08-18T10:00:00Z" }),
      attempt({ id: "a3", status: "sent", createdAt: "2026-08-18T11:00:00Z" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.failed).toBe(2);
  });

  it("takes 'last' from the NEWEST timestamp, not the last array element", () => {
    // The batched read returns one flat result for many leads, so array order is
    // whatever the database handed back. Telling an owner the last attempt failed
    // when it succeeded (or the reverse) inverts the whole point of the summary.
    const s = summariseAttempts([
      attempt({ id: "newest", status: "sent", createdAt: "2026-08-18T11:00:00Z", channel: "email" }),
      attempt({ id: "older", status: "failed", createdAt: "2026-08-18T09:00:00Z", channel: "sms" }),
    ]);
    expect(s.lastStatus).toBe("sent");
    expect(s.lastAt).toBe("2026-08-18T11:00:00Z");
    expect(s.lastChannel).toBe("email");
  });

  it("reports nulls, not a fabricated attempt, when there have been none", () => {
    expect(summariseAttempts([])).toEqual({
      total: 0,
      failed: 0,
      lastStatus: null,
      lastAt: null,
      lastChannel: null,
    });
  });

  it("never mutates the array it is given", () => {
    const rows = [
      attempt({ id: "a", createdAt: "2026-08-18T11:00:00Z" }),
      attempt({ id: "b", createdAt: "2026-08-18T09:00:00Z" }),
    ];
    const before = rows.map((r) => r.id);
    summariseAttempts(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("waitingMinutes", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  it("measures the wait for someone nobody has contacted", () => {
    expect(waitingMinutes(lead({ createdAt: "2026-08-18T11:30:00Z" }), now)).toBe(30);
  });

  it("is null once first contact has gone out", () => {
    // "Waiting" must only ever describe someone who is.
    expect(waitingMinutes(lead({ firstResponseAt: "2026-08-18T11:00:00Z" }), now)).toBeNull();
  });

  it("clamps at zero rather than reporting a negative wait", () => {
    // Clock skew between the database and this process must read as "just now",
    // never as a negative that sorts to the top of the urgent list.
    expect(waitingMinutes(lead({ createdAt: "2026-08-18T12:05:00Z" }), now)).toBe(0);
  });

  it("is null for an unparseable created_at instead of NaN", () => {
    expect(waitingMinutes(lead({ createdAt: "nonsense" }), now)).toBeNull();
  });
});

describe("parseBand", () => {
  it("means every band when the model said nothing", () => {
    expect(parseBand(undefined)).toEqual({ ok: true, bands: null });
    expect(parseBand("")).toEqual({ ok: true, bands: null });
  });

  it("accepts the three bands, case-insensitively", () => {
    expect(parseBand("high")).toEqual({ ok: true, bands: ["high"] });
    expect(parseBand("  Medium ")).toEqual({ ok: true, bands: ["medium"] });
    expect(parseBand("LOW")).toEqual({ ok: true, bands: ["low"] });
  });

  it("REFUSES an unrecognised band rather than falling back to all of them", () => {
    // Falling back would hand the model every enquiry in answer to "show me the
    // hot ones", and the low scorers would be reported as high intent.
    const r = parseBand("hot");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("hot");
  });
});
