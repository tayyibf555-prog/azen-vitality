// ===========================================================================
// THE KILL-SWITCH PARAGRAPH IS JOINED TO THE CODE IT DESCRIBES (ruling W3/9,
// "copy matches code, never the reverse"; charter §0 item 12).
//
// THE DEFECT this pins. System controls opened with "Turning one off is a full
// kill switch: it hides the module and stops all of its work, so nothing sends
// and nothing is written to Dentally until you switch it back on." Two clauses
// were false about four of the panel's own rows:
//
//   1. "it hides the module". `NAV_SWITCH_EXEMPT_SLUGS` grew from one slug to
//      four (outreach, equipment, it-desk, pre-visit-triage) and
//      `categoriesForRole` keeps every one of them in the sidebar with its
//      switch OFF — deliberately, so the owner can prepare a module before
//      arming it (W1-D, W2-C/4). The owner who flips Pre-visit questions off,
//      still finds it in his sidebar and can still open its question banks has
//      every reason to think the switch did not take.
//   2. "stops all of its work". /api/outreach/sweep runs its build-continuation
//      pass ungated ahead of the send gate, and the post-op check-in row's own
//      `halts` sentence says replies are still triaged by a person.
//
// Widening the exempt set was a one-line change with nothing attached to it:
// os-copy-sweep crawls nav notes and catalog sentences, nav.os-coherence pins
// the set itself, control-panel.test.ts renders the rows. Nothing read the
// paragraph. This file is that join: the sentence is DERIVED from
// NAV_SWITCH_EXEMPT_SLUGS, and exempting a fifth slug without the sentence
// following reddens the first test below.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_NAV, NAV_SWITCH_EXEMPT_SLUGS } from "@/lib/nav";
import { killSwitchSummary } from "./systems-view";

const LABEL_BY_SLUG = new Map(CLIENT_NAV.flatMap((g) => g.items).map((i) => [i.slug, i.label]));

describe("the System controls kill-switch paragraph", () => {
  it("names every module the sidebar keeps while its switch is off", () => {
    const copy = killSwitchSummary();
    // Non-vacuity: the join is worth nothing if the exempt set is empty.
    expect(NAV_SWITCH_EXEMPT_SLUGS.size).toBeGreaterThan(0);
    for (const slug of NAV_SWITCH_EXEMPT_SLUGS) {
      const label = LABEL_BY_SLUG.get(slug);
      expect(label, `${slug} is switch-exempt but has no sidebar label`).toBeTruthy();
      expect(copy, `${label} stays in the sidebar while off and the panel does not say so`).toContain(
        label as string,
      );
    }
    expect(copy).toContain("stay reachable so you can review and prepare them before switching on");
  });

  it("is what the panel actually prints, not prose beside it", () => {
    // THE MUTATION THIS CATCHES. The derivation above is only worth something
    // if the screen renders it: a hardcoded paragraph in the JSX would keep
    // every assertion here green while the owner read the old over-claim. Read
    // from source, because the paragraph lives in a React tree this
    // node-environment suite (src/**/*.test.ts, no .tsx) cannot render.
    const view = readFileSync(
      fileURLToPath(new URL("./systems-view.tsx", import.meta.url)),
      "utf8",
    );
    expect(view, "the panel no longer prints killSwitchSummary()").toMatch(
      /\{killSwitchSummary\(\)\}/,
    );
    // And the sentence is derived from the exempt set rather than restated: the
    // labels are looked up, never typed in beside it.
    expect(view).toContain("NAV_SWITCH_EXEMPT_SLUGS");
    expect(view, "the still-reachable modules are hardcoded in this file").not.toMatch(
      /"Pre-visit questions"|'Pre-visit questions'/,
    );
  });

  it("does not claim the switch hides the module or stops all of its work", () => {
    const copy = killSwitchSummary();
    // The two clauses the exempt set and the ungated outreach build pass falsify.
    expect(copy).not.toMatch(/hides the module/i);
    expect(copy).not.toMatch(/stops all of its work/i);
    expect(copy).not.toMatch(/\bfull kill switch\b/i);
  });

  it("still states the two things that ARE true of every system", () => {
    const copy = killSwitchSummary();
    // The halt itself, and the Dentally half the owner asks about first.
    expect(copy).toContain("halts that system's work");
    expect(copy).toMatch(/sends, agent replies and public forms stop/);
    expect(copy).toContain("it writes nothing to Dentally");
    // And it says the exceptions exist, and WHEN the per-row sentence names
    // them — because a row that is OFF prints `starts`, not `halts`, so this
    // paragraph is the only description of the off state on screen and it may
    // not point at a line that is not there.
    expect(copy).toContain("deliberately outside the switch");
    expect(copy).toMatch(/spells its exceptions out while it is running/);
  });

  // =========================================================================
  // THE CLAUSE THE FIRST CORRECTION LEFT BEHIND (wave-3d review, 6 Sep 2026).
  //
  // The replacement paragraph opened "Turning one off halts that system's work:
  // its SWEEPS, sends, agent replies and public forms stop" — which is the same
  // over-claim it had just deleted, about the same row, and the test above had
  // pinned it as one of "the two things that ARE true of every system".
  //
  // THE DERIVATION IS THE ORDER OF TWO CALLS, exactly as src/lib/systems/
  // catalog.test.ts derives the outreach ROW's sentence. /api/outreach/sweep
  // takes the cron lease and runs `continueBuilds()` — which reads Dentally to
  // advance any campaign left in `building` — BEFORE it reads the outreach send
  // switch. So the sweep keeps running on every ten-minute tick with the switch
  // off, and the panel-wide paragraph may not say sweeps stop. The day the build
  // pass moves BELOW the switch, the guard below goes red and the paragraph
  // becomes free (and required) to change with it, rather than standing as stale
  // prose. Ruling W3/9, charter §0 item 5.
  // =========================================================================
  it("does not claim every system's sweep stops, because the outreach build pass does not", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/outreach/sweep/route.ts"),
      "utf8",
    );
    const buildPass = route.indexOf("const build = await continueBuilds()");
    const sendGate = route.indexOf('isSystemEnabledForSend(CLIENT_ID, "outreach")');
    expect(buildPass, "the outreach sweep no longer runs a build-continuation pass").toBeGreaterThan(
      -1,
    );
    expect(sendGate, "the outreach sweep no longer reads its own send switch").toBeGreaterThan(-1);
    expect(
      buildPass,
      "the build pass now runs UNDER the switch — the paragraph may say sweeps stop",
    ).toBeLessThan(sendGate);

    const copy = killSwitchSummary();
    expect(
      copy,
      "the panel says every system's sweeps stop; the outreach sweep runs on every tick with the switch off",
    ).not.toMatch(/\bsweeps?\b/i);
    // The correction is not a deletion: the paragraph still tells the owner
    // that something carries on, in the one state he is reading about.
    expect(copy).toMatch(/\bbackground\b/i);
  });
});
