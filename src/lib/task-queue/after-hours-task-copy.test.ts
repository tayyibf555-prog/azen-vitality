import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { afterHoursTaskCopy } from "@/lib/after-hours/call-outcome";

/**
 * The after-hours builder must LABEL a callback by when the call actually landed.
 *
 * These assertions read the generator's source rather than running it: generate.ts
 * opens with `import "server-only"`, which throws outside a React Server Component,
 * so the module cannot be imported here at all. The same reason the sibling
 * patient-attribution test reads source.
 *
 * The rule itself (which words go with which timing) is executed properly in
 * src/lib/after-hours/call-outcome.test.ts. What is pinned HERE is the wiring: that
 * the builder asks for that copy instead of hardcoding one timing's words for both,
 * which is the defect this replaced. A 2pm overflow call labelled "out of hours"
 * tells the person picking up the callback the wrong thing about their own day.
 */
const SRC = readFileSync(fileURLToPath(new URL("./generate.ts", import.meta.url)), "utf8");

const BUILDER = /function afterHoursCandidates[\s\S]*?\n}/.exec(SRC)?.[0] ?? "";

/** The builder's CODE, with its explanatory comments stripped: a comment that
 *  discusses the wording is not the builder emitting it. */
const BUILDER_CODE = BUILDER.replace(/^\s*\/\/.*$/gm, "");

describe("after-hours task copy is derived, not hardcoded", () => {
  it("finds the builder", () => {
    expect(BUILDER).toContain("after_hours_callback");
  });

  it("derives the timing from the capture's own capturedAt and its site", () => {
    expect(BUILDER).toMatch(/captureTiming\(\s*c\.capturedAt\s*,\s*getSiteById\(c\.siteId\)\s*\)/);
  });

  it("takes both the subtitle and the due hint from afterHoursTaskCopy", () => {
    expect(BUILDER).toContain("afterHoursTaskCopy(");
    expect(BUILDER).toMatch(/subtitle:[^\n]*copy\.subtitle/);
    expect(BUILDER).toMatch(/dueHint:\s*copy\.dueHint/);
  });

  it("hardcodes NEITHER timing's wording, so an overflow call cannot be mislabelled", () => {
    expect(BUILDER_CODE).not.toContain(afterHoursTaskCopy("after_hours").dueHint);
    expect(BUILDER_CODE).not.toContain(afterHoursTaskCopy("after_hours").subtitle);
    expect(BUILDER_CODE).not.toContain(afterHoursTaskCopy("overflow").dueHint);
    expect(BUILDER_CODE).not.toContain(afterHoursTaskCopy("overflow").subtitle);
  });
});
