import { describe, it, expect } from "vitest";
import { dayKey, decideSend, dueAtFor, scanWindow } from "./schedule";
import { isTriageLinkTokenShaped, buildTriageLink, mintTriageLinkToken } from "./link";
import { triageConfig } from "./types";
import type { TriageConfig } from "./types";

// Appointment-relative scheduling + the opaque link. Both pure; both tested with
// an EXPLICIT clock, so nothing here can become a time bomb.

const CONFIG: TriageConfig = {
  leadHours: 24,
  stalenessHours: 22,
  quietStartHour: 8,
  quietEndHour: 20,
  maxExaminedPerRun: 400,
  maxQueuedPerRun: 60,
};

/** A London-noon instant on a fixed date, so the quiet-hours clamp is inert. */
const NOON = "2026-09-10T12:00:00.000Z";

describe("dueAtFor", () => {
  it("is the appointment minus the lead", () => {
    // 11 Sept noon, 24h lead -> 10 Sept noon, which is inside the send window.
    expect(dueAtFor("2026-09-11T12:00:00.000Z", CONFIG)).toBe(NOON);
  });

  it("clamps a middle-of-the-night due time forward into the send window", () => {
    // A 03:00 appointment does not exist, but a 06:00 one does, and 24h before it
    // is 06:00 — outside the 08:00-20:00 window, so it clamps to 08:00 that day.
    const due = dueAtFor("2026-09-11T06:00:00.000Z", CONFIG);
    expect(due).toBe("2026-09-10T07:00:00.000Z"); // 08:00 London = 07:00Z in BST
  });

  it("REFUSES an undatable appointment rather than sending now", () => {
    // Null is a refusal, not "send immediately". An appointment we cannot date is
    // one whose staleness we cannot establish either.
    expect(dueAtFor("not a date", CONFIG)).toBeNull();
    expect(dueAtFor("", CONFIG)).toBeNull();
  });
});

describe("decideSend", () => {
  const at = (iso: string) => new Date(iso);

  it("waits while the due time is still ahead", () => {
    const d = decideSend(
      { appointmentAt: "2026-09-11T12:00:00.000Z", dueAt: NOON },
      at("2026-09-10T09:00:00.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "wait", until: NOON });
  });

  it("sends once the due time has arrived", () => {
    const d = decideSend(
      { appointmentAt: "2026-09-11T12:00:00.000Z", dueAt: NOON },
      at("2026-09-10T12:00:01.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "send" });
  });

  // THE THREE DROPS, and the order between them is the safety property.
  it("DROPS an appointment that has already started, whatever the due time says", () => {
    // Nothing sent after this instant is a pre-visit message. "A few quick
    // questions before your visit", delivered on the way home, reads as a practice
    // that is not paying attention.
    const d = decideSend(
      { appointmentAt: "2026-09-11T12:00:00.000Z", dueAt: NOON },
      at("2026-09-11T12:00:00.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "drop", reason: "past" });
  });

  it("DROPS a target that sat unsent through an outage", () => {
    // 23 hours past due, ceiling is 22. The point is that it is retired BEFORE the
    // appointment it refers to, never fired the moment the lights come back on.
    const d = decideSend(
      { appointmentAt: "2026-09-11T12:00:00.000Z", dueAt: NOON },
      at("2026-09-11T11:00:00.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "drop", reason: "stale" });
  });

  it("DROPS an undatable target rather than parking it", () => {
    // A wait needs an instant to wait until. A target that is both stale and
    // not-yet-due is representable (clock skew, a bad Dentally timestamp) and must
    // drop rather than park: waiting on a stale target parks a message that can
    // only get more wrong.
    expect(decideSend({ appointmentAt: "x", dueAt: NOON }, at(NOON), CONFIG)).toEqual({
      action: "drop",
      reason: "undatable",
    });
    expect(decideSend({ appointmentAt: NOON, dueAt: "x" }, at(NOON), CONFIG)).toEqual({
      action: "drop",
      reason: "undatable",
    });
  });

  it("checks 'past' BEFORE 'stale', so a long-overdue appointment reports the real reason", () => {
    const d = decideSend(
      { appointmentAt: "2026-09-01T12:00:00.000Z", dueAt: "2026-08-31T12:00:00.000Z" },
      at("2026-09-10T12:00:00.000Z"),
      CONFIG,
    );
    expect(d).toEqual({ action: "drop", reason: "past" });
  });
});

describe("scanWindow", () => {
  it("is derived from the lead, so changing the lead moves the scan with it", () => {
    const w = scanWindow(at2(NOON), CONFIG, 2);
    expect(w.fromIso).toBe(NOON);
    expect(w.toIso).toBe("2026-09-11T14:00:00.000Z"); // +26h
  });

  it("carries slack, so an appointment falling between two ticks is still examined", () => {
    const tight = scanWindow(at2(NOON), CONFIG, 0);
    const slack = scanWindow(at2(NOON), CONFIG, 2);
    expect(new Date(slack.toIso).getTime()).toBeGreaterThan(new Date(tight.toIso).getTime());
  });

  it("dayKey is the YYYY-MM-DD form /v1/appointments takes", () => {
    expect(dayKey(at2(NOON))).toBe("2026-09-10");
  });
});

function at2(iso: string): Date {
  return new Date(iso);
}

describe("triageConfig", () => {
  it("defaults to a 24-hour lead and a ceiling INSIDE it", () => {
    const c = triageConfig();
    expect(c.leadHours).toBe(24);
    // 22 < 24 so a target that sat unsent through a whole outage is retired BEFORE
    // the appointment it refers to. If the ceiling equalled or exceeded the lead a
    // link could still be alive at the moment the patient walked in.
    expect(c.stalenessHours).toBeLessThan(c.leadHours);
  });

  it("refuses an out-of-range or unreadable env override rather than adopting it", () => {
    const before = process.env.PREVISIT_LEAD_HOURS;
    try {
      for (const raw of ["0", "-4", "10000", "banana", ""]) {
        process.env.PREVISIT_LEAD_HOURS = raw;
        expect(triageConfig().leadHours, `"${raw}" was adopted`).toBe(24);
      }
      process.env.PREVISIT_LEAD_HOURS = "48";
      expect(triageConfig().leadHours).toBe(48);
    } finally {
      if (before === undefined) delete process.env.PREVISIT_LEAD_HOURS;
      else process.env.PREVISIT_LEAD_HOURS = before;
    }
  });
});

describe("the opaque link", () => {
  it("mints 22 base64url characters, which is 128 bits", () => {
    const token = mintTriageLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isTriageLinkTokenShaped(token)).toBe(true);
  });

  it("mints a DIFFERENT token every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintTriageLinkToken()));
    expect(seen.size).toBe(200);
  });

  it("refuses anything that is not shaped like one of ours, before a query is made", () => {
    for (const bad of ["", "short", "a".repeat(23), "abcdefghijklmnopqrstu!", null, undefined, "../../etc"]) {
      expect(isTriageLinkTokenShaped(bad as string), `"${String(bad)}" passed the shape check`).toBe(false);
    }
  });

  // THE LENGTH IS THE POINT, and it is why this is a database id rather than the
  // signed patient token the medical-history and FP17 links use: a signed token is
  // ~170 characters and cannot fit in a one-credit message at any greeting length.
  it("builds a link short enough to leave room for a sentence", () => {
    const link = buildTriageLink(mintTriageLinkToken(), "https://azen-vitality.vercel.app");
    expect(link).toMatch(/^https:\/\/azen-vitality\.vercel\.app\/pv\/[A-Za-z0-9_-]{22}$/);
    expect((link as string).length).toBeLessThan(60);
  });

  it("carries NO patient identity in the URL", () => {
    // A signed patient token base64-encodes { siteId, patientRef }, readable by
    // anyone holding the URL — the signature stops forgery, not reading. This one
    // says nothing at all, which matters for a link that sits in a phone's message
    // list and in browser history.
    const link = buildTriageLink(mintTriageLinkToken(), "https://x.co") as string;
    const tail = link.split("/pv/")[1];
    expect(() => JSON.parse(Buffer.from(tail, "base64url").toString("utf8"))).toThrow();
  });

  // FAIL CLOSED ON THE ORIGIN, which is what this used to get wrong. It returned
  // "/pv/<token>" when PUBLIC_BASE_URL was unset or scheme-less, and the sweep
  // put that straight into an SMS: a text ending in a bare path that no phone
  // renders as a link, one credit spent per appointment, the target marked sent,
  // and zero completions with nothing on screen to explain it. The sibling links
  // (medical history, FP17, preferences) keep their root-relative fallback
  // because a person copies those off a screen; this one is transmitted.
  it("returns null rather than a root-relative path when no public origin is configured", () => {
    expect(buildTriageLink("A".repeat(22), undefined)).toBeNull();
    expect(buildTriageLink("A".repeat(22), "")).toBeNull();
  });

  it("returns null for an origin with no http(s) scheme, which is the misconfiguration that reaches production", () => {
    // The shape a deployment actually gets wrong: the host with the scheme left
    // off. Nothing else in the tree checks PUBLIC_BASE_URL's shape.
    expect(buildTriageLink("A".repeat(22), "azen-vitality.vercel.app")).toBeNull();
    expect(buildTriageLink("A".repeat(22), "ftp://azen-vitality.vercel.app")).toBeNull();
  });

  it("accepts http as well as https, because local dev and the mock serve http://localhost:3000", () => {
    expect(buildTriageLink("A".repeat(22), "http://localhost:3000")).toBe(`http://localhost:3000/pv/${"A".repeat(22)}`);
    // A trailing slash on the origin does not become a double slash in the link.
    expect(buildTriageLink("A".repeat(22), "https://x.co/")).toBe(`https://x.co/pv/${"A".repeat(22)}`);
  });

  it("returns null for a malformed token rather than a link to nowhere", () => {
    expect(buildTriageLink("nope", "https://x.co")).toBeNull();
  });
});
