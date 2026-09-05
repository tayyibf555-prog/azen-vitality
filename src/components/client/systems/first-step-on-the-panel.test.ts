// ===========================================================================
// THE CONTROL PANEL PRINTS THE FIRST STEP — because for the Dentally master
// lever it is the only screen that can.
//
// THE DEFECT this pins. src/lib/systems/first-steps.ts exists so that "what to
// do first" is written ONCE and printed everywhere it is asked for. Four of its
// five sentences reach somebody: the equipment, IT desk and pre-visit
// workspaces print their own in an empty state, the approved-sources panel
// prints its own, and Home's Operating system band prints one under a
// switched-off tile. `dentally-write-back`'s sentence reached nobody at all:
//
//  - THE BAND CANNOT PRINT IT. Its write-back tile is the one tile with
//    `countsWhileOff` (src/lib/home/os-band.ts), so the read is always issued
//    and the tile always resolves to a figure, a fact or "not readable" — the
//    `off` branch that carries a first step is unreachable for exactly this
//    tile. That is deliberate and stays: held-back writes accrue BECAUSE the
//    system is off, so a tile that went quiet while off would hide the number
//    the owner came for. It is why some other screen has to carry the sentence.
//  - /api/systems ALREADY SENT IT. `firstStep: vocab?.firstStep ?? null` has
//    been on the response since the vocabulary landed; `SystemRow` had no such
//    field, so the panel cast it away on arrival and rendered nothing.
//  - AND THE SYNC TAB IS NOT THE PLACE. The sentence begins "Read the Dentally
//    sync tab first"; printed in that tab's own empty table it would tell a
//    reader to go where they already are, next to a sentence saying nothing has
//    been written yet. The row a practice reads before switching write-back on
//    is the row on this panel, one tab to the left, and that is where it goes.
//
// Rendered, not grepped: SystemsView fetches its rows in an effect, so a test
// that rendered the view would get the loading state and nothing else — which
// is how a line can be missing from every row with no assertion going red.
// SystemRowLine is exported for exactly that reason.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The band's read layer is `server-only`, which node cannot resolve; this suite
// only needs its tile definitions.
vi.mock("server-only", () => ({}));

import { OS_TILES } from "@/lib/home/os-band";
import { FIRST_STEPS } from "@/lib/systems/first-steps";
import { SYSTEM_VOCABULARY } from "@/lib/systems/vocabulary";
import { SystemRowLine, type SystemRow } from "./systems-view";

const WRITE_BACK = "dentally-write-back";

function row(over: Partial<SystemRow> = {}): SystemRow {
  return {
    slug: WRITE_BACK,
    label: "Dentally write-back",
    group: "Dentally",
    halts: "Nothing this platform does reaches your Dentally book.",
    starts: "Appointments created, moved and cancelled here start reaching your Dentally book.",
    needsFirst: ["DENTALLY_WRITE_ENABLED, a real write key and an explicit write base URL"],
    firstStep: FIRST_STEPS[WRITE_BACK].step,
    enabled: false,
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

const line = (over: Partial<SystemRow> = {}): string =>
  renderToStaticMarkup(createElement(SystemRowLine, { row: row(over), busy: false, onToggle: () => {} }));

/**
 * A distinctive fragment of the SHARED sentence. Apostrophe-free on purpose:
 * React escapes `'` to `&#x27;` in static markup, so a fragment carrying one
 * fails for a reason that has nothing to do with the copy being present.
 */
const FRAGMENT = "Read the Dentally sync tab first";

describe("the switched-off write-back row carries its first step", () => {
  it("prints the shared sentence, not a second copy of it", () => {
    // The fragment is a piece of the sentence in first-steps.ts, asserted to be
    // so before it is looked for on the screen: a lookalike typed into the
    // component would pass the second assertion and fail the first.
    expect(FIRST_STEPS[WRITE_BACK].step).toContain(FRAGMENT);
    expect(line()).toContain(FRAGMENT);
  });

  it("is the sentence /api/systems actually sends, so the screen cannot drift", () => {
    // The route projects `vocabularyFor(slug).firstStep`, which is
    // `firstStepFor(slug)?.step`. This closes the chain the panel depends on:
    // one sentence, in one file, serialised to this row.
    expect(SYSTEM_VOCABULARY[WRITE_BACK].firstStep).toBe(FIRST_STEPS[WRITE_BACK].step);
  });

  it("says nothing of the kind once the system is running", () => {
    // A first step has been taken by the time the switch is on; the row's job
    // then is "Running." and what switching it off would stop.
    expect(line({ enabled: true })).not.toContain(FRAGMENT);
  });

  it("prints nothing at all for a system with no sentence written", () => {
    // Most systems have none. A row for one of those must not grow an empty
    // paragraph, and must still carry the two lines it always had.
    const html = line({ slug: "recall", label: "Recall", firstStep: null });
    expect(html).not.toContain(FRAGMENT);
    expect(html).toContain("Needs first:");
    expect(html).toContain("Appointments created");
  });

  it("keeps the prerequisites underneath it, in the order they are acted on", () => {
    const html = line();
    expect(html.indexOf(FRAGMENT)).toBeGreaterThan(-1);
    expect(html.indexOf("Needs first:")).toBeGreaterThan(html.indexOf(FRAGMENT));
  });
});

describe("the panel is where this sentence has to live", () => {
  it("the band still counts while off, so it still cannot print a first step", () => {
    // If this ever flips, the band's `off` branch becomes reachable for the
    // write-back tile and there are two screens printing one sentence — which
    // is fine, but it should be a decision somebody took rather than a drift.
    const tile = OS_TILES.find((t) => t.systemSlug === WRITE_BACK);
    expect(tile, "the band no longer has a write-back tile").toBeTruthy();
    expect(tile?.countsWhileOff).toBe(true);
  });
});
