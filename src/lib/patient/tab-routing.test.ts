import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PATIENT_TABS } from "./tabs";

/**
 * THE GUARD BETWEEN A TAB'S DECLARED STATE AND WHAT THE ROUTER ACTUALLY RENDERS.
 *
 * This exists because of a real, silent regression. When the Chart tab gained a
 * genuine read its entry in tabs.ts moved to availability "partial" and its
 * cannotRead sentence was blanked, and tabs.test.ts was updated to assert exactly
 * that. But record-tab-content.tsx still routed "chart" to UnavailablePanel, which
 * renders `<h3>{label}</h3><p>{cannotRead}</p>`. The result was a bordered card
 * containing the single word "Chart" and nothing else, on a charting tab, with a
 * fully green suite - and it was a regression from a state that was at least honest,
 * because the old sentence told the reader to check Dentally.
 *
 * An empty panel on a clinical tab is the exact failure this whole feature exists to
 * prevent: silence reads as "nothing here", and on a chart that is a claim about a
 * patient. So the declaration and the renderer are pinned to each other in BOTH
 * directions, by a node test reading source, which is the only way available -
 * vitest collects no .tsx.
 *
 * Scoped through import.meta.url so it never walks .claude/worktrees, which are full
 * repo copies and would find duplicate files.
 */
const ROUTER = fileURLToPath(
  new URL("../../components/client/patients/record/record-tab-content.tsx", import.meta.url),
);

const source = readFileSync(ROUTER, "utf8");

/** The one `slug === "..."` comparison list inside the UnavailablePanel branch. */
function slugsSentToUnavailablePanel(): string[] {
  const branch = /if\s*\(([^)]*)\)\s*\{\s*return <UnavailablePanel slug=\{slug\} \/>;/.exec(source);
  if (!branch) return [];
  return [...branch[1].matchAll(/slug === "([a-z-]+)"/g)].map((m) => m[1]);
}

describe("what the record router renders for each tab", () => {
  const routed = slugsSentToUnavailablePanel();

  it("finds the UnavailablePanel branch at all, so the rest of this file is not vacuous", () => {
    expect(routed.length).toBeGreaterThan(0);
  });

  /**
   * An unreadable tab that renders its OWN screen instead of the shared panel.
   *
   * PERIO IS THE FIRST, and it did not become readable — "unreadable" in tabs.ts is
   * a statement about DENTALLY, and Dentally still exposes no periodontal resource
   * of any kind. What changed is that this platform can now AUTHOR periodontal
   * findings itself, which is a second clinical record and ships gated off. That
   * screen has to say something UnavailablePanel cannot: "we can hold this, we are
   * not holding it, and the record you want is in Dentally", plus the FP17
   * double-entry consequence the moment the gate opens.
   *
   * BEING ON THIS LIST IS NOT AN EXEMPTION. The invariant this file exists for is
   * that no tab loses its honesty to an empty card, so a tab named here must be
   * proved to render a real component of its own — see the assertion below.
   */
  const OWN_SCREEN: Record<string, string> = { perio: "<TabPerio" };

  it("sends every tab that still has a cannot-read sentence to UnavailablePanel", () => {
    // The panel is the ONLY thing that renders a tab's cannotRead. A tab that keeps
    // its sentence and loses its renderer loses the sentence entirely.
    for (const tab of PATIENT_TABS) {
      if (tab.availability !== "unreadable") continue;
      expect(tab.cannotRead.length, `${tab.slug} is unreadable but has no sentence`).toBeGreaterThan(0);
      const own = OWN_SCREEN[tab.slug];
      if (own) {
        // Not routed to the panel, so it must be routed SOMEWHERE. A tab on this
        // list whose component was deleted would otherwise render nothing at all,
        // which is the empty-card failure again by a longer route.
        expect(source, `${tab.slug} renders its own screen but ${own} is not in the router`).toContain(
          own,
        );
        expect(
          routed,
          `${tab.slug} renders its own screen AND the panel, so its sentence is on the page twice`,
        ).not.toContain(tab.slug);
        continue;
      }
      expect(routed, `${tab.slug} is unreadable and must render UnavailablePanel`).toContain(tab.slug);
    }
  });

  it("sends no tab with a blanked sentence to UnavailablePanel, which would render an empty card", () => {
    for (const slug of routed) {
      const tab = PATIENT_TABS.find((t) => t.slug === slug);
      expect(tab, `${slug} is routed to UnavailablePanel but is not a tab`).toBeDefined();
      expect(
        (tab as (typeof PATIENT_TABS)[number]).cannotRead.length,
        `${slug} renders UnavailablePanel with an empty sentence, which is a card containing only its own label`,
      ).toBeGreaterThan(0);
    }
  });

  it("renders the Chart tab from its own component, and not from the unavailable panel", () => {
    expect(routed).not.toContain("chart");
    expect(source).toContain("<TabChart");
  });

  it("renders the Perio tab from its own component, while its tab entry still says Dentally holds nothing we can read", () => {
    // THE TWO FACTS ARE NOT IN TENSION, and this is the assertion that says so.
    //
    // availability stays "unreadable" because that word is about DENTALLY: their
    // API exposes no periodontal resource at all, verified, and no amount of code
    // here changes it. What changed is that this platform can AUTHOR periodontal
    // findings of its own — the one module that mirrors nothing — so the tab has a
    // screen to render even though there is nothing to read from Dentally.
    //
    // It must NOT also go to UnavailablePanel: that panel would print the same
    // "check Dentally" sentence a second time above a screen that already says it,
    // and a clinical warning printed twice is a warning being trained past.
    expect(routed).not.toContain("perio");
    expect(source).toContain("<TabPerio");
    const perio = PATIENT_TABS.find((t) => t.slug === "perio");
    expect(perio?.availability).toBe("unreadable");
    expect(perio?.cannotRead).toContain("Dentally");
  });
});
