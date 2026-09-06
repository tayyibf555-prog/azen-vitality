// ===========================================================================
// THE OPERATING SYSTEM BAND, AS MARKUP: every branch of `TileState` is proved
// against the HTML a practice owner actually reads.
//
// WHY THIS FILE EXISTS (wave-3d review, 6 September 2026; charter §0 item 11,
// ruling W3/17). The band's STATE layer is thoroughly pinned in
// src/lib/home/os-band.test.ts — mutate `qualifyUnscheduled`, the write-back
// capped branch or `figure()`'s `atLeast` and that suite goes red. The RENDER
// layer was not, and three mutations of src/components/client/dashboard/
// os-band.tsx survived the FULL suite with zero failures:
//
//   M85  `state.kind === "off" ? "Off" : "Nothing yet"` → always "Nothing yet".
//        A switched-off system tells the owner it is watching and has found
//        nothing.
//   M87  the same ternary → always "Off". A RUNNING system with nothing to show
//        is reported as switched off.
//   M88  delete the amber `Off` badge from every switched-off tile.
//
// All three passed the one render-level assertion that names the rule —
// `expect(html).toContain("Off")` in "an off tile prints Off and the first step,
// and no zero" — because the tile prints the word "Off" in TWO places (the amber
// badge and the state line), so a bare substring cannot say which one produced
// it, and neither can it fail when one of them is removed. Nothing anywhere
// asserted that an `empty` tile prints "Nothing yet" rather than "Off", so the
// ternary was unpinned in both directions. A fourth mutation, `{state.text}` →
// `{""}`, erased EVERY `fact` sentence from the DOM — including
// `qualifyUnscheduled`'s "On, but nothing runs it yet" (ruling W3/31, the one
// sentence that stops an owner concluding a switched-on pre-visit module is
// working) and the write-back tile's capped floor (W3/11) — with the suite
// still green.
//
// WHAT IT ASSERTS, AND WHY IT BUILDS ITS OWN BAND. `OperatingSystemBandView` is
// pure and synchronous: `OsBand` in, markup out. So the fixtures here are the
// state objects themselves rather than a mocked stack of repositories — the
// question this file answers is "given this state, what does the owner read",
// and os-band.test.ts already answers "given this database, what state". The
// `CASES` map below is keyed by `OsTileState["kind"]`, so a sixth state added to
// the union is a COMPILE error here until it has a rendering pinned.
//
// IT LIVES BESIDE THE COMPONENT rather than in src/lib/home, because it is a
// test of this file and of nothing else.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OsBand, OsTile, OsTileState } from "@/lib/home/os-band";

vi.mock("server-only", () => ({}));

const { OperatingSystemBandView } = await import("./os-band");

function render(band: OsBand): string {
  return renderToStaticMarkup(
    createElement(OperatingSystemBandView, { band, basePath: "/c/vitality" }),
  );
}

/**
 * One tile, with everything but the thing under test held still. `enabled` is
 * `true` by default so the amber badge — the OTHER producer of the word "Off" —
 * is absent unless a test asks for it.
 */
function tile(state: OsTileState, over: Partial<OsTile> = {}): OsTile {
  return {
    key: "pre-visit",
    label: "Pre-visit questions",
    path: "/pre-visit-triage",
    enabled: true,
    state,
    ...over,
  };
}

const band = (...tiles: OsTile[]): OsBand => ({ tiles, switchesUnreadable: false });

/** Narrowed so the capped/uncapped pair below can vary `atLeast` on its own. */
const FIGURE: Extract<OsTileState, { kind: "figure" }> = {
  kind: "figure",
  value: 200,
  noun: "awaiting first contact",
  atLeast: true,
  tone: "attention",
};

/**
 * EVERY BRANCH OF THE UNION, EXHAUSTIVELY. `Record<OsTileState["kind"], …>` is
 * the compile-time half: a new state kind cannot be added to
 * src/lib/home/os-band.ts without this map — and therefore a rendering assertion
 * below — being written for it.
 */
const CASES: Record<OsTileState["kind"], OsTileState> = {
  off: { kind: "off", firstStep: "Review the two question lists, then switch it on." },
  empty: { kind: "empty", firstStep: "Add your first machine to the register." },
  unreadable: { kind: "unreadable" },
  // The real sentence `qualifyUnscheduled` produces for the four slugs the
  // scheduler has never heard of (ruling W3/31). Pinned as a state object in
  // src/lib/home/os-band.test.ts; pinned as MARKUP here.
  fact: { kind: "fact", text: "On, but nothing runs it yet", tone: "attention" },
  figure: FIGURE,
};

describe("a switched-off tile and an empty one print DIFFERENT sentences", () => {
  // MUTATION (M85): `state.kind === "off" ? "Off" : "Nothing yet"` → always
  // "Nothing yet". The negative is the half that catches it: the word "Off"
  // survives on the badge, so only the ABSENCE of the empty-state sentence can
  // tell the two apart in one blob of markup.
  it("an off tile says Off and never the sentence reserved for a running one", () => {
    const html = render(band(tile(CASES.off, { enabled: false })));
    expect(html).toContain("Off");
    expect(
      html,
      "a switched-off system is telling the owner it is watching and has found nothing",
    ).not.toContain("Nothing yet");
    // The first step is the action under an off tile, and it is the whole reason
    // the off state is allowed to carry text at all.
    expect(html).toContain("Review the two question lists, then switch it on.");
    // The literal figure a lying band would print, checked as a standalone
    // number so a "0 of 6 running" fact cannot mask it.
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  // MUTATION (M87): the same ternary → always "Off". An ON system with an empty
  // register is reported as switched off, on the front door.
  it("an ON tile with nothing to show says Nothing yet, and never Off", () => {
    const html = render(band(tile(CASES.empty)));
    expect(html).toContain("Nothing yet");
    expect(
      html,
      "a running system with an empty register is being reported as switched off",
    ).not.toContain("Off");
    expect(html).toContain("Add your first machine to the register.");
  });

  // MUTATION (M88): `{tile.enabled === false ? (` → `{false ? (`. The amber
  // badge disappears from every switched-off tile and the state word alone
  // carries the fact.
  //
  // COUNTED RATHER THAN CLASS-MATCHED, so the assertion survives a restyle and
  // still names the rule: the word appears once per off STATE plus once per
  // switched-off tile's badge, and both counts are derived from the band handed
  // in rather than typed in here. A band with an off tile AND an on tile that is
  // switched off (the write-back tile, which counts while off) makes the two
  // producers distinguishable — under M88 the total drops to one.
  it("a switched-off tile wears the amber Off badge as well as the state word", () => {
    const b = band(
      tile(CASES.off, { key: "pre-visit", enabled: false }),
      // Switched off, but it still has a figure to print: the write-back tile is
      // the one tile that counts while off (src/lib/home/os-band.ts), so its badge
      // is the ONLY place its "Off" can come from.
      tile(CASES.fact, { key: "write-back", label: "Dentally sync", path: "/controls/sync", enabled: false }),
      // Not switched at all (the automations tile): `enabled` is null and it must
      // wear no badge, or every band would claim a system nobody can switch is off.
      tile(CASES.fact, { key: "automations", label: "Automations", path: "/controls", enabled: null }),
    );
    const offStates = b.tiles.filter((t) => t.state.kind === "off").length;
    const offBadges = b.tiles.filter((t) => t.enabled === false).length;
    expect(offStates, "no off state in the fixture; this proves nothing").toBe(1);
    expect(offBadges, "no switched-off tile in the fixture; this proves nothing").toBe(2);
    const html = render(b);
    expect(
      html.split("Off").length - 1,
      "the switched-off tiles lost their amber badge, or gained one they should not have",
    ).toBe(offStates + offBadges);
  });
});

describe("every other state reaches the screen intact", () => {
  // MUTATION: `{state.text}` → `{""}`. Every fact sentence the band produces is
  // erased: W3/31's "On, but nothing runs it yet", the write-back tile's
  // "None held back in the most recent N writes" (W3/11), "No IT contact set",
  // and the equipment tile's "at least N registered, none overdue so far".
  it("a fact tile prints its sentence, which is the only place it is ever read", () => {
    const html = render(band(tile(CASES.fact)));
    expect(
      html,
      "the fact sentence never reaches the DOM — the tile shows a label and nothing else",
    ).toContain("On, but nothing runs it yet");
  });

  // MUTATION: drop the `state.atLeast ? \`at least ${state.value}\` :` arm. A
  // read that stopped counting at its bound wears the total's clothes.
  it("a capped figure is rendered as a floor, with its noun", () => {
    const html = render(band(tile(CASES.figure)));
    expect(html).toContain("at least 200");
    expect(html).toContain("awaiting first contact");
    // And an uncapped one is plain, so the qualifier keeps its meaning.
    const plain = render(band(tile({ ...FIGURE, atLeast: false, value: 3 })));
    expect(plain).not.toContain("at least");
    expect(plain).toContain(">3<");
  });

  it("an unreadable tile says so instead of drawing a figure or an empty state", () => {
    const html = render(band(tile(CASES.unreadable)));
    expect(html).toContain("Not readable just now");
    expect(html).not.toContain("Nothing yet");
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it("an empty band draws nothing at all, heading included", () => {
    expect(render({ tiles: [], switchesUnreadable: false })).toBe("");
  });

  it("says out loud when the switches themselves could not be read", () => {
    const html = renderToStaticMarkup(
      createElement(OperatingSystemBandView, {
        band: { tiles: [tile(CASES.unreadable)], switchesUnreadable: true },
        basePath: "/c/vitality",
      }),
    );
    expect(html).toContain("could not be read");
  });
});
