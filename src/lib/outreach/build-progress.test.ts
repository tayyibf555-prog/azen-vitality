import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLoopStep,
  BUILD_FAILED_NOTE,
  BUILD_RATE_LIMITED_NOTE,
  BUILD_EXCLUSIONS_UNAVAILABLE_NOTE,
} from "./build-progress";

// ===========================================================================
// THE CAMPAIGN SCREEN'S BUILD LOOP STOPS WHEN THE BUILD REFUSES.
//
// THE DEFECT THIS PINS. The Campaigns workspace POSTs /api/outreach/build in a
// loop until the tick says it is finished, and it used to break on `done` and
// `stopped` only. A tick that REFUSED — because the list of patients who must
// never be contacted could not be read while messaging is LIVE (ruling W1-B/2,
// fail-direction law W1-B/1-5) — comes back:
//
//     { ok: true, done: false, stopped: null, skipped: "exclusions unavailable" }
//
// which is byte-for-byte the shape of a healthy mid-scan tick apart from that
// last field. So the screen span its full MAX_BUILD_TICKS re-asking a table it
// could not read, and left the owner watching "scanned 0 / matched 0" with no
// note at all — a blank screen that reads as a broken product rather than as a
// safety check declining to guess. Nobody was ever enrolled (the direction was
// always closed); what was missing was the sentence saying so.
//
// The rule lives in a pure leaf rather than inside the component's useCallback
// precisely so it can be driven here, outcome by outcome, instead of pinned by a
// grep over a React file (ruling W3/17).
// ===========================================================================

describe("what the build loop does after one tick", () => {
  it("keeps going, silently, on a healthy mid-scan tick", () => {
    const step = buildLoopStep(true, { ok: true, done: false, stopped: null });
    expect(step.stop).toBe(false);
    expect(step.note).toBeNull();
    expect(step.failed).toBe(false);
  });

  it("STOPS AND SAYS SO when the tick refused because the do-not-contact list was unreadable", () => {
    const step = buildLoopStep(true, {
      ok: true,
      done: false,
      stopped: null,
      skipped: "exclusions unavailable",
    });
    expect(step.stop, "a refused tick would be retried until the loop's own cap").toBe(true);
    expect(step.note).toBe(BUILD_EXCLUSIONS_UNAVAILABLE_NOTE);
    // NOT a failure: the counts on screen are still whatever the previous ticks
    // legitimately found, and the tick itself worked exactly as designed.
    expect(step.failed).toBe(false);
  });

  it("the refusal sentence says nobody was added and nothing was sent", () => {
    // The two facts an owner staring at a stalled campaign screen actually needs,
    // and the two that "the build paused" does not carry. Asserted as behaviour
    // of the sentence rather than as its exact wording, so it can be improved
    // without going red, and cannot lose either fact without going red.
    expect(BUILD_EXCLUSIONS_UNAVAILABLE_NOTE).toMatch(/nobody was added/i);
    expect(BUILD_EXCLUSIONS_UNAVAILABLE_NOTE).toMatch(/nothing has been sent/i);
    expect(BUILD_EXCLUSIONS_UNAVAILABLE_NOTE).toMatch(/try again/i);
    // Patient-facing vocabulary rules do not apply to a staff screen, but the
    // funding words are forbidden everywhere a patient could ever see them and
    // this sentence is one refactor away from a patient-facing surface.
    expect(BUILD_EXCLUSIONS_UNAVAILABLE_NOTE).not.toMatch(/\bNHS\b|\bprivate\b/i);
  });

  it("treats an ALREADY-BUILT tick as finished, not as refused", () => {
    // `skipped` has two producers and they mean opposite things. "already built"
    // arrives with done:true, and `done` is asked first for exactly this reason:
    // a finished campaign must not be reported to the owner as a refusal.
    const step = buildLoopStep(true, { ok: true, done: true, stopped: null, skipped: "already built" });
    expect(step.stop).toBe(true);
    expect(step.note).toBeNull();
    expect(step.failed).toBe(false);
  });

  it("backs off with the resumable sentence on a Dentally rate limit", () => {
    for (const stopped of ["403", "429"] as const) {
      const step = buildLoopStep(true, { ok: true, done: false, stopped });
      expect(step.stop).toBe(true);
      expect(step.note).toBe(BUILD_RATE_LIMITED_NOTE);
      expect(step.failed).toBe(false);
    }
  });

  it("reports a server failure with the server's own sentence when it sent one", () => {
    const step = buildLoopStep(false, { error: "campaign not found" });
    expect(step.stop).toBe(true);
    expect(step.note).toBe("campaign not found");
    expect(step.failed, "a failure must not repaint the counts to zero").toBe(true);
  });

  it("falls back to its own sentence when the failure body carried none", () => {
    const step = buildLoopStep(false, {});
    expect(step.note).toBe(BUILD_FAILED_NOTE);
    expect(step.failed).toBe(true);
  });

  it("a transport 200 carrying ok:false is still a failure", () => {
    // The route answers 500 with ok:false, but a proxy or a future caller could
    // hand back 200 with the same body. Both checks stand.
    const step = buildLoopStep(true, { ok: false, error: "the build failed" });
    expect(step.stop).toBe(true);
    expect(step.failed).toBe(true);
  });
});

describe("the screen uses this rule rather than a second copy of it", () => {
  it("the campaigns workspace calls buildLoopStep and holds no sentence of its own", () => {
    // A second copy of a refusal sentence is the copy that stops being updated,
    // which is the whole reason this moved out of the component. The crawl is
    // deliberately narrow: it asserts the CALL exists and that the three
    // sentences do not appear a second time in the file.
    const src = readFileSync(
      join(process.cwd(), "src/components/client/outreach/campaigns-workspace.tsx"),
      "utf8",
    );
    expect(src, "the build loop no longer asks buildLoopStep what to do").toContain("buildLoopStep(");
    for (const sentence of [
      BUILD_FAILED_NOTE,
      BUILD_RATE_LIMITED_NOTE,
      BUILD_EXCLUSIONS_UNAVAILABLE_NOTE,
    ]) {
      expect(src, `a second copy of "${sentence.slice(0, 40)}..." is back in the component`).not.toContain(
        sentence,
      );
    }
  });
});
