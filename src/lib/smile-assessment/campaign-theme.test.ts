// THE COLOUR SCHEME'S ROUND TRIP: picker -> create POST -> row -> public payload
// -> the wrapper the patient's browser is handed.
//
// WHAT THIS SUITE IS AND IS NOT. The RULE — which keys exist, what an unknown one
// resolves to, whether a value is even a colour — lives in src/lib/assess/palette.ts
// and is tested beside itself in palette.test.ts. What is left over, and what a
// refactor breaks in silence, is the WIRING: a route that stops asking the
// catalogue, a repository that stores the key but never reads it back, a page that
// resolves a theme and then renders it somewhere it cannot reach the gutters.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts.
// Three of the five links in the chain are a server component, an API route and a
// client component — none of them callable here (they reach for a service-role
// Supabase client, requireUser, and the DOM). So each of those is held by reading
// its source, the same split create-experience-shell.test.ts uses. The two links
// that ARE pure — toPublicCampaign and the catalogue — are called for real.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PALETTE_KEYS, isPaletteKey, paletteVars } from "@/lib/assess/palette";
import { toPublicCampaign, type Campaign } from "./campaign";

const REPO_PATH = "src/lib/smile-assessment/campaign-repository.ts";
const CREATE_ROUTE_PATH = "src/app/api/smile-assessment/campaign/route.ts";
const PATCH_ROUTE_PATH = "src/app/api/smile-assessment/campaign/[slug]/route.ts";
const PAGE_PATH = "src/app/assess/[client]/[slug]/page.tsx";
const PANEL_PATH = "src/components/client/smile-assessment/campaigns-panel.tsx";
const MIGRATION_PATH = "supabase/migrations/0079_assessment_theme.sql";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const repoSource = read(REPO_PATH);
const createRouteSource = read(CREATE_ROUTE_PATH);
const patchRouteSource = read(PATCH_ROUTE_PATH);
const pageSource = read(PAGE_PATH);
const panelSource = read(PANEL_PATH);

/** Source with comments stripped: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function campaign(theme: string | null): Campaign {
  return {
    id: "id-1",
    clientId: "client-vitality",
    siteId: "site-cc",
    slug: "spring-invisalign",
    name: "Spring Invisalign",
    goal: "invisalign",
    goalNote: null,
    idealCustomer: null,
    targetBudget: "any",
    headline: "Is Invisalign right for you?",
    intro: null,
    status: "active",
    flow: null,
    flowVersion: 0,
    flowPublished: false,
    theme,
    followUpEnabled: false,
    followUpTrigger: null,
    followUpTemplate: null,
    createdBy: null,
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
  };
}

/* ---------------------------------------------------------------------------
 * 1. The public payload, called for real.
 * ------------------------------------------------------------------------- */

describe("the theme reaches the public payload", () => {
  it("carries every catalogue key through unchanged", () => {
    for (const key of PALETTE_KEYS) {
      expect(toPublicCampaign(campaign(key)).theme).toBe(key);
    }
  });

  // MUTATION: strip theme from the public payload and the picker still works,
  // the row still stores it, and the page silently renders the default forever.
  it("keeps theme on the payload the page reads", () => {
    expect("theme" in toPublicCampaign(campaign(null))).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * 2. The write path: the picker and the two routes.
 * ------------------------------------------------------------------------- */

describe("the create path sends and validates a scheme", () => {
  // MUTATION: the create contract is pinned per-field by
  // create-experience-shell.test.ts:300-313. This is the other half: the field
  // was ADDED, not the body restructured.
  it("adds exactly one field to the create POST", () => {
    const at = panelSource.indexOf('fetch("/api/smile-assessment/campaign", {');
    expect(at).toBeGreaterThan(-1);
    const body = panelSource.slice(at, panelSource.indexOf("const data", at));
    expect(body).toContain("theme: form.theme,");
  });

  it("starts the form on the unchanged look", () => {
    expect(panelSource).toContain("theme: DEFAULT_PALETTE_KEY,");
  });

  // MUTATION: hand-type the swatches in the panel and the owner is choosing from
  // a second copy of the palette, free to drift from the one the page renders.
  it("draws the picker from the catalogue, never from a literal", () => {
    expect(panelSource).toContain('from "@/lib/assess/palette"');
    expect(panelSource).toContain("PALETTES.map((palette)");
    expect(panelSource).toContain("palette.swatch.map((colour");
    // The panel-wide colour-literal ban (create-experience-shell.test.ts:363),
    // restated here because THIS is the change that would have broken it.
    expect(panelSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // WHERE THE PICKER LIVES, pinned - because it moved, and because the reason it
  // moved is invisible to every other assertion in this file. The scheme belongs
  // to the CHOICE, next to the template's name and its question count, on the
  // summary card at the top of the details screen - and it is the one control on
  // that card whose effect is visible from it, since the preview strip directly
  // below wears paletteVars(form.theme) and repaints as the scheme is picked.
  //
  // MUTATION: slide it back down among the details fields and the owner is once
  // again choosing a colour several fields away from the only thing on screen
  // that shows what the colour does.
  it("puts the picker on the template summary card, above the strip it repaints", () => {
    const code = codeOnly(panelSource);
    // The summary card's own back-link is the first "Change template" in the
    // file; the second belongs to the locked goal, further down the grid.
    const header = code.indexOf("Change template");
    const picker = code.indexOf("<ThemePicker");
    const strip = code.indexOf("<FlowPhoneCanvas");
    const firstDetailField = code.indexOf('id="ca-name"');
    for (const [what, at] of Object.entries({ header, picker, strip, firstDetailField })) {
      expect(at, `${what} not found in the panel`).toBeGreaterThan(-1);
    }
    // Inside the card: after the name/description row, before the strip.
    expect(picker).toBeGreaterThan(header);
    expect(picker).toBeLessThan(strip);
    // ...and therefore out of the details form entirely.
    expect(picker).toBeLessThan(firstDetailField);
    // Moved, not copied: one mount, and its wiring came with it intact.
    //
    // The picker gained ONE prop when custom themes landed (0081) — the practice's
    // own schemes, for the "Your themes" group after the presets. Asserted field by
    // field rather than as one string, because the string form made a control that
    // is deliberately extensible look frozen, and the two facts that actually
    // matter here are unchanged: it reads the form's theme, and picking one writes
    // straight back to the same field.
    expect(code.split("<ThemePicker").length - 1).toBe(1);
    const mount = code.slice(picker, code.indexOf("/>", picker));
    expect(mount).toContain("value={form.theme}");
    expect(mount).toContain('onChange={(key) => set("theme", key)}');
    expect(mount).toContain("customThemes={customThemes}");
    // The label and the helper line travelled too - a picker with neither is a
    // row of unexplained swatches.
    const card = code.slice(header, strip);
    expect(card).toContain("Colour scheme");
    expect(card).toContain("Colour only");
  });

  // MUTATION: skip the check and an arbitrary string is stored, then spread into
  // a style attribute on a public, paid ad destination.
  it("rejects a key the catalogue does not know, the way a bad goal is rejected", () => {
    const code = codeOnly(createRouteSource);
    expect(code).toContain("isPaletteKey(theme)");
    expect(code).toContain("PALETTE_KEYS.join(");
    expect(code).toContain("theme: theme ?? null,");
    // ...and the rule itself, called for real: the route's guard is only as good
    // as this.
    for (const key of PALETTE_KEYS) expect(isPaletteKey(key)).toBe(true);
    expect(isPaletteKey("' or 1=1")).toBe(false);
    expect(isPaletteKey("url(javascript:alert(1))")).toBe(false);
  });

  it("lets an existing assessment be re-coloured, without restating its status", () => {
    const code = codeOnly(patchRouteSource);
    expect(code).toContain("setCampaignTheme(");
    expect(code).toContain("isPaletteKey(theme)");
    // Presence, not truthiness: an absent status must mean "leave it running",
    // and theme: null must be distinguishable from theme unmentioned.
    //
    // READ THROUGH THE ROUTE'S OWN HELPER since 0082 gave it five fields to ask
    // about rather than two. Both halves are still pinned — the helper IS a
    // hasOwnProperty call (not a truthiness check wearing the name), and status
    // and theme are both asked through it — so the claim is the same one, and a
    // helper that quietly became `body.status !== undefined` still fails here.
    expect(code).toContain(
      "const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);",
    );
    expect(code).toContain('const hasStatus = has("status");');
    expect(code).toContain('const hasTheme = has("theme");');
    expect(code).toContain("if (hasStatus) await setCampaignStatus(");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The row, and the migration that has not been applied yet.
 * ------------------------------------------------------------------------- */

describe("the row survives 0079 not being applied", () => {
  it("is written and not applied, and says so", () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toContain("add column if not exists theme text");
    expect(sql).toContain("WRITTEN BUT NOT APPLIED");
    // No default: an existing row must land on null, which is the default look.
    expect(sql).not.toMatch(/theme text[^\n]*default/i);
  });

  // MUTATION: mark theme required on CampaignRow and the first read off today's
  // un-migrated table hands the runtime `theme: undefined`.
  it("defaults theme on a row that predates the column", () => {
    expect(repoSource).toContain("theme?: string | null;");
    expect(repoSource).toContain(
      'theme: typeof r.theme === "string" && r.theme.trim() !== "" ? r.theme : null,',
    );
  });

  // MUTATION: drop the retry and shipping this code before someone runs 0079
  // takes DOWN every create - a colour picker breaking the practice's front door.
  it("retries the insert without the column rather than failing the create", () => {
    const code = codeOnly(repoSource);
    expect(code).toContain("isMissingColumn(error, THEME_COLUMNS)");
    expect(code).toContain("({ data, error } = await create(base));");
    const insertAt = code.indexOf("export async function insertCampaign");
    const retryAt = code.indexOf("isMissingColumn(error, THEME_COLUMNS)", insertAt);
    const slugAt = code.indexOf('error.code === "23505"', insertAt);
    // The retry happens BEFORE the duplicate-slug branch, so a 409 still 409s.
    expect(retryAt).toBeGreaterThan(insertAt);
    expect(slugAt).toBeGreaterThan(retryAt);
  });

  // MUTATION: swallow it here too and the owner clicks a swatch that never takes,
  // with nothing anywhere telling them why.
  it("reports the missing column on the re-theme path instead of swallowing it", () => {
    expect(repoSource).toContain("class ThemeColumnMissingError");
    expect(repoSource).toContain("0079_assessment_theme.sql");
    expect(codeOnly(patchRouteSource)).toContain("e instanceof ThemeColumnMissingError");
    expect(codeOnly(patchRouteSource)).toContain("503");
  });

  // MUTATION: widen the message-text fallback back to a bare "does not exist" and
  // a genuinely broken query starts looking like an un-applied migration.
  it("keeps the two migrations' column lists apart", () => {
    expect(repoSource).toContain('const FLOW_COLUMNS = ["flow", "flow_version", "flow_published"];');
    expect(repoSource).toContain('const THEME_COLUMNS = ["theme"];');
    expect(repoSource).toContain("isMissingColumn(readError, FLOW_COLUMNS)");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The render: where the wrapper is, and how far it reaches.
 * ------------------------------------------------------------------------- */

describe("the public page wears the scheme", () => {
  // MUTATION: set the vars on the quiz root instead. The quiz roots are
  // `max-w-lg mx-auto`, so a themed card would float on the OLD page colour -
  // the one bug in this feature that looks deliberate.
  it("wraps the quiz in a full-height element that paints its own background", () => {
    const code = codeOnly(pageSource);
    expect(code).toContain("paletteVars(pub.theme)");
    expect(code).toContain('className="min-h-screen w-full bg-cream"');
    const wrapperAt = code.indexOf("paletteVars(pub.theme)");
    const quizAt = code.indexOf("<AssessmentQuiz");
    expect(wrapperAt).toBeGreaterThan(-1);
    expect(quizAt).toBeGreaterThan(wrapperAt); // the quiz is INSIDE the wrapper
  });

  // MUTATION: the whole feature rests on this. If a null theme ever produced
  // different vars from "default", applying 0079 would re-colour live campaigns
  // that nobody touched.
  it("renders an unthemed campaign with the shipped values", () => {
    expect(paletteVars(toPublicCampaign(campaign(null)).theme)).toEqual(paletteVars("default"));
  });

  it("changes what it emits for a campaign that chose one", () => {
    const themed = paletteVars(toPublicCampaign(campaign("clinical-teal")).theme);
    expect(themed).not.toEqual(paletteVars(null));
    expect(themed["--assess-glow"]).toBeTruthy();
  });

  // MUTATION: theming is COLOUR ONLY. A palette that could reach copy would be a
  // way around flow-copy.ts's write-time scan and the NHS/private ban.
  it("emits nothing but custom properties", () => {
    for (const key of [null, ...PALETTE_KEYS]) {
      for (const [name, value] of Object.entries(paletteVars(key))) {
        expect(name.startsWith("--"), `${name} is not a custom property`).toBe(true);
        expect(value).not.toMatch(/[<>;{}]/); // nothing that could close out of the declaration
      }
    }
  });
});
