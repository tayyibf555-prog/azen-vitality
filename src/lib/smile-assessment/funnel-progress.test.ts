import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FUNNEL_QUIET_MINUTES,
  MIN_FUNNEL_STEPS,
  canAdvanceFunnelProgress,
  funnelCaptureStamp,
  funnelProgressLabel,
  isFunnelFinalStep,
  parseFunnelProgressPost,
  type LeadFunnelProgress,
} from "./funnel-progress";
import { stepNumbering } from "./step-numbering";
import { FLOW_TEMPLATES } from "./flow-templates";
import { validateFlow } from "./flow-validate";

// THE RULES BEHIND "Abandoned at question 3 of 5", pinned where they are decided.
//
// Everything in funnel-progress.ts is pure, so every property this feature rests
// on can be stated here rather than inferred from a route: what may be recorded at
// capture, what a public caller may move a lead to, and what the practice reads.
// The route tests (funnel-progress/public-gates.test.ts) prove the guard CHAIN;
// this file proves the rules the chain enforces.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "funnel-progress.ts"), "utf8");

const T0 = "2026-08-21T10:00:00.000Z";
/** One minute after T0: still inside the quiet period. */
const RECENT = "2026-08-21T10:01:00.000Z";
/** An hour after T0: comfortably past it. */
const STALE = "2026-08-21T11:00:00.000Z";

/** A lead that gave details at screen 5 of a 7-screen funnel and has not finished. */
function progress(over: Partial<LeadFunnelProgress> = {}): LeadFunnelProgress {
  return {
    lastStep: 5,
    totalSteps: 7,
    flowVersion: 3,
    lastStepAt: T0,
    completedAt: null,
    ...over,
  };
}

describe("the module stays pure and browser-safe", () => {
  it("imports nothing but the step-event rules (and one type)", () => {
    // This module is pulled into the LEADS worklist (a client component) and into
    // the public submit route. A single `serviceClient` import here would put a
    // service-role client in a browser bundle's import graph; a ./quiz import would
    // ship the scoring weights. Same pin flow-runtime.ts and step-numbering.ts keep.
    const imports = [...SOURCE.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./step-events", "./step-numbering"]);
    // ...and the step-numbering one carries no runtime code at all.
    expect(SOURCE).toContain('import type { StepNumbering } from "./step-numbering"');
  });
});

describe("funnelCaptureStamp: what may be recorded when contact details are given", () => {
  it.each(FLOW_TEMPLATES.map((t) => [t.key, t] as const))(
    "the %s template stamps the contact screen against its own length",
    (_key, template) => {
      const graph = template.build();
      // The templates are the funnels practices actually start from, so if the
      // invariant this feature rests on is false for one of them it is false in
      // production.
      expect(validateFlow(graph).ok).toBe(true);
      const numbering = stepNumbering(graph);
      const stamp = funnelCaptureStamp(numbering);
      expect(stamp).not.toBeNull();
      expect(stamp!.lastStep).toBe(numbering.contactStep);
      expect(stamp!.totalSteps).toBe(numbering.stepCount);
    },
  );

  it.each(FLOW_TEMPLATES.map((t) => [t.key, t] as const))(
    "the %s template lays out as [questions..., contact, result]",
    (_key, template) => {
      // THE INVARIANT THE DISPLAY RESTS ON. The lead stores two integers and no
      // screen KIND, so the wording ("question N of M" against "gave their
      // details") is derived from the position: the contact screen is the
      // second-to-last ordinal and the result is the last. That is a property of
      // stepNumbering — every question must precede the contact step, because every
      // path ends at a result and rule 6 makes the contact screen dominate every
      // result — and if it ever stops being true, this goes red before a worklist
      // starts calling the contact screen "question 6 of 5".
      const n = stepNumbering(template.build());
      expect(n.outcomeStep).toBe(n.stepCount - 1);
      expect(n.contactStep).toBe(n.stepCount - 2);
    },
  );

  it("refuses a funnel with no contact screen", () => {
    expect(
      funnelCaptureStamp({
        ordinals: new Map(),
        screens: [],
        stepCount: 4,
        contactStep: null,
        outcomeStep: 3,
      }),
    ).toBeNull();
  });

  it("refuses a funnel with no result screen", () => {
    expect(
      funnelCaptureStamp({
        ordinals: new Map(),
        screens: [],
        stepCount: 4,
        contactStep: 2,
        outcomeStep: null,
      }),
    ).toBeNull();
  });

  it("refuses a layout where the contact screen is not second-to-last", () => {
    // A hand-edited graph, or a future numbering change. Recording nothing is the
    // right answer: the stored integers would be read as a question number.
    expect(
      funnelCaptureStamp({
        ordinals: new Map(),
        screens: [],
        stepCount: 6,
        contactStep: 1,
        outcomeStep: 5,
      }),
    ).toBeNull();
  });

  it("refuses a funnel shorter than a question, a contact screen and a result", () => {
    expect(
      funnelCaptureStamp({
        ordinals: new Map(),
        screens: [],
        stepCount: MIN_FUNNEL_STEPS - 1,
        contactStep: 0,
        outcomeStep: 1,
      }),
    ).toBeNull();
  });
});

describe("parseFunnelProgressPost: what a public caller may say", () => {
  it("reads a well-formed post", () => {
    expect(parseFunnelProgressPost({ token: "abcd1234-ef", flowVersion: 3, step: 6 })).toEqual({
      token: "abcd1234-ef",
      flowVersion: 3,
      step: 6,
    });
  });

  it("constructs its result, so an invented key cannot survive the parse", () => {
    const parsed = parseFunnelProgressPost({
      token: "abcd1234-ef",
      flowVersion: 3,
      step: 6,
      stage: "booked",
      leadId: "00000000-0000-0000-0000-000000000000",
      phone: "+447700900000",
    });
    expect(Object.keys(parsed!).sort()).toEqual(["flowVersion", "step", "token"]);
  });

  it.each([
    ["no body", null],
    ["an array", [1, 2, 3]],
    ["no token", { flowVersion: 1, step: 2 }],
    ["a token that is too short", { token: "abc", flowVersion: 1, step: 2 }],
    ["a token with punctuation", { token: "someone@example.com", flowVersion: 1, step: 2 }],
    ["a token with a space", { token: "abcd 1234 ef", flowVersion: 1, step: 2 }],
    ["a fractional version", { token: "abcd1234-ef", flowVersion: 1.5, step: 2 }],
    ["a negative version", { token: "abcd1234-ef", flowVersion: -1, step: 2 }],
    ["no step", { token: "abcd1234-ef", flowVersion: 1 }],
    ["a negative step", { token: "abcd1234-ef", flowVersion: 1, step: -1 }],
    ["a fractional step", { token: "abcd1234-ef", flowVersion: 1, step: 2.5 }],
    ["a step past the ordinal ceiling", { token: "abcd1234-ef", flowVersion: 1, step: 64 }],
  ])("refuses %s", (_why, body) => {
    expect(parseFunnelProgressPost(body)).toBeNull();
  });
});

describe("canAdvanceFunnelProgress: forward, inside the funnel, same version", () => {
  it("allows a step forward inside the funnel on the same version", () => {
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 3, step: 6 })).toBe(true);
  });

  it("REFUSES A STEP THAT GOES BACKWARDS", () => {
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 3, step: 4 })).toBe(false);
  });

  it("refuses a step that repeats where the lead already is", () => {
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 3, step: 5 })).toBe(false);
  });

  it("REFUSES A STEP PAST THE LAST SCREEN", () => {
    // totalSteps 7 means the last ordinal is 6. "question 8 of 7" is not a fact.
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 3, step: 7 })).toBe(false);
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 3, step: 63 })).toBe(false);
  });

  it("REFUSES A POST ABOUT A DIFFERENT FLOW VERSION", () => {
    // The owner republished the funnel while this patient was answering. The
    // ordinal now means a different screen, so N and M would stop agreeing.
    expect(canAdvanceFunnelProgress({ current: progress(), flowVersion: 4, step: 6 })).toBe(false);
  });

  it("refuses a lead that carries no funnel position at all", () => {
    const none: LeadFunnelProgress = {
      lastStep: null,
      totalSteps: null,
      flowVersion: null,
      lastStepAt: null,
      completedAt: null,
    };
    expect(canAdvanceFunnelProgress({ current: none, flowVersion: 3, step: 1 })).toBe(false);
  });

  it("knows which step finishes a funnel", () => {
    expect(isFunnelFinalStep(7, 6)).toBe(true);
    expect(isFunnelFinalStep(7, 5)).toBe(false);
    expect(isFunnelFinalStep(2, 1)).toBe(false); // below MIN_FUNNEL_STEPS: not a funnel
  });
});

describe("funnelProgressLabel: the sentence the practice reads", () => {
  it("says nothing at all about a lead with no funnel behind it", () => {
    expect(
      funnelProgressLabel(
        { lastStep: null, totalSteps: null, flowVersion: null, lastStepAt: null, completedAt: null },
        STALE,
      ),
    ).toBeNull();
  });

  it("says 'Completed the assessment' once the result screen was reached", () => {
    const label = funnelProgressLabel(
      progress({ lastStep: 6, completedAt: "2026-08-21T10:00:30.000Z" }),
      STALE,
    );
    expect(label?.text).toBe("Completed the assessment");
    expect(label?.complete).toBe(true);
    expect(label?.abandoned).toBe(false);
    expect(label?.tone).toBe("success");
  });

  it("A COMPLETED FUNNEL IS NEVER CALLED ABANDONED, however long ago it was", () => {
    const label = funnelProgressLabel(
      progress({ lastStep: 6, lastStepAt: T0, completedAt: T0 }),
      "2027-01-01T00:00:00.000Z",
    );
    expect(label?.text).not.toMatch(/abandon/i);
    expect(label?.complete).toBe(true);
  });

  it("RECENT PROGRESS DOES NOT READ AS ABANDONED", () => {
    // The patient may still be answering. Calling them abandoned would put a live
    // session at the top of a chase list.
    const label = funnelProgressLabel(progress({ lastStep: 2 }), RECENT);
    expect(label?.text).toBe("Reached question 3 of 5");
    expect(label?.abandoned).toBe(false);
    expect(label?.tone).toBe("info");
    expect(label?.text).not.toMatch(/abandon/i);
    expect(label?.short).not.toMatch(/abandon|left/i);
  });

  it("says 'Abandoned at question N of M' once the funnel has gone quiet", () => {
    const label = funnelProgressLabel(progress({ lastStep: 2 }), STALE);
    expect(label?.text).toBe("Abandoned at question 3 of 5");
    expect(label?.abandoned).toBe(true);
    expect(label?.tone).toBe("warning");
  });

  it("flips exactly at the quiet period and not a minute before", () => {
    const at = new Date(new Date(T0).getTime() + FUNNEL_QUIET_MINUTES * 60_000).toISOString();
    const just = new Date(new Date(at).getTime() - 1000).toISOString();
    expect(funnelProgressLabel(progress({ lastStep: 2 }), just)?.abandoned).toBe(false);
    expect(funnelProgressLabel(progress({ lastStep: 2 }), at)?.abandoned).toBe(true);
  });

  it("does not call somebody abandoned when it has no idea how long it has been", () => {
    expect(funnelProgressLabel(progress({ lastStep: 2, lastStepAt: null }), STALE)?.abandoned).toBe(
      false,
    );
    expect(
      funnelProgressLabel(progress({ lastStep: 2, lastStepAt: "not a date" }), STALE)?.abandoned,
    ).toBe(false);
  });

  it("does not count the contact screen as a question", () => {
    // Screen 5 of a 7-screen funnel IS the contact screen (totalSteps - 2). There
    // are five questions, so "question 6 of 5" is the sentence this case exists to
    // never print.
    const label = funnelProgressLabel(progress({ lastStep: 5 }), STALE);
    expect(label?.text).toBe("Gave their details, never finished");
    expect(label?.text).not.toMatch(/question/i);
    const fresh = funnelProgressLabel(progress({ lastStep: 5 }), RECENT);
    expect(fresh?.text).toBe("Gave their details, not finished yet");
  });

  it("N OF M COMES FROM THE LEAD'S OWN STORED LENGTH, not from any current funnel", () => {
    // Two leads on two versions of the same campaign's funnel, both stopped on the
    // third question. The denominators differ because the funnels differed, and the
    // label reads each lead's own stored total — there is nowhere else it could
    // come from, which is the point of storing it on the row.
    const onV3 = funnelProgressLabel(progress({ lastStep: 2, totalSteps: 7, flowVersion: 3 }), STALE);
    const onV4 = funnelProgressLabel(progress({ lastStep: 2, totalSteps: 5, flowVersion: 4 }), STALE);
    expect(onV3?.text).toBe("Abandoned at question 3 of 5");
    expect(onV4?.text).toBe("Abandoned at question 3 of 3");
  });

  it("refuses to describe a position that is outside its own funnel", () => {
    expect(funnelProgressLabel(progress({ lastStep: 9, totalSteps: 7 }), STALE)).toBeNull();
    expect(funnelProgressLabel(progress({ lastStep: 0, totalSteps: 2 }), STALE)).toBeNull();
  });
});
