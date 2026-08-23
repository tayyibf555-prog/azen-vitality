// THE GO-LIVE WORD IS EXACT. isDryRun() may only return false - live patient
// messaging - for the precise string "false". A typo in a Vercel env screen,
// an emptied var mid-edit, or the variable's absence must all mean DRY RUN.
// The old rule (dry only when exactly "true") had the fail direction backwards:
// any slip started texting real patients.
import { afterEach, describe, expect, it } from "vitest";

import { isDryRun } from "@/lib/messaging/types";

const ORIGINAL = process.env.MESSAGING_DRY_RUN;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MESSAGING_DRY_RUN;
  else process.env.MESSAGING_DRY_RUN = ORIGINAL;
});

describe("the messaging dry-run fail-safe", () => {
  it('goes live ONLY for the exact string "false"', () => {
    process.env.MESSAGING_DRY_RUN = "false";
    expect(isDryRun()).toBe(false);
  });

  it.each([
    ["true", "the explicit dry-run word"],
    ["True", "a case slip"],
    ["false ", "a stray trailing space"],
    ["fales", "a typo"],
    ["", "an emptied var mid-edit"],
  ])("stays dry for %j (%s)", (value) => {
    process.env.MESSAGING_DRY_RUN = value;
    expect(isDryRun()).toBe(true);
  });

  it("stays dry when the variable is ABSENT entirely", () => {
    delete process.env.MESSAGING_DRY_RUN;
    expect(isDryRun()).toBe(true);
  });
});
