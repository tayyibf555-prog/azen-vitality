// "YOUR THEMES" IN THE TWO PICKERS, rendered for real.
//
// campaign-recolour.test.ts holds the re-colour control against the SEVEN presets:
// one control per card, in catalogue order, checked against that campaign's stored
// scheme. This file holds the half that arrives with 0081 — the practice's own
// schemes, which are a different list on every practice's screen and can be
// deleted out from under a campaign that is wearing one.
//
// TECHNIQUE, same split as its neighbours: vitest runs environment:"node" and
// collects only src/**\/*.test.ts, so this is renderToStaticMarkup for what the
// card PAINTS, plus the component source read as text for what a static render
// cannot show. The card's state is all initial-render state, so a static render is
// the real first paint of a campaign as it arrives from the API.
//
// WHAT IS HELD HERE AND NOWHERE ELSE:
//   1. the custom group is drawn from the SAME projection the public page renders
//      from, so its chips cannot differ from the colours a patient sees;
//   2. it is a group of its OWN, after the presets, rather than fifteen swatches
//      in a row;
//   3. a campaign wearing a custom scheme has that scheme checked, and exactly it;
//   4. a campaign wearing a scheme that is GONE shows what the public page shows —
//      the shipped default — rather than nothing at all;
//   5. with no custom schemes, the card is byte-identical to the pre-0081 card.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CampaignCard } from "./campaigns-panel";
import { THEME_FORM_TOKENS } from "./custom-theme-panel";
import { PALETTES, PALETTE_TOKENS, paletteFor, swatchFromVars } from "@/lib/assess/palette";
import { customThemeRef, type CustomTheme } from "@/lib/assess/custom-theme";

const PANEL_PATH = "src/components/client/smile-assessment/campaigns-panel.tsx";
const panelSource = readFileSync(resolve(process.cwd(), PANEL_PATH), "utf8");

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

/** Two of the practice's own schemes, built from tuned presets (which pass the gate). */
const MINE: CustomTheme[] = [
  {
    id: ID_A,
    clientId: "vitality",
    name: "Practice brand",
    vars: PALETTES.find((p) => p.key === "clinical-teal")!.vars,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  },
  {
    id: ID_B,
    clientId: "vitality",
    name: "Autumn campaign",
    vars: PALETTES.find((p) => p.key === "warm-sand")!.vars,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  },
];

function campaign(over: { id: string; name: string; theme?: string | null }) {
  return {
    id: over.id,
    slug: "spring-invisalign",
    name: over.name,
    goal: "invisalign",
    goalLabel: "Invisalign",
    targetBudget: "any",
    budgetLabel: "Any budget",
    headline: null,
    intro: null,
    idealCustomer: null,
    goalNote: null,
    status: "active" as const,
    createdBy: null,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    url: "https://example.test/assess/vitality/spring-invisalign",
    path: "/assess/vitality/spring-invisalign",
    responseCount: 3,
    ...("theme" in over ? { theme: over.theme } : {}),
  };
}

function renderCard(
  c: ReturnType<typeof campaign>,
  customThemes?: readonly CustomTheme[],
): string {
  return renderToStaticMarkup(
    createElement(
      "ul",
      null,
      createElement(CampaignCard, {
        clientSlug: "vitality",
        campaign: c,
        customThemes,
        togglingId: null,
        openCanvasFor: null,
        onToggleStatus: () => {},
        onCampaignUpdated: () => {},
      }),
    ),
  );
}

const presetGroup = (name: string) => `aria-label="Colour scheme for ${name}"`;
const customGroup = (name: string) => `aria-label="Your colour schemes for ${name}"`;

/** The slice of markup belonging to one radiogroup (it ends at its own </div>). */
function group(html: string, label: string): string {
  const at = html.indexOf(label);
  expect(at, `no group ${label}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</div>", at));
}

/* ---------------------------------------------------------------------------
 * 1. Nothing changes for a practice that has not built one.
 * ------------------------------------------------------------------------- */

describe("a practice with no schemes of its own sees exactly what it saw before", () => {
  // MUTATION: render the group unconditionally (an empty <div role="radiogroup">,
  // or a "Your themes" heading over nothing) and every practice on the platform
  // gets a permanent empty shelf on every campaign card.
  it("draws no second group at all", () => {
    for (const html of [
      renderCard(campaign({ id: "a", name: "Spring ads", theme: null })),
      renderCard(campaign({ id: "a", name: "Spring ads", theme: null }), []),
    ]) {
      expect(occurrences(html, 'role="radiogroup"')).toBe(1);
      expect(html).toContain(presetGroup("Spring ads"));
      expect(html).not.toContain(customGroup("Spring ads"));
      expect(occurrences(html, 'role="radio"')).toBe(PALETTES.length);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The group itself.
 * ------------------------------------------------------------------------- */

describe("the practice's own schemes are a group of their own, after the presets", () => {
  // MUTATION: append them to the preset radiogroup and a row of fifteen identical
  // swatches hides the line between "one of the seven" and "the one we made" —
  // and arrow-key navigation stops meaning anything.
  it("is a second radiogroup, and it comes after the first", () => {
    const html = renderCard(campaign({ id: "a", name: "Spring ads", theme: null }), MINE);
    expect(occurrences(html, 'role="radiogroup"')).toBe(2);
    expect(html.indexOf(customGroup("Spring ads"))).toBeGreaterThan(
      html.indexOf(presetGroup("Spring ads")),
    );
    // The presets are untouched by its arrival: still seven, still in order.
    expect(occurrences(group(html, presetGroup("Spring ads")), 'role="radio"')).toBe(PALETTES.length);
  });

  // MUTATION: hand-derive the chips here (or show a different three tokens) and the
  // owner picks from colours that are not the colours the page renders — the exact
  // failure PaletteChips and definePalette exist to prevent, reintroduced for the
  // one group whose colours nobody reviewed.
  it("shows each scheme's own three chips, derived like every preset's", () => {
    const html = renderCard(campaign({ id: "a", name: "Spring ads", theme: null }), MINE);
    const mine = group(html, customGroup("Spring ads"));
    expect(occurrences(mine, 'role="radio"')).toBe(MINE.length);
    let cursor = -1;
    for (const theme of MINE) {
      const at = mine.indexOf(`aria-label="${theme.name}"`);
      expect(at, `${theme.name} missing from the group`).toBeGreaterThan(-1);
      expect(at, `${theme.name} out of order`).toBeGreaterThan(cursor);
      cursor = at;
      for (const colour of swatchFromVars(theme.vars)) {
        expect(mine, `${theme.name} chip ${colour}`).toContain(`background:${colour}`);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. What is checked.
 * ------------------------------------------------------------------------- */

describe("a campaign wearing one of the practice's own schemes says so", () => {
  // MUTATION: compare the stored value only against the catalogue and a campaign
  // on a custom scheme shows NOTHING checked — or, worse, shows Vitality blue
  // checked while the patient is looking at the practice's own colours.
  it("checks that scheme, and only it, across both groups", () => {
    for (const theme of MINE) {
      const html = renderCard(
        campaign({ id: "a", name: "Spring ads", theme: customThemeRef(theme.id) }),
        MINE,
      );
      expect(occurrences(html, 'aria-checked="true"'), theme.name).toBe(1);
      expect(html).toContain(`aria-checked="true" aria-label="${theme.name}"`);
      // ...and the line that names the scheme in force names it too, rather than
      // falling back to a catalogue label the patient is not seeing.
      expect(html).toContain(theme.name);
    }
  });

  // MUTATION: the campaigns keep their own schemes. A control that resolved
  // against the wrong campaign's value is the failure campaign-recolour.test.ts
  // was written for, restated for a list that also contains custom schemes.
  it("keeps two cards' schemes apart", () => {
    const html = renderToStaticMarkup(
      createElement(
        "ul",
        null,
        createElement(CampaignCard, {
          key: "a",
          clientSlug: "vitality",
          campaign: campaign({ id: "a", name: "Spring ads", theme: customThemeRef(ID_A) }),
          customThemes: MINE,
          togglingId: null,
          openCanvasFor: null,
          onToggleStatus: () => {},
          onCampaignUpdated: () => {},
        }),
        createElement(CampaignCard, {
          key: "b",
          clientSlug: "vitality",
          campaign: campaign({ id: "b", name: "Instagram bio", theme: "deep-plum" }),
          customThemes: MINE,
          togglingId: null,
          openCanvasFor: null,
          onToggleStatus: () => {},
          onCampaignUpdated: () => {},
        }),
      ),
    );
    // Spring wears one of the practice's own, so nothing in ITS preset row is
    // checked and the scheme is checked in its custom group instead.
    expect(group(html, presetGroup("Spring ads"))).not.toContain('aria-checked="true"');
    expect(group(html, customGroup("Spring ads"))).toContain(
      'aria-checked="true" aria-label="Practice brand"',
    );
    // Instagram wears a preset, so it is the other way round on that card - and
    // the two cards' custom groups do not agree with each other.
    expect(group(html, presetGroup("Instagram bio"))).toContain(
      `aria-checked="true" aria-label="${paletteFor("deep-plum").label}"`,
    );
    expect(group(html, customGroup("Instagram bio"))).not.toContain('aria-checked="true"');
  });

  // MUTATION: THE ONE THAT MATTERS FOR A DANGLING REFERENCE. Deleting a theme in
  // use is refused by the API, but a restored backup or a hand-edited row can
  // still produce one. The public page renders the shipped default for it
  // (resolveCustomTheme -> null -> paletteVars), so the control must show the
  // shipped default too. Comparing the raw string leaves nothing checked: a
  // control silently disagreeing with the page it controls.
  it("falls back to the default scheme when the theme it names is gone", () => {
    const html = renderCard(
      campaign({ id: "a", name: "Spring ads", theme: customThemeRef(ID_A) }),
      [], // the practice has none: deleted, or another practice's id
    );
    expect(occurrences(html, 'aria-checked="true"')).toBe(1);
    expect(html).toContain(`aria-checked="true" aria-label="${paletteFor(null).label}"`);
    expect(html).toContain(paletteFor(null).label);
  });
});

/* ---------------------------------------------------------------------------
 * 4. The wiring the render cannot show.
 * ------------------------------------------------------------------------- */

describe("the panel resolves a scheme the same way in all three places", () => {
  const code = codeOnly(panelSource);

  // MUTATION: resolve the picker's preview through paletteVars alone and the
  // create wizard's strip — the one thing on that screen showing what a colour
  // does — goes back to Vitality blue the moment an owner picks their own scheme.
  it("wears the resolved scheme on the create wizard's strip", () => {
    expect(code).toContain("themeVarsFor(form.theme, customThemes)");
    const wrapperAt = code.indexOf("themeVarsFor(form.theme");
    const stripAt = code.indexOf("<FlowPhoneCanvas");
    expect(stripAt).toBeGreaterThan(wrapperAt);
  });

  it("uses one resolver for the vars and one for the checked button", () => {
    // Both fall through to the catalogue, which falls through to the shipped look
    // — the same two steps the public page takes.
    expect(code).toContain("function themeVarsFor(");
    expect(code).toContain("function themeInForce(");
    expect(code).toContain("(customPaletteFor(value, themes) ?? paletteFor(value)).key");
    // Neither picker compares the raw stored string to a palette key any more.
    expect(code).toContain("const inForce = themeInForce(value, customThemes);");
    expect(occurrences(code, "selected={palette.key === inForce}")).toBe(2);
  });

  // MUTATION: fetch the themes inside each picker and a page of eight cards issues
  // eight identical requests — and the eight lists drift the moment one saves.
  it("fetches the practice's schemes once, at the panel", () => {
    expect(occurrences(code, "/api/smile-assessment/theme?client=")).toBe(1);
    expect(code).toContain("customThemes={customThemes}");
    // A themes failure must not take the assessment list down with it: two reads,
    // two try/catches, and the themes one sets no page-level error.
    expect(code).toContain("const loadThemes = useCallback(");
    expect(code).toContain("void loadThemes();");
  });

  // The panel-wide colour-literal ban still holds. This is the change that would
  // have broken it — an eighteen-field colour editor — which is why the editor is
  // its own file.
  it("adds no colour literal to the panel", () => {
    expect(panelSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

/* ---------------------------------------------------------------------------
 * 5. The editor's field set.
 * ------------------------------------------------------------------------- */

describe("the builder offers a field for every colour the server requires", () => {
  // MUTATION: drop a token from the form's groups. The Record<PaletteToken, string>
  // label map catches an unlabelled token at compile time; a labelled token that
  // nobody put in a group compiles fine, and produces a form whose save can never
  // succeed — the server refuses a map that is missing one — with nothing on
  // screen to tell an owner which colour is absent.
  it("renders exactly the closed token set, once each", () => {
    expect([...THEME_FORM_TOKENS].sort()).toEqual([...PALETTE_TOKENS].sort());
    expect(new Set(THEME_FORM_TOKENS).size).toBe(THEME_FORM_TOKENS.length);
  });
});
