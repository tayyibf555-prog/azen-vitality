import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PATIENT_TABS } from "./tabs";

/**
 * THE GUARD BETWEEN A TAB'S DECLARED STATE AND WHAT THE ROUTER ACTUALLY RENDERS.
 *
 * This exists because of a real, silent regression. When the Chart tab gained a
 * genuine read its entry in tabs.ts moved to availability "partial" and its
 * cannotRead sentence was blanked, but record-tab-content.tsx still routed "chart"
 * to UnavailablePanel, which renders `<h3>{label}</h3><p>{cannotRead}</p>`. The
 * result was a bordered card containing the single word "Chart" and nothing else,
 * on a charting tab, with a fully green suite. An empty panel on a clinical tab is
 * the exact failure this whole feature exists to prevent: silence reads as "nothing
 * here", and on a clinical tab that is a claim about a patient.
 *
 * THE SHARED UnavailablePanel IS NOW RETIRED FROM THE ROUTER. Chart left it for a
 * real read; perio and medical left it because they AUTHOR their own screens —
 * their Dentally sources expose nothing to mirror (perio has no endpoint at all;
 * medical's /v1/medical_histories exists but is permanently empty for this
 * practice), so each renders a gated screen that says "we can hold this, we are not
 * holding it, check Dentally" rather than the flat "we cannot read this" panel.
 * Medical was the last user, so no tab routes to the shared panel any more.
 *
 * The invariant is unchanged and still pinned in BOTH directions: no tab may lose
 * its honesty to an empty card, and every unreadable tab must render a real screen
 * of its own. A node test reading source is the only way available - vitest
 * collects no .tsx.
 *
 * Scoped through import.meta.url so it never walks .claude/worktrees, which are full
 * repo copies and would find duplicate files.
 */
const ROUTER = fileURLToPath(
  new URL("../../components/client/patients/record/record-tab-content.tsx", import.meta.url),
);

const source = readFileSync(ROUTER, "utf8");

/** The one `slug === "..."` comparison list inside any UnavailablePanel branch.
 *  Now empty by design - no tab routes to the shared panel - but the extractor stays
 *  so a future tab that DOES route there is still held to the sentence rule below. */
function slugsSentToUnavailablePanel(): string[] {
  const branch = /if\s*\(([^)]*)\)\s*\{\s*return <UnavailablePanel slug=\{slug\} \/>;/.exec(source);
  if (!branch) return [];
  return [...branch[1].matchAll(/slug === "([a-z-]+)"/g)].map((m) => m[1]);
}

/**
 * Each tab that renders its OWN screen instead of the shared UnavailablePanel, and
 * the component that proves it. A tab named here must be shown to render a real
 * component of its own — an unreadable tab whose component was deleted would
 * otherwise render nothing at all, which is the empty-card failure by a longer route.
 */
const OWN_SCREEN: Record<string, string> = {
  medical: "<TabMedical",
  perio: "<TabPerio",
  chart: "<TabChart",
};

describe("what the record router renders for each tab", () => {
  const routed = slugsSentToUnavailablePanel();

  it("proves it actually read the router: the three own-screen components are present", () => {
    // Replaces the old "finds the UnavailablePanel branch" non-vacuity guard. That
    // branch is legitimately gone now, so its absence is no longer evidence of a
    // regex bug - but the router must still contain the components below, which is
    // what proves this file parsed a real router rather than an empty string.
    for (const marker of Object.values(OWN_SCREEN)) {
      expect(source, `the router does not render ${marker}`).toContain(marker);
    }
  });

  it("no tab is routed to the shared UnavailablePanel any more", () => {
    // Medical was the last user; it and perio now author their own screens, and chart
    // renders from a real read. If a future tab is added to the panel it must carry a
    // sentence - see the next test, which still holds it to that.
    expect(routed).toEqual([]);
  });

  it("sends every tab that still has a cannot-read sentence to a real screen, never nothing", () => {
    for (const tab of PATIENT_TABS) {
      if (tab.availability !== "unreadable") continue;
      // Its sentence must still exist (its own gate screen carries it), and it must
      // render a named component of its own - never nothing.
      expect(tab.cannotRead.length, `${tab.slug} is unreadable but has no sentence`).toBeGreaterThan(0);
      const own = OWN_SCREEN[tab.slug];
      if (own) {
        expect(source, `${tab.slug} renders its own screen but ${own} is not in the router`).toContain(
          own,
        );
        expect(
          routed,
          `${tab.slug} renders its own screen AND the panel, so its sentence is on the page twice`,
        ).not.toContain(tab.slug);
        continue;
      }
      // Any unreadable tab NOT authoring its own screen must fall back to the panel
      // (with a sentence) - the original invariant, kept for a future tab.
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
    // availability stays "unreadable" because that word is about DENTALLY: their API
    // exposes no periodontal resource at all. What changed is that this platform can
    // AUTHOR periodontal findings of its own, so the tab has a screen to render.
    expect(routed).not.toContain("perio");
    expect(source).toContain("<TabPerio");
    const perio = PATIENT_TABS.find((t) => t.slug === "perio");
    expect(perio?.availability).toBe("unreadable");
    expect(perio?.cannotRead).toContain("Dentally");
  });

  it("renders the Medical tab from its own component, now a partial with a blanked sentence", () => {
    // Medical's Dentally endpoint EXISTS but is permanently empty for this practice,
    // and patient.medical_alert IS readable, so the tab is "partial" and authors its
    // own questionnaire + review screen. It must NOT go to the shared panel (which
    // would render a card containing only the word "Medical").
    expect(routed).not.toContain("medical");
    expect(source).toContain("<TabMedical");
    const medical = PATIENT_TABS.find((t) => t.slug === "medical");
    expect(medical?.availability).toBe("partial");
    expect(medical?.cannotRead).toBe("");
  });
});
