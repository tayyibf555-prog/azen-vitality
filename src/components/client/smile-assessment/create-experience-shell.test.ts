// The rebuilt CREATE EXPERIENCE, held at the seam a pure test cannot reach: what
// the templates screen actually renders, and what the panel actually sends.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts,
// so this is renderToStaticMarkup for the markup plus the component source read
// as text for everything a static render cannot show - the same split the
// guided-assessment-shell suite uses (guided-assessment-quiz's own note at :11-16).
// TemplateGallery's state is all initial-render state, so a static render is the
// real first paint: the search box empty, the rail on "All templates", the
// recommended row up.
//
// WHAT THIS IS FOR. The rules themselves live in template-recommend.ts,
// flow-thumbnail.ts and wizard-state.ts, each tested beside itself. What is left
// over - and what a redesign breaks silently - is the WIRING: a component that
// stops calling the rule and hand-rolls it, a card that loses its picture, a
// staged form that quietly changes the create contract underneath the staging.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TemplateGallery } from "./template-gallery";
import { GOAL_CATALOG } from "@/lib/smile-assessment/campaign";
import { FLOW_TEMPLATES } from "@/lib/smile-assessment/flow-templates";
import { THUMBNAIL_ASPECT, flowThumbnail } from "@/lib/smile-assessment/flow-thumbnail";
import {
  RECOMMENDED_COUNT,
  recommendedTemplates,
  templateCategories,
} from "@/lib/smile-assessment/template-recommend";

const GALLERY_PATH = "src/components/client/smile-assessment/template-gallery.tsx";
const PANEL_PATH = "src/components/client/smile-assessment/campaigns-panel.tsx";
const BUILDER_PATH = "src/components/client/smile-assessment/flow-builder.tsx";
const PHONE_CANVAS_PATH = "src/components/client/smile-assessment/flow-phone-canvas.tsx";

const gallerySource = readFileSync(resolve(process.cwd(), GALLERY_PATH), "utf8");
const panelSource = readFileSync(resolve(process.cwd(), PANEL_PATH), "utf8");
/** Stage 3's editor. Read here only to prove stage 2's change did not reach it. */
const builderSource = readFileSync(resolve(process.cwd(), BUILDER_PATH), "utf8");
const phoneCanvasSource = readFileSync(resolve(process.cwd(), PHONE_CANVAS_PATH), "utf8");

/** The source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function renderGallery(): string {
  return renderToStaticMarkup(
    createElement(TemplateGallery, {
      clientSlug: "vitality",
      onChoose: () => {},
      onClose: () => {},
    }),
  );
}

const html = renderGallery();

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ---------------------------------------------------------------------------
 * 1. The screen: a Templates takeover, not a strip above a form.
 * ------------------------------------------------------------------------- */

describe("stage 1 renders the Manychat-shaped templates screen", () => {
  it("leads with a Templates heading and a labelled search box", () => {
    expect(html).toContain("Templates</h3>");
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search templates"');
    // Empty on arrival, so the first paint is the whole shelf.
    expect(html).toContain('value=""');
  });

  it("offers Start From Scratch from the header, not buried in the grid", () => {
    expect(html).toContain("Start from scratch");
    const header = html.slice(0, html.indexOf("Template categories"));
    expect(header, "the scratch action belongs above the shelf").toContain("Start from scratch");
  });

  it("has a way out", () => {
    expect(html).toContain('aria-label="Close templates"');
  });

  // MUTATION: hand-type the rail's groups and this fails the moment GOAL_CATALOG
  // grows an eighth goal - which is the moment the goal field beside it grows one.
  it("rails every category the pure rule derived, and nothing else", () => {
    const rail = templateCategories(FLOW_TEMPLATES);
    expect(html).toContain('aria-label="Template categories"');
    for (const c of rail) {
      expect(html, `rail should list ${c.key}`).toContain(`>${c.label}</span>`);
    }
    // The first is selected on arrival; the others are not.
    expect(occurrences(html, 'aria-pressed="true"')).toBe(1);
    expect(occurrences(html, 'aria-pressed="false"')).toBe(rail.length - 1);
  });

  // MUTATION: drop the goal-label lookup and the rail starts showing raw keys.
  it("uses the catalogue's own wording for every goal it rails", () => {
    for (const goal of GOAL_CATALOG) {
      if (!FLOW_TEMPLATES.some((t) => t.goal === goal.key)) continue;
      expect(html, goal.key).toContain(goal.label);
      // ...and the wording is not typed into the component.
      expect(codeOnly(gallerySource), goal.key).not.toContain(goal.label);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The recommended row, above the full grid.
 * ------------------------------------------------------------------------- */

describe("the recommended row sits above the shelf and comes from the rule", () => {
  it("renders a Recommended shelf before the All templates shelf", () => {
    expect(html).toContain(">Recommended</h4>");
    expect(html).toContain(">All templates</h4>");
    expect(html.indexOf(">Recommended</h4>")).toBeLessThan(html.indexOf(">All templates</h4>"));
  });

  // MUTATION: hardcode the recommended keys in the component and reordering
  // RECOMMENDED_GOALS stops reordering the row.
  it("shows exactly the curated templates, in the curated order", () => {
    const recommended = recommendedTemplates(FLOW_TEMPLATES);
    expect(recommended.length).toBe(RECOMMENDED_COUNT);

    const row = html.slice(html.indexOf(">Recommended</h4>"), html.indexOf(">All templates</h4>"));
    let cursor = -1;
    for (const t of recommended) {
      const at = row.indexOf(t.label);
      expect(at, `${t.key} missing from the recommended row`).toBeGreaterThan(-1);
      expect(at, `${t.key} out of curated order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(gallerySource).toContain("recommendedTemplates(FLOW_TEMPLATES)");
  });

  it("renders every template in the full grid, whatever is recommended", () => {
    const grid = html.slice(html.indexOf(">All templates</h4>"));
    for (const t of FLOW_TEMPLATES) {
      expect(grid, `${t.key} missing from the grid`).toContain(t.label);
      expect(grid, `${t.key} blurb missing`).toContain(t.blurb);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. Every card carries its funnel's real shape, and both actions.
 * ------------------------------------------------------------------------- */

describe("every card shows the funnel it would actually give you", () => {
  const cardCount = FLOW_TEMPLATES.length + RECOMMENDED_COUNT;

  // MUTATION: draw a static placeholder, or drop the thumbnail entirely, and the
  // viewBox the pure projection computed stops appearing on the card.
  it("draws each template's own thumbnail, at the projected viewBox", () => {
    for (const t of FLOW_TEMPLATES) {
      const { viewBox } = flowThumbnail(t.build());
      expect(html, `${t.key} thumbnail`).toContain(`viewBox="${viewBox}"`);
    }
    // One picture per card, no more and no fewer.
    expect(occurrences(html, "aspect-ratio")).toBe(cardCount);
  });

  // MUTATION: shape the box with a literal and changing THUMBNAIL_ASPECT stops
  // changing the card, so the drawing letterboxes inside its own frame.
  it("shapes the picture box from the same constant the viewBox was fitted to", () => {
    expect(html).toContain(`aspect-ratio:${THUMBNAIL_ASPECT}`);
    expect(gallerySource).toContain("aspectRatio: String(THUMBNAIL_ASPECT)");
  });

  // MUTATION: let any text into the miniature and a 30-unit-wide card renders an
  // unreadable smear of overlapping words.
  it("puts no text in the picture at all", () => {
    expect(html).not.toContain("<text");
    expect(html).not.toContain("<tspan");
  });

  // MUTATION: hardcode a hex, or reach for a Tailwind fill utility built around a
  // variable outside @theme inline (which renders transparent - tooth.tsx:270).
  it("colours the picture only through the canvas's own tokens", () => {
    expect(html).toContain("var(--card)");
    expect(html).toContain("var(--blue-royal)");
    expect(html).toContain("var(--status-amber)");
    expect(gallerySource).toContain('import { NODE_ACCENT } from "./flow-canvas"');
    expect(gallerySource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("gives every card both actions", () => {
    expect(occurrences(html, "Use this")).toBe(cardCount);
    expect(occurrences(html, "Let AI write one")).toBe(cardCount);
  });

  // MUTATION: point the generate call at a different route or drop the validation
  // gate, and an unvalidated graph reaches a canvas.
  it("wires the AI action to the existing route and re-validates the reply", () => {
    expect(gallerySource).toContain('fetch("/api/smile-assessment/flow-generate"');
    expect(gallerySource).toContain("normaliseAndValidateFlow(data.flow)");
    // Honest failure: every branch that cannot produce a validated graph falls
    // back to the goal's starter AND says so.
    expect(gallerySource).toContain("const fallback = (text: string)");
    expect(gallerySource).toContain("templateForGoal(goal)");
    for (const status of ["404", "429", "503"]) {
      expect(gallerySource, `no handling for ${status}`).toContain(status);
    }
  });

  // MUTATION: drop `note` from the choice and a degraded write becomes invisible,
  // because the screen that raised it is gone by the time it would be read.
  it("sends the degradation line onward with the choice, not just to this screen", () => {
    const generate = gallerySource.slice(
      gallerySource.indexOf("async function generate"),
      gallerySource.indexOf("function useTemplate"),
    );
    // Every onChoose in the AI path carries a note.
    const calls = generate.split("onChoose({").slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.slice(0, call.indexOf("});")), "an AI choice with no note").toContain("note");
    }
  });
});

/* ---------------------------------------------------------------------------
 * 4. It computes nothing: the rules stayed in the pure modules.
 * ------------------------------------------------------------------------- */

describe("the gallery renders rules rather than re-implementing them", () => {
  it("calls the pure rule for each thing it decides", () => {
    for (const call of [
      "templateCategories(FLOW_TEMPLATES)",
      "filterTemplates(FLOW_TEMPLATES, filter)",
      "recommendedTemplates(FLOW_TEMPLATES)",
      "showRecommendedRow(filter)",
      "gridHeading(filter, FLOW_TEMPLATES)",
      "flowThumbnail(graph)",
    ]) {
      expect(gallerySource, `missing ${call}`).toContain(call);
    }
  });

  // MUTATION: filter inline with .filter(t => t.label.includes(query)) and the
  // goal-label and blurb matching quietly disappear.
  it("does not hand-roll the search or the category filter", () => {
    const code = codeOnly(gallerySource);
    expect(code).not.toMatch(/\.toLowerCase\(\)\s*\.includes\(/);
    expect(code).not.toMatch(/FLOW_TEMPLATES\.filter\(/);
  });
});

/* ---------------------------------------------------------------------------
 * 5. Mobile: the rail stacks, the cards go single-column, nothing scrolls
 *    sideways but the thing that has to.
 * ------------------------------------------------------------------------- */

describe("the takeover fits a phone", () => {
  // MUTATION: put overflow-x on an ancestor instead and the whole page scrolls
  // sideways (arch-metrics.ts:49-57 - a thing you must drag sideways is a thing
  // nobody reads).
  it("keeps the rail's sideways scroll inside the rail", () => {
    expect(html).toContain("overflow-x-auto");
    const rail = html.slice(
      html.indexOf('aria-label="Template categories"'),
      html.indexOf(">Recommended</h4>"),
    );
    expect(rail).toContain("overflow-x-auto");
    // A row on a phone, a column from lg up.
    expect(rail).toContain("lg:flex-col");
    expect(rail).toContain("lg:overflow-x-visible");
  });

  it("stacks the rail above the shelf and drops the grid to one column", () => {
    // Two columns only from lg; a bare `grid` below that is the stacked case.
    expect(html).toContain("lg:grid-cols-[190px_minmax(0,1fr)]");
    // Cards: the base `grid` has no column count at all, so a phone gets one
    // column; two from sm, three from xl. Asserted as the whole class run,
    // because an unprefixed grid-cols-2 hiding in there is exactly the bug.
    expect(html).toContain("grid gap-3 sm:grid-cols-2 xl:grid-cols-3");
  });

  it("scrolls the shelf vertically inside itself rather than the page", () => {
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("max-h-[76vh]");
  });
});

/* ---------------------------------------------------------------------------
 * 6. Stages 2 and 3 in the panel - and the create contract underneath them.
 * ------------------------------------------------------------------------- */

describe("the panel stages the create without forking it", () => {
  // THE ONE THAT MATTERS. The redesign is presentation; the moment the body or
  // the route changes, it is not.
  it("still POSTs the same body to the same route", () => {
    expect(panelSource).toContain('fetch("/api/smile-assessment/campaign", {');
    const postAt = panelSource.indexOf('fetch("/api/smile-assessment/campaign", {');
    const body = panelSource.slice(postAt, panelSource.indexOf("const data", postAt));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('method: "POST"');
    for (const field of [
      "clientSlug,",
      "name: form.name,",
      "goal: form.goal,",
      "targetBudget: form.targetBudget,",
      "idealCustomer: form.idealCustomer || undefined,",
      "headline: form.headline || undefined,",
      "intro: form.intro || undefined,",
      "slug: form.slug || undefined,",
    ]) {
      expect(body, `create body lost ${field}`).toContain(field);
    }
    // Exactly one create call: no second path was grown alongside it.
    expect(occurrences(panelSource, 'fetch("/api/smile-assessment/campaign", {')).toBe(1);
  });

  // MUTATION: publish the funnel on create and a brand-new assessment changes
  // what a patient sees before anyone has read it.
  it("saves the chosen funnel as an unpublished draft, after the campaign exists", () => {
    expect(panelSource).toContain("published: false");
    expect(panelSource).toContain("created.flowPublished = false;");
    const submit = panelSource.slice(panelSource.indexOf("async function submit"));
    expect(submit.indexOf("saveDraftFlow(created")).toBeGreaterThan(
      submit.indexOf('fetch("/api/smile-assessment/campaign", {'),
    );
  });

  // MUTATION: re-implement the stages as booleans and "details is unreachable
  // without a choice" stops being a rule anything holds.
  it("drives its screens from the pure reducer, not from local booleans", () => {
    expect(panelSource).toContain("useReducer(wizardReducer, INITIAL_WIZARD)");
    for (const call of ["isGalleryOpen(wizard)", "isDetailsOpen(wizard)", "isListVisible(wizard)"]) {
      expect(panelSource, `missing ${call}`).toContain(call);
    }
    // The old single-flag form is gone, not merely unused.
    expect(codeOnly(panelSource)).not.toContain("showForm");
  });

  // MUTATION: leave the goal as a free <select> and an Invisalign funnel can be
  // pinned to a whitening assessment, asking the wrong question on screen one.
  it("locks the goal to the choice, with a back-link as the only way to change it", () => {
    expect(panelSource).toContain("lockedGoal(wizard)");
    expect(panelSource).toContain("goalLabel(lockedGoalKey)");
    expect(panelSource).toContain("Change template");
    // The free dropdown survives only for the scratch case, which has no goal.
    expect(panelSource).toContain("lockedGoalKey ? (");
    expect(panelSource).toContain('dispatch({ type: "back" })');
  });

  // MUTATION: drop the auto-open and stage 3 never happens - the owner is left
  // on a list, with a draft funnel they have no reason to know about.
  it("opens the new campaign's canvas on create, seeded with the chosen funnel", () => {
    expect(panelSource).toContain("setOpenCanvasFor(created.id)");
    expect(panelSource).toContain("useState(openCanvasFor === campaign.id)");
    // Seeded: the chosen graph is put on the campaign before it reaches the list.
    expect(panelSource).toContain("created.flow = choice.graph;");
    expect(panelSource).toContain("graph={stored.graph ?? templateForGoal(campaign.goal).build()}");
  });

  it("hides the list while a wizard screen is up, so it is one screen at a time", () => {
    expect(panelSource).toContain("{!isListVisible(wizard) ? null :");
  });

  // A DELIBERATE REVERSAL, and it belongs in writing rather than in a git blame.
  //
  // The test this replaces said "the real canvas, not a phone mockup", and it was
  // right about the thing it killed: assessment-preview.tsx was ONE static drawing
  // of the landing screen, parked in a 300px second column, showing the headline
  // and intro fields the owner was typing three inches to its left - while the
  // funnel actually being attached was squeezed into what was left. It duplicated
  // the form and smudged the funnel. Deleting it was correct.
  //
  // What replaces the canvas here is not that. It is EVERY step of the funnel,
  // each drawn as the screen a patient sees, laid out by the same engine at phone
  // metrics. The old objection is answered rather than ignored: the funnel is no
  // longer a smudge, the funnel IS the minis, and the headline is shown in the one
  // place a patient ever reads it - above question one - instead of as a screen of
  // its own that the runtime does not have.
  //
  // MUTATION: put the abstract canvas back on stage 2 and the owner is once again
  // confirming a template by reading the words "Question", "Contact details",
  // "Result · Hot" - which are true of every template on the shelf, and therefore
  // tell you nothing about the one you picked.
  it("previews the chosen funnel as the screens a patient sees, step by step", () => {
    expect(panelSource).toContain("<FlowPhoneCanvas");
    expect(panelSource).toContain("phoneFlowLayout(choice.graph)");
    // One screen per step, resolved from the graph and numbered by the layout -
    // never from describeNode, which writes for the owner and drops the option
    // values the icons are chosen by.
    expect(panelSource).toContain("screenFor(node, choice.graph,");
    expect(codeOnly(panelSource)).not.toContain("describeNode");
    // The abstract canvas is gone from stage 2 - and, since A1's parity pass, from
    // stage 3 as well. PIN CHANGED: this used to require the builder to KEEP
    // "<FlowCanvas" ("the edit canvas lost its cards"), on the argument that cards
    // were the right drawing for wiring. They are not the only one: the strip draws
    // the same routed wires from the same layout engine, and every connection is a
    // row in its step's rail. The file itself stays in the repo - the thumbnails
    // below still take their kind colours from it - so this now pins that NEITHER
    // stage mounts it, which is the claim that could regress.
    expect(codeOnly(panelSource)).not.toContain("<FlowCanvas");
    expect(codeOnly(builderSource), "the abstract canvas is back").not.toContain("<FlowCanvas");
    expect(gallerySource, "the thumbnails still read its colours").toContain(
      'import { NODE_ACCENT } from "./flow-canvas"',
    );
    // Gone, not merely unrendered: the single static mockup stays dead.
    expect(panelSource).not.toContain("AssessmentPreview");
    expect(panelSource).not.toContain("FlowShapeThumbnail");
    // ...and stage 2 is still one column: the strip is full width, not a sidebar.
    expect(codeOnly(panelSource)).not.toContain("lg:grid-cols-[minmax(0,1fr)_300px]");
  });

  // MUTATION: hand the preview a select callback and the wizard grows a second,
  // half-built editor - on a funnel that has no campaign to be saved against yet.
  // MUTATION: drop the cap or the overflow and a 3400px-wide, 1500px-tall strip
  // either pushes the form off the bottom of the screen or hides two thirds of
  // the funnel with no way to reach it.
  it("keeps that preview read-only, with its scrolling to itself", () => {
    const at = panelSource.indexOf("<FlowPhoneCanvas");
    expect(at).toBeGreaterThan(-1);
    const tag = panelSource.slice(at, panelSource.indexOf("/>", at));
    expect(tag).not.toContain("onSelect");
    expect(tag).not.toContain("onChoose");
    // The scroll box is the strip's own, and it is capped in both directions.
    expect(phoneCanvasSource).toContain("overflow-auto");
    expect(phoneCanvasSource).toMatch(/max-h-\[\d+px\]/);
  });

  it("keeps the panel free of colour literals too", () => {
    expect(panelSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
