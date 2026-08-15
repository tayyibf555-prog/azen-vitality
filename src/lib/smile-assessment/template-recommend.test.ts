// The gallery's rules: the recommended row, the category rail, and search.
//
// The DRIFT GUARDS are the point of this file. The rail is derived from
// GOAL_CATALOG and the recommended row is keyed by goal, so this suite is what
// goes red when a goal or a template moves - rather than a rail that quietly
// disagrees with the goal field beside it, or a recommended row that quietly
// empties.
//
// Every assertion names the mutation it catches.

import { describe, it, expect } from "vitest";
import { GOAL_CATALOG, goalLabel } from "./campaign";
import { FLOW_TEMPLATES, type FlowTemplate } from "./flow-templates";
import {
  ALL_TEMPLATES_CATEGORY,
  ALL_TEMPLATES_LABEL,
  RECOMMENDED_COUNT,
  RECOMMENDED_GOALS,
  filterTemplates,
  gridHeading,
  matchesTemplateSearch,
  recommendedTemplates,
  searchTerms,
  showRecommendedRow,
  templateCategories,
} from "./template-recommend";

/* ---------------------------------------------------------------------------
 * Recommended.
 * ------------------------------------------------------------------------- */

describe("the recommended row is curated, in order, and cannot go empty", () => {
  // MUTATION: reorder RECOMMENDED_GOALS, or sort the picks by anything, and the
  // curated order - straightening, hygiene, general - stops being what shows.
  it("shows the curated goals in the curated order", () => {
    expect(recommendedTemplates(FLOW_TEMPLATES).map((t) => t.goal)).toEqual([...RECOMMENDED_GOALS]);
  });

  // THE PRODUCT JUDGEMENT ITSELF, pinned as a literal. The assertion above proves
  // the wiring (function output matches the constant) but moves with the constant,
  // so a silent reorder of the curated row would pass every test. This one does
  // not move: straightening then hygiene then general is the documented order
  // (strongest dental performers first), and changing it is a decision that must
  // fail a test and be made on purpose.
  it("keeps the curated order itself: invisalign, hygiene, general", () => {
    expect([...RECOMMENDED_GOALS]).toEqual(["invisalign", "hygiene", "general"]);
  });

  // THE DRIFT GUARD. If a curated goal loses its template the function silently
  // backfills, so this is what says so out loud instead.
  it("resolves every curated goal against the live template registry", () => {
    for (const goal of RECOMMENDED_GOALS) {
      expect(
        FLOW_TEMPLATES.some((t) => t.goal === goal),
        `no template for the recommended goal "${goal}"`,
      ).toBe(true);
    }
    expect(recommendedTemplates(FLOW_TEMPLATES).length).toBe(RECOMMENDED_COUNT);
  });

  // MUTATION: drop the backfill loop and a registry missing a curated goal
  // returns a short row - a gallery with a gap where a card should be.
  it("fills the row from what is left when a curated goal has no template", () => {
    const missing = FLOW_TEMPLATES.filter((t) => t.goal !== "hygiene");
    const row = recommendedTemplates(missing);
    expect(row.length).toBe(RECOMMENDED_COUNT);
    expect(row.map((t) => t.goal)).not.toContain("hygiene");
    // The curated goals that DO exist still lead.
    expect(row[0]!.goal).toBe("invisalign");
    expect(row.map((t) => t.key)).toEqual([...new Set(row.map((t) => t.key))]);
  });

  // MUTATION: drop the `taken` set and a template can be listed twice, which
  // renders two cards with the same React key.
  it("never repeats a template, even when goals collide", () => {
    const twins: FlowTemplate[] = FLOW_TEMPLATES.filter((t) => t.goal === "invisalign");
    const row = recommendedTemplates(twins);
    expect(row.map((t) => t.key)).toEqual([...new Set(row.map((t) => t.key))]);
    expect(row.length).toBe(twins.length);
  });

  // MUTATION: drop the slice and a registry of twenty templates gives a
  // "recommended" row of twenty, which is not a recommendation.
  it("is capped at RECOMMENDED_COUNT however many templates exist", () => {
    expect(recommendedTemplates(FLOW_TEMPLATES).length).toBeLessThanOrEqual(RECOMMENDED_COUNT);
    expect(recommendedTemplates([]).length).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * The rail.
 * ------------------------------------------------------------------------- */

describe("the category rail is derived from GOAL_CATALOG, never typed out", () => {
  // MUTATION: hand-write the rail's groups and this fails the moment an eighth
  // goal is added to GOAL_CATALOG - which is exactly when the create form's goal
  // dropdown would grow one and the rail would not.
  it("has one group per goal that has a template, in catalogue order", () => {
    const rail = templateCategories(FLOW_TEMPLATES);
    expect(rail[0]).toEqual({
      key: ALL_TEMPLATES_CATEGORY,
      label: ALL_TEMPLATES_LABEL,
      count: FLOW_TEMPLATES.length,
    });

    const goalsWithTemplates = GOAL_CATALOG.filter((g) =>
      FLOW_TEMPLATES.some((t) => t.goal === g.key),
    );
    expect(rail.slice(1).map((c) => c.key)).toEqual(goalsWithTemplates.map((g) => g.key));
    expect(rail.slice(1).map((c) => c.label)).toEqual(goalsWithTemplates.map((g) => g.label));
  });

  // MUTATION: count with a constant, or count the wrong list, and a rail badge
  // promises a number of cards the grid does not then show.
  it("counts what its own filter would actually return", () => {
    for (const c of templateCategories(FLOW_TEMPLATES)) {
      expect(filterTemplates(FLOW_TEMPLATES, { category: c.key }).length, c.key).toBe(c.count);
    }
  });

  // MUTATION: keep zero-count goals and the rail grows dead ends that can only
  // ever say "nothing here".
  it("leaves out a goal that has no template at all", () => {
    const withoutHygiene = FLOW_TEMPLATES.filter((t) => t.goal !== "hygiene");
    const keys = templateCategories(withoutHygiene).map((c) => c.key);
    expect(keys).not.toContain("hygiene");
    expect(keys[0]).toBe(ALL_TEMPLATES_CATEGORY);
  });
});

/* ---------------------------------------------------------------------------
 * Search.
 * ------------------------------------------------------------------------- */

describe("search matches the words an owner would actually type", () => {
  // MUTATION: search the label alone and "implants" (the dropdown's wording, not
  // the template's name) stops finding the implant funnel.
  it("matches on the goal's human label, not just the template name", () => {
    for (const goal of GOAL_CATALOG) {
      const template = FLOW_TEMPLATES.find((t) => t.goal === goal.key);
      if (!template) continue;
      // The first word of the goal label, which is what someone types.
      const term = goalLabel(goal.key).split(/[\s/]+/)[0]!;
      const hits = filterTemplates(FLOW_TEMPLATES, { search: term });
      expect(
        hits.some((t) => t.key === template.key),
        `"${term}" should find the ${goal.key} template`,
      ).toBe(true);
    }
  });

  it("matches on the blurb, so a description finds its funnel", () => {
    const bonding = FLOW_TEMPLATES.find((t) => t.key === "bonding")!;
    expect(matchesTemplateSearch(bonding, "chips")).toBe(true);
  });

  // MUTATION: switch the terms from every() to some() and two words widen the
  // shelf instead of narrowing it.
  it("narrows on a second word rather than widening", () => {
    const one = filterTemplates(FLOW_TEMPLATES, { search: "enquiry" });
    const two = filterTemplates(FLOW_TEMPLATES, { search: "enquiry implant" });
    expect(one.length).toBeGreaterThan(two.length);
    expect(two.every((t) => one.some((o) => o.key === t.key))).toBe(true);
  });

  // MUTATION: drop the lower-casing and a capitalised search finds nothing.
  it("ignores case and surrounding whitespace", () => {
    const plain = filterTemplates(FLOW_TEMPLATES, { search: "implant" }).map((t) => t.key);
    expect(filterTemplates(FLOW_TEMPLATES, { search: "  IMPLANT " }).map((t) => t.key)).toEqual(
      plain,
    );
    expect(plain.length).toBeGreaterThan(0);
  });

  // MUTATION: treat an empty query as "match nothing" and an untouched search box
  // empties the gallery.
  it("treats an empty or whitespace query as no filter at all", () => {
    for (const query of ["", "   ", "\t\n"]) {
      expect(searchTerms(query)).toEqual([]);
      expect(filterTemplates(FLOW_TEMPLATES, { search: query }).length).toBe(FLOW_TEMPLATES.length);
    }
    expect(filterTemplates(FLOW_TEMPLATES, {}).length).toBe(FLOW_TEMPLATES.length);
  });

  it("returns nothing for a term no template carries, rather than everything", () => {
    expect(filterTemplates(FLOW_TEMPLATES, { search: "orthognathic" })).toEqual([]);
  });

  // MUTATION: apply the category OR the search instead of both and a filtered
  // rail stops narrowing the search results.
  it("applies the category and the search together", () => {
    const both = filterTemplates(FLOW_TEMPLATES, { category: "implants", search: "whitening" });
    expect(both).toEqual([]);
    const matching = filterTemplates(FLOW_TEMPLATES, { category: "implants", search: "implant" });
    expect(matching.map((t) => t.goal)).toEqual(["implants"]);
  });
});

/* ---------------------------------------------------------------------------
 * What the filter implies for the layout.
 * ------------------------------------------------------------------------- */

describe("the recommended row only shows on the unfiltered shelf", () => {
  // MUTATION: always show the row and a narrowed gallery renders three cards that
  // ignore the filter - and repeats a card that also matched it.
  it("hides once a search or a category is in play", () => {
    expect(showRecommendedRow({})).toBe(true);
    expect(showRecommendedRow({ category: ALL_TEMPLATES_CATEGORY, search: "" })).toBe(true);
    expect(showRecommendedRow({ search: "implant" })).toBe(false);
    expect(showRecommendedRow({ category: "hygiene" })).toBe(false);
    expect(showRecommendedRow({ category: "hygiene", search: "implant" })).toBe(false);
  });

  // MUTATION: use `search.length` rather than the shared term parser and a box
  // holding only spaces counts as a filter, hiding the row for no visible reason.
  it("agrees with searchTerms about what counts as an empty box", () => {
    expect(showRecommendedRow({ search: "   " })).toBe(true);
  });
});

describe("the grid says what it is showing", () => {
  // MUTATION: always render "All templates" and a filtered grid lies about its
  // contents.
  it("heads the grid with the chosen category's own name", () => {
    expect(gridHeading({}, FLOW_TEMPLATES)).toBe(ALL_TEMPLATES_LABEL);
    expect(gridHeading({ category: ALL_TEMPLATES_CATEGORY }, FLOW_TEMPLATES)).toBe(
      ALL_TEMPLATES_LABEL,
    );
    for (const goal of GOAL_CATALOG) {
      if (!FLOW_TEMPLATES.some((t) => t.goal === goal.key)) continue;
      expect(gridHeading({ category: goal.key }, FLOW_TEMPLATES)).toBe(goal.label);
    }
  });

  it("falls back rather than heading the grid with a raw key", () => {
    expect(gridHeading({ category: "not-a-goal" }, FLOW_TEMPLATES)).toBe(ALL_TEMPLATES_LABEL);
  });
});
