import { describe, it, expect } from "vitest";
import {
  afterHoursTaskCopy,
  captureTiming,
  decideCallOutcome,
  type CallAction,
} from "./call-outcome";
import type { OpeningHours, Site } from "@/lib/types";

// ---------------------------------------------------------------------------
// The inbound-call decision, as a truth table.
//
// This is the rule the Twilio Voice webhook obeys, and until now it existed only
// as nested branches inside an HTTP handler that also owned signature checks,
// Dentally lookups and two racing timeouts. Every row below was previously
// reachable only by driving that whole route.
//
// The expected column is written out by hand rather than computed, so a test
// cannot agree with a broken implementation by sharing its logic.
// ---------------------------------------------------------------------------

const PRACTICE = "Test Dental";

function decide(over: {
  outside: boolean;
  dialable: boolean;
  alreadyCaptured: boolean;
  systemOn: boolean;
  suppressed: boolean;
}) {
  return decideCallOutcome({ ...over, practiceName: PRACTICE });
}

// [outside, dialable, alreadyCaptured, systemOn, suppressed] -> [capture, action]
type Row = [boolean, boolean, boolean, boolean, boolean, boolean, CallAction];

const TABLE: Row[] = [
  // --- outside hours -------------------------------------------------------
  // Withheld caller ID: always captured (flagged), never texted, and the dedup
  // flag cannot rescind the capture.
  [true, false, false, false, false, true, "none"],
  [true, false, false, false, true, true, "none"],
  [true, false, false, true, false, true, "none"],
  [true, false, false, true, true, true, "none"],
  [true, false, true, false, false, true, "none"],
  [true, false, true, false, true, true, "none"],
  [true, false, true, true, false, true, "none"],
  [true, false, true, true, true, true, "none"],
  // Dialable, first call in the window.
  [true, true, false, false, false, true, "none"], // kill switch off
  [true, true, false, false, true, true, "none"],
  [true, true, false, true, false, true, "lead-bridge"], // the only outside send
  [true, true, false, true, true, true, "none"], // opted out
  // Dialable, repeat call inside the dedup window: no second row, no second text.
  [true, true, true, false, false, false, "none"],
  [true, true, true, false, true, false, "none"],
  [true, true, true, true, false, false, "none"],
  [true, true, true, true, true, false, "none"],

  // --- in hours (daytime overflow) -----------------------------------------
  [false, false, false, false, false, true, "none"],
  [false, false, false, false, true, true, "none"],
  [false, false, false, true, false, true, "none"],
  [false, false, false, true, true, true, "none"],
  [false, false, true, false, false, true, "none"],
  [false, false, true, false, true, true, "none"],
  [false, false, true, true, false, true, "none"],
  [false, false, true, true, true, true, "none"],
  [false, true, false, false, false, true, "none"],
  [false, true, false, false, true, true, "none"],
  [false, true, false, true, false, true, "callback-sms"], // the only in-hours send
  [false, true, false, true, true, true, "none"],
  [false, true, true, false, false, false, "none"],
  [false, true, true, false, true, false, "none"],
  [false, true, true, true, false, false, "none"],
  [false, true, true, true, true, false, "none"],
];

describe("decideCallOutcome — the full truth table", () => {
  it("covers all 32 combinations exactly once", () => {
    expect(TABLE).toHaveLength(32);
    const keys = new Set(TABLE.map((r) => r.slice(0, 5).join("")));
    expect(keys.size).toBe(32);
  });

  it.each(TABLE)(
    "outside=%s dialable=%s captured=%s systemOn=%s suppressed=%s -> capture=%s action=%s",
    (outside, dialable, alreadyCaptured, systemOn, suppressed, capture, action) => {
      const out = decide({ outside, dialable, alreadyCaptured, systemOn, suppressed });
      expect(out.capture).toBe(capture);
      expect(out.action).toBe(action);
    },
  );

  it("labels the timing from the hours alone, on every row", () => {
    for (const [outside, dialable, alreadyCaptured, systemOn, suppressed] of TABLE) {
      const out = decide({ outside, dialable, alreadyCaptured, systemOn, suppressed });
      expect(out.taskKindHint).toBe(outside ? "after_hours" : "overflow");
    }
  });
});

describe("decideCallOutcome — an opt-out is honoured, and promises nothing", () => {
  it("suppressed outside hours: no action, and the spoken line promises no text", () => {
    const out = decide({
      outside: true,
      dialable: true,
      alreadyCaptured: false,
      systemOn: true,
      suppressed: true,
    });
    expect(out.action).toBe("none");
    expect(out.capture).toBe(true); // an opt-out refuses texts, not a callback
    expect(out.spoken).not.toMatch(/sent you a text|texted you/i);
    expect(out.spoken).toContain("call back during our opening hours");
  });

  it("suppressed in hours: no action, no promise of a text or a callback text", () => {
    const out = decide({
      outside: false,
      dialable: true,
      alreadyCaptured: false,
      systemOn: true,
      suppressed: true,
    });
    expect(out.action).toBe("none");
    expect(out.capture).toBe(true);
    expect(out.spoken).not.toMatch(/sent you a text|texted you/i);
  });
});

describe("decideCallOutcome — the owner kill switch", () => {
  it("systemOn=false still captures, and sends nothing, outside hours", () => {
    const out = decide({
      outside: true,
      dialable: true,
      alreadyCaptured: false,
      systemOn: false,
      suppressed: false,
    });
    expect(out.capture).toBe(true);
    expect(out.action).toBe("none");
    expect(out.spoken).not.toMatch(/sent you a text|texted you/i);
  });

  it("systemOn=false still captures, and sends nothing, in hours", () => {
    const out = decide({
      outside: false,
      dialable: true,
      alreadyCaptured: false,
      systemOn: false,
      suppressed: false,
    });
    expect(out.capture).toBe(true);
    expect(out.action).toBe("none");
  });
});

describe("decideCallOutcome — precedence between the gates", () => {
  it("a withheld number is captured even when the dedup flag is set", () => {
    // Different withheld callers all share the same literal, so deduping on it
    // would collapse them into one and lose a call.
    const out = decide({
      outside: true,
      dialable: false,
      alreadyCaptured: true,
      systemOn: true,
      suppressed: false,
    });
    expect(out.capture).toBe(true);
  });

  it("a withheld number is captured even with the system off and the number suppressed", () => {
    const out = decide({
      outside: false,
      dialable: false,
      alreadyCaptured: false,
      systemOn: false,
      suppressed: true,
    });
    expect(out.capture).toBe(true);
    expect(out.action).toBe("none");
  });

  it("the dedup flag outranks the kill switch and the opt-out: no second row", () => {
    const out = decide({
      outside: true,
      dialable: true,
      alreadyCaptured: true,
      systemOn: false,
      suppressed: true,
    });
    expect(out.capture).toBe(false);
  });
});

describe("decideCallOutcome — the spoken line", () => {
  it("names the practice on every row", () => {
    for (const [outside, dialable, alreadyCaptured, systemOn, suppressed] of TABLE) {
      const out = decide({ outside, dialable, alreadyCaptured, systemOn, suppressed });
      expect(out.spoken).toContain(PRACTICE);
    }
  });

  it("only the outside-hours repeat caller is told a text already went", () => {
    const closedRepeat = decide({
      outside: true,
      dialable: true,
      alreadyCaptured: true,
      systemOn: true,
      suppressed: false,
    });
    expect(closedRepeat.spoken).toContain("already texted you");

    // In hours the earlier capture may have been suppressed or switched off, so
    // the repeat caller is promised nothing.
    const openRepeat = decide({
      outside: false,
      dialable: true,
      alreadyCaptured: true,
      systemOn: true,
      suppressed: false,
    });
    expect(openRepeat.spoken).not.toMatch(/sent you a text|texted you/i);
  });

  it("never promises a text on a decision that sends one, so the route must earn it", () => {
    // The bridge/SMS can still be suppressed downstream, time out, or throw. The
    // decision's line is the honest floor; the route swaps in the "sent" line
    // only after a send actually succeeded.
    const bridge = decide({
      outside: true,
      dialable: true,
      alreadyCaptured: false,
      systemOn: true,
      suppressed: false,
    });
    expect(bridge.action).toBe("lead-bridge");
    expect(bridge.spoken).not.toMatch(/sent you a text|texted you/i);

    const sms = decide({
      outside: false,
      dialable: true,
      alreadyCaptured: false,
      systemOn: true,
      suppressed: false,
    });
    expect(sms.action).toBe("callback-sms");
    expect(sms.spoken).not.toMatch(/sent you a text|texted you/i);
  });

  it("never tells a caller to hold, because the call is hung up immediately after", () => {
    for (const [outside, dialable, alreadyCaptured, systemOn, suppressed] of TABLE) {
      const out = decide({ outside, dialable, alreadyCaptured, systemOn, suppressed });
      expect(out.spoken.toLowerCase()).not.toContain("hold");
    }
  });
});

// ---------------------------------------------------------------------------
// The read-time timing discriminator.
// ---------------------------------------------------------------------------

const HOURS: OpeningHours = {
  monday: "09:00-17:30",
  tuesday: "09:00-17:30",
  wednesday: "09:00-17:30",
  thursday: "09:00-17:30",
  friday: "09:00-17:30",
  saturday: "09:00-13:00",
  sunday: null,
};

const SITE: Site = {
  id: "site-cc",
  clientId: "vitality",
  name: "Test Dental",
  timezone: "Europe/London",
  openingHours: HOURS,
};

// 2026-06-25 is a Thursday; June is BST, so local = UTC + 1h.
describe("captureTiming — derived, never stored", () => {
  it("labels a 2pm weekday capture as daytime overflow", () => {
    // Thu 14:00 BST = 13:00 UTC, inside the 09:00-17:30 window.
    expect(captureTiming("2026-06-25T13:00:00Z", SITE)).toBe("overflow");
  });

  it("labels a 10pm weekday capture as after hours", () => {
    // Thu 23:00 BST = 22:00 UTC.
    expect(captureTiming("2026-06-25T22:00:00Z", SITE)).toBe("after_hours");
  });

  it("labels a Sunday capture as after hours even at midday", () => {
    // 2026-06-28 is a Sunday, which is closed.
    expect(captureTiming("2026-06-28T11:00:00Z", SITE)).toBe("after_hours");
  });

  it("falls back to after hours for an unparseable timestamp", () => {
    expect(captureTiming("not-a-date", SITE)).toBe("after_hours");
  });

  it("falls back to after hours when the site cannot be resolved", () => {
    expect(captureTiming("2026-06-25T13:00:00Z", undefined)).toBe("after_hours");
  });
});

describe("afterHoursTaskCopy — the staff-facing label follows the timing", () => {
  it("an overflow task does not claim the call came out of hours", () => {
    const copy = afterHoursTaskCopy("overflow");
    expect(copy.dueHint).toBe("missed in hours");
    expect(copy.subtitle).toContain("Overflow callback");
    expect(copy.subtitle.toLowerCase()).not.toContain("out of hours");
    expect(copy.dueHint.toLowerCase()).not.toContain("out of hours");
  });

  it("an after-hours task keeps the wording the worklist already used", () => {
    const copy = afterHoursTaskCopy("after_hours");
    expect(copy.dueHint).toBe("out of hours");
    expect(copy.subtitle).toBe("Tried to reach the practice out of hours");
  });

  it("the two timings never share a due hint or a subtitle", () => {
    const a = afterHoursTaskCopy("overflow");
    const b = afterHoursTaskCopy("after_hours");
    expect(a.dueHint).not.toBe(b.dueHint);
    expect(a.subtitle).not.toBe(b.subtitle);
  });
});
