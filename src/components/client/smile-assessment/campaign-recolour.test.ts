// RE-COLOURING AN ASSESSMENT THAT ALREADY EXISTS.
//
// The scheme could only ever be chosen at CREATION: ThemePicker mounts once, on
// the template summary card of the details screen, and campaign-theme.test.ts
// pins it there. The server half of changing one's mind has existed since 0079 —
// the PATCH route takes a theme, validates it against the closed catalogue and
// writes it (campaign-theme.test.ts, "lets an existing assessment be
// re-coloured") — with nothing on any screen calling it. This suite holds the
// missing half: the control on the card.
//
// TECHNIQUE, and the split. vitest runs environment:"node" and collects only
// src/**\/*.test.ts, so this is renderToStaticMarkup for what the card PAINTS
// plus the component source read as text for what a static render cannot show —
// the same split create-experience-shell.test.ts and campaign-theme.test.ts use.
// The card's own state is all initial-render state, so a static render is the
// real first paint of a campaign as it arrives from the API.
//
// WHAT IS HELD HERE and nowhere else: that the control is checked against THAT
// campaign's stored scheme. Every other link in the chain — which keys exist,
// what null resolves to, what the route accepts, what the page renders — is
// already held by palette.test.ts and campaign-theme.test.ts, and is not
// restated.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CampaignCard } from "./campaigns-panel";
import { DEFAULT_PALETTE_KEY, PALETTES, paletteFor } from "@/lib/assess/palette";

const PANEL_PATH = "src/components/client/smile-assessment/campaigns-panel.tsx";
const PREVIEW_PATH = "src/components/client/smile-assessment/assessment-live-preview.tsx";

const panelSource = readFileSync(resolve(process.cwd(), PANEL_PATH), "utf8");
const previewSource = readFileSync(resolve(process.cwd(), PREVIEW_PATH), "utf8");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** One campaign as the admin API hands it over. */
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
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
    url: "https://example.test/assess/vitality/spring-invisalign",
    path: "/assess/vitality/spring-invisalign",
    responseCount: 3,
    ...("theme" in over ? { theme: over.theme } : {}),
  };
}

/** The cards as a list, so the `<li>` sits in the `<ul>` it is written for. */
function renderCards(...campaigns: ReturnType<typeof campaign>[]): string {
  return renderToStaticMarkup(
    createElement(
      "ul",
      null,
      ...campaigns.map((c) =>
        createElement(CampaignCard, {
          key: c.id,
          clientSlug: "vitality",
          campaign: c,
          togglingId: null,
          openCanvasFor: null,
          onToggleStatus: () => {},
          onCampaignUpdated: () => {},
        }),
      ),
    ),
  );
}

const groupLabel = (name: string) => `aria-label="Colour scheme for ${name}"`;

/** The slice of markup belonging to one card's re-colour control. */
function controlOf(html: string, name: string): string {
  const at = html.indexOf(groupLabel(name));
  expect(at, `no re-colour control on ${name}'s card`).toBeGreaterThan(-1);
  // Ends where the group does: the first thing rendered after it is the line
  // naming the current scheme.
  return html.slice(at, html.indexOf("</div>", at));
}

/* ---------------------------------------------------------------------------
 * 1. The mount: a re-colour control on every card, drawn from the catalogue.
 * ------------------------------------------------------------------------- */

describe("every campaign card carries a re-colour control", () => {
  // MUTATION: drop the control and the scheme is once again a decision that can
  // only be made in the four seconds before an assessment is created, on a screen
  // that is gone forever afterwards.
  it("renders one control per card, named for its own campaign", () => {
    const html = renderCards(
      campaign({ id: "a", name: "Spring ads", theme: null }),
      campaign({ id: "b", name: "Instagram bio", theme: "deep-plum" }),
    );
    expect(occurrences(html, 'role="radiogroup"')).toBe(2);
    expect(html).toContain(groupLabel("Spring ads"));
    expect(html).toContain(groupLabel("Instagram bio"));
  });

  // MUTATION: hand-type the swatches, or a subset of the catalogue, and the owner
  // re-colours from a second copy of the palette — free to drift from the one the
  // public page renders, and from the one they chose at creation.
  it("offers every scheme in the catalogue, in catalogue order, with its own chips", () => {
    const html = renderCards(campaign({ id: "a", name: "Spring ads", theme: null }));
    const control = controlOf(html, "Spring ads");

    let cursor = -1;
    for (const palette of PALETTES) {
      const at = control.indexOf(`aria-label="${palette.label}"`);
      expect(at, `${palette.key} missing from the row`).toBeGreaterThan(-1);
      expect(at, `${palette.key} out of catalogue order`).toBeGreaterThan(cursor);
      cursor = at;
      // Its OWN three colours, straight off the catalogue entry.
      for (const colour of palette.swatch) {
        expect(control, `${palette.key} chip ${colour}`).toContain(`background:${colour}`);
      }
    }
    expect(occurrences(control, 'role="radio"')).toBe(PALETTES.length);
  });
});

/* ---------------------------------------------------------------------------
 * 2. THE ONE THAT MATTERS: it is checked against THAT campaign's scheme.
 * ------------------------------------------------------------------------- */

describe("the control reflects the campaign's current scheme", () => {
  // MUTATION: hold the row's value in local state seeded once, or default it, and
  // every card shows Vitality blue as selected however the campaign is coloured -
  // a control that lies about what the patient is being shown.
  it("marks the campaign's own scheme, and only that one", () => {
    for (const palette of PALETTES) {
      const html = renderCards(campaign({ id: "a", name: "Spring ads", theme: palette.key }));
      const control = controlOf(html, "Spring ads");
      // Exactly one is in force...
      expect(occurrences(control, 'aria-checked="true"'), palette.key).toBe(1);
      // ...and it is this campaign's own. (Attribute order is the JSX's:
      // aria-checked, then aria-label.)
      expect(control, `${palette.key} is not the checked one`).toContain(
        `aria-checked="true" aria-label="${palette.label}"`,
      );
    }
  });

  // MUTATION: the whole feature rests on this. null is every campaign made before
  // the picker existed and every campaign on a deployment where 0079 has not been
  // applied; showing NOTHING selected would invite a "fix" that re-colours a live
  // ad destination nobody touched.
  it("shows the default scheme for a campaign that never chose one", () => {
    const fallback = PALETTES.find((p) => p.key === DEFAULT_PALETTE_KEY);
    expect(fallback).toBeTruthy();
    for (const html of [
      renderCards(campaign({ id: "a", name: "Spring ads", theme: null })),
      // ...and for a row read off a table where the column does not exist yet.
      renderCards(campaign({ id: "a", name: "Spring ads" })),
    ]) {
      const control = controlOf(html, "Spring ads");
      expect(occurrences(control, 'aria-checked="true"')).toBe(1);
      expect(control).toContain(`aria-checked="true" aria-label="${fallback!.label}"`);
    }
  });

  // MUTATION: name it from the raw key and a card reads "deep-plum"; name it from
  // a local map and a retired key reads as a scheme the patient is not seeing.
  it("names the scheme in force through the catalogue", () => {
    const html = renderCards(campaign({ id: "a", name: "Spring ads", theme: "deep-plum" }));
    expect(html).toContain(paletteFor("deep-plum").label);
    expect(codeOnly(panelSource)).toContain("paletteFor(campaign.theme).label");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The wiring: the route that already exists, called the way the card's other
 *    edit calls it.
 * ------------------------------------------------------------------------- */

/** The re-colour handler's body: from its `async function` to the closing brace
 *  at the function's own indent (the first `\n  }` after it — everything inside
 *  it is nested deeper). */
function recolourBody(source: string): string {
  const code = codeOnly(source);
  const at = code.indexOf("async function recolour");
  if (at < 0) return "";
  return code.slice(at, code.indexOf("\n  }", at));
}

describe("selecting a scheme PATCHes the campaign", () => {
  const code = codeOnly(panelSource);
  const recolour = recolourBody(panelSource);

  it("has a re-colour handler at all", () => {
    expect(recolour.length).toBeGreaterThan(0);
  });

  // MUTATION: invent a second client - a new route, a POST, a body of its own -
  // and the re-colour path stops being the one the route was built and tested for.
  it("reuses the pause/activate PATCH: same route, same shape", () => {
    expect(recolour).toContain('method: "PATCH"');
    expect(recolour).toContain(
      "/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}?client=${encodeURIComponent(clientSlug)}",
    );
    // THREE PATCHes in the panel since 0082, to that ONE URL: status, theme, and
    // the follow-up settings. The number is the closed list of things a card can
    // write, and it is checked against the URL count rather than on its own — so
    // the real claim ("every write on this card goes to the campaign route, by
    // PATCH, and no fourth client was invented") is what fails if either drifts.
    const patches = occurrences(code, 'method: "PATCH"');
    expect(patches).toBe(3);
    expect(
      occurrences(
        code,
        "/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}?client=${encodeURIComponent(clientSlug)}",
      ),
    ).toBe(patches);
    // The panel's ONE non-PATCH write is the create (a different route, a
    // different act). Named here so "three PATCHes" is a closed list rather than
    // a number that happens to be true, and so a fourth writer of any method has
    // to come through this test.
    expect(occurrences(code, 'method: "POST"')).toBe(1);
    expect(occurrences(code, 'method: "DELETE"')).toBe(0);
  });

  // MUTATION: send `status` alongside, and re-colouring a paused assessment
  // silently starts it capturing again. The route reads PRESENCE, not truthiness
  // (campaign/[slug]/route.ts), so the field must simply not be there.
  it("sends the theme alone, never restating the status", () => {
    expect(recolour).toContain("JSON.stringify({ clientSlug, theme: key })");
    // The toggle's body is `{ clientSlug, status: next }`; nothing of that shape
    // may appear on this path.
    expect(recolour).not.toContain("status:");
  });

  // MUTATION: drop the revert and a rejected write leaves the card showing a
  // scheme the row does not have, until the next reload contradicts it.
  it("is optimistic, and puts the old scheme back if the write fails", () => {
    expect(recolour).toContain("onCampaignUpdated(campaign.id, { theme: key });");
    expect(recolour).toContain("const previous = campaign.theme ?? null;");
    expect(recolour).toContain("onCampaignUpdated(campaign.id, { theme: previous });");
    // The optimistic write happens before the fetch, the revert after it.
    expect(recolour.indexOf("{ theme: key });")).toBeLessThan(recolour.indexOf("await fetch"));
    expect(recolour.indexOf("{ theme: previous });")).toBeGreaterThan(recolour.indexOf("await fetch"));
  });

  // MUTATION: swallow the failure the way the status toggle does and the 503 the
  // route answers with when 0079 has not been applied - the one failure this path
  // actually has - reaches the owner as a swatch that quietly un-picks itself.
  it("says why, rather than only reverting", () => {
    expect(recolour).toContain("setThemeError(");
    expect(recolour).toContain("data.error ||");
    expect(code).toContain("{themeError}");
  });

  // MUTATION: leave the row unlocked and a second click mid-flight starts a race
  // whose loser writes the scheme the owner did not pick last.
  it("locks the row while a write is in flight", () => {
    expect(recolour).toContain("if (themeSaving || key === currentTheme) return;");
    expect(code).toContain("busy={themeSaving !== null}");
    expect(code).toContain("disabled={busy}");
  });

  it("reads null as the default, once, and hands that to the control", () => {
    expect(code).toContain("const currentTheme = campaign.theme ?? DEFAULT_PALETTE_KEY;");
    expect(code).toContain("value={currentTheme}");
  });
});

/* ---------------------------------------------------------------------------
 * 4. Where it sits, and what it repaints.
 * ------------------------------------------------------------------------- */

describe("the row sits above the preview it repaints", () => {
  // MUTATION: move it below the preview (or into the collapsed detail list) and
  // the owner picks a colour with nothing on screen showing what the colour does
  // - the same mistake the create picker was moved to avoid.
  it("comes after the public link and before the live preview", () => {
    const code = codeOnly(panelSource);
    const card = code.slice(code.indexOf("export function CampaignCard"));
    const link = card.indexOf("<CopyLink url={campaign.url} />");
    const row = card.indexOf("<ThemeSwatchRow");
    const preview = card.indexOf("<AssessmentLivePreview");
    for (const [what, at] of Object.entries({ link, row, preview })) {
      expect(at, `${what} not found on the card`).toBeGreaterThan(-1);
    }
    expect(row).toBeGreaterThan(link);
    expect(row).toBeLessThan(preview);
    // One control per card, not one per list and not two per card.
    expect(occurrences(code, "<ThemeSwatchRow")).toBe(1);
  });

  // MUTATION: leave the iframe keyed on the style alone and the one thing on the
  // card that renders the scheme keeps rendering the old one after a successful
  // save - a change that DID land, reading as a change that did not.
  it("re-frames the preview after a save, so it shows the new scheme", () => {
    const code = codeOnly(panelSource);
    expect(code).toContain("setPreviewNonce((n) => n + 1);");
    expect(code).toContain("reloadKey={previewNonce}");
    expect(codeOnly(previewSource)).toContain("key={`${style}-${reloadKey}`}");
    // Only on success: a rejected write must not reload anything.
    const recolour = recolourBody(panelSource);
    expect(recolour.indexOf("setPreviewNonce")).toBeLessThan(recolour.indexOf("} catch"));
  });

  // The panel-wide colour-literal ban (create-experience-shell.test.ts:423),
  // restated here because a swatch row is exactly the change that would break it.
  it("adds no colour literal to the panel", () => {
    expect(panelSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(panelSource).toContain('from "@/lib/assess/palette"');
  });
});
