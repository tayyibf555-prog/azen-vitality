// THE CUSTOM-THEME CHAIN: migration -> repository -> routes -> public page.
//
// WHAT THIS SUITE IS AND IS NOT. The RULES — the colour grammar, the AA gate, what
// a reference is — are pure and are tested against themselves in custom-theme.test
// .ts and contrast.test.ts, called for real. What is left over, and what a refactor
// breaks in silence, is the WIRING: a route that stops asking the validator, a
// repository query that forgets its client_id, a public page that resolves a theme
// and then renders it from unchecked values.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts.
// Every link here is a server component, an API route or a service-role repository
// — none of them callable in this environment (they reach for a Supabase
// service-role client and requireUser). So each is held by reading its source, the
// same split campaign-theme.test.ts uses for 0079's chain.
//
// THE FOUR CLAIMS:
//   1. the migration is written, not applied, and changes nothing that is live;
//   2. every query is scoped to one practice — the tenancy boundary IS the
//      .eq("client_id"), because the service-role client bypasses RLS;
//   3. both write routes carry four guards, in order, and both put every colour
//      through the same gate;
//   4. the public page can never be taken down, or injected into, by a row.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = "supabase/migrations/0081_assessment_custom_theme.sql";
const REPO_PATH = "src/lib/assess/custom-theme-repository.ts";
const LIST_ROUTE_PATH = "src/app/api/smile-assessment/theme/route.ts";
const ITEM_ROUTE_PATH = "src/app/api/smile-assessment/theme/[id]/route.ts";
const CREATE_ROUTE_PATH = "src/app/api/smile-assessment/campaign/route.ts";
const PATCH_ROUTE_PATH = "src/app/api/smile-assessment/campaign/[slug]/route.ts";
const PAGE_PATH = "src/app/assess/[client]/[slug]/page.tsx";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/** Source with comments stripped: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const migration = read(MIGRATION_PATH);
const repo = codeOnly(read(REPO_PATH));
const listRoute = codeOnly(read(LIST_ROUTE_PATH));
const itemRoute = codeOnly(read(ITEM_ROUTE_PATH));
const createRoute = codeOnly(read(CREATE_ROUTE_PATH));
const patchRoute = codeOnly(read(PATCH_ROUTE_PATH));
const page = codeOnly(read(PAGE_PATH));

/* ---------------------------------------------------------------------------
 * 1. The migration.
 * ------------------------------------------------------------------------- */

describe("0081 is written, not applied, and is inert either way", () => {
  it("creates the table with the house posture", () => {
    expect(migration).toContain("create table if not exists client_theme");
    expect(migration).toContain("alter table client_theme enable row level security");
    // POST-0012: no anon/authenticated grants at all. Everything goes through the
    // service-role client, so RLS alone would be a lock with the key left in it.
    expect(migration).toContain("revoke all on client_theme from anon, authenticated");
    // The picker shows names alone, so two identical entries would be a control
    // an owner cannot use.
    expect(migration).toContain("unique (client_id, name)");
  });

  // MUTATION: seed a theme "so the feature shows something" and every practice on
  // the platform silently gains a colour scheme nobody at that practice authored.
  it("seeds nothing and changes no existing row", () => {
    expect(migration).toContain("WRITTEN BUT NOT APPLIED");
    expect(migration.toLowerCase()).not.toContain("insert into client_theme");
    expect(migration.toLowerCase()).not.toContain("update smile_assessment_campaign");
  });

  it("says why the campaign's reference is not a foreign key", () => {
    // One column holding either a preset key or a row reference cannot be an FK,
    // so the link is soft and the delete guard is what keeps it honest. If that
    // reasoning ever leaves the file, the next reader will "fix" the schema.
    expect(migration).toContain("SOFT");
  });
});

/* ---------------------------------------------------------------------------
 * 2. Tenancy. The service-role client bypasses RLS, so this IS the boundary.
 * ------------------------------------------------------------------------- */

describe("every query names the practice", () => {
  // MUTATION: drop one .eq("client_id", …) and a theme id alone reaches another
  // practice's row — read, renamed, re-coloured or deleted. There is no RLS
  // underneath to catch it: the service-role client is above it by design.
  it("scopes every read and every write by client_id", () => {
    const queries = repo.split(".from(").slice(1);
    expect(queries.length).toBeGreaterThanOrEqual(6);
    for (const query of queries) {
      // Up to the end of that statement.
      const statement = query.slice(0, query.indexOf(";"));
      // A read, update or delete is narrowed by client_id. The one INSERT is
      // scoped the other way round — it WRITES the client_id, taken from the
      // server-resolved practice and never from the body — which is the same
      // boundary stated as a fact rather than as a filter.
      const scoped = statement.includes('.eq("client_id"')
        ? true
        : statement.includes(".insert(") && statement.includes("client_id: input.clientId");
      expect(scoped, `a query in ${REPO_PATH} is not client-scoped: ${statement.slice(0, 80)}`).toBe(
        true,
      );
    }
  });

  it("is server-only, so none of it can be imported into a browser bundle", () => {
    expect(read(REPO_PATH).startsWith('import "server-only";')).toBe(true);
  });

  // MUTATION: assert the row into a theme with a `!` and an unvalidated blob
  // becomes a CSS custom property. rowToTheme is the ONE place rows become themes,
  // which is what makes the read-back check unavoidable rather than remembered.
  it("re-checks the grammar at the single place a row becomes a theme", () => {
    expect(repo).toContain("readbackVars(row.vars)");
    expect(repo).toContain("function rowToTheme");
    // Both readers go through it; neither builds a theme by hand.
    expect(repo).toContain("(data as ThemeRow[]).map(rowToTheme)");
    expect(repo).toContain("rowToTheme(data as ThemeRow)");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The routes.
 * ------------------------------------------------------------------------- */

describe("both theme routes carry four guards, in order", () => {
  // MUTATION: the API-layer lesson, restated for a new pair of routes. The page
  // guard never runs on an API route, so requireUser + requireClientAccess alone
  // would admit every role attached to the practice — a nurse could re-colour a
  // live ad destination. And the module gate alone would admit the coordinator's
  // whole tier; a colour scheme is an owner/manager decision.
  it.each([
    [LIST_ROUTE_PATH, listRoute],
    [ITEM_ROUTE_PATH, itemRoute],
  ])("%s runs requireUser -> client -> module -> approver", (path, src) => {
    const user = src.indexOf("await requireUser()");
    const client = src.indexOf("requireClientAccess(auth");
    const moduleGate = src.indexOf('requireModuleApiAccess(auth, "smile-assessment")');
    const approver = src.indexOf("requireApproverRole(auth)");
    for (const [what, at] of Object.entries({ user, client, moduleGate, approver })) {
      expect(at, `${path} never calls the ${what} guard`).toBeGreaterThan(-1);
    }
    expect(user).toBeLessThan(client);
    expect(client).toBeLessThan(moduleGate);
    expect(moduleGate).toBeLessThan(approver);
    // Each one is RETURNED, not merely evaluated: a guard whose Response is
    // dropped compiles, reads as a lock and does nothing.
    expect(src).toContain("if (denied) return denied;");
    expect(src).toContain("if (moduleDenied) return moduleDenied;");
    expect(src).toContain("if (roleDenied) return roleDenied;");
  });

  // MUTATION: add a method that resolves the client itself and the four guards
  // become three. Every exported handler must enter through the one door.
  it.each([
    [LIST_ROUTE_PATH, listRoute],
    [ITEM_ROUTE_PATH, itemRoute],
  ])("%s puts every method through the same authorise()", (path, src) => {
    const methods = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)\(/g)].map((m) => m[1]);
    expect(methods.length, `${path} exports no handlers`).toBeGreaterThan(0);
    for (const method of methods) {
      const start = src.indexOf(`export async function ${method}(`);
      const next = src.indexOf("\nexport ", start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      expect(body, `${path} ${method} does not authorise`).toContain("authorise(");
      expect(body, `${path} ${method} does not return the guard's Response`).toContain(
        "if (access instanceof Response) return access;",
      );
    }
  });

  it("covers the four methods the feature needs and nothing else", () => {
    expect([...listRoute.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]).sort()).toEqual([
      "GET",
      "POST",
    ]);
    expect([...itemRoute.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]).sort()).toEqual([
      "DELETE",
      "PATCH",
    ]);
  });
});

describe("every colour goes through the gate, on the way in", () => {
  // MUTATION: validate on create and not on edit, and the AA bar becomes
  // advisory: build a scheme that passes, then edit it until it does not.
  it("validates on POST and on PATCH alike, and answers 422 with the failures", () => {
    for (const [path, src] of [
      [LIST_ROUTE_PATH, listRoute],
      [ITEM_ROUTE_PATH, itemRoute],
    ] as const) {
      expect(src, `${path} does not validate`).toContain("validateThemeVars(body.vars)");
      expect(src, `${path} does not report the failures`).toContain(
        "describeThemeFailures(checked.failures)",
      );
      expect(src, `${path} does not answer 422`).toContain("422");
      // The validated map is what is stored — never `body.vars`.
      expect(src).toContain("checked.vars");
      expect(src).not.toContain("vars: body.vars");
    }
  });

  it("normalises the name rather than storing whatever arrived", () => {
    for (const src of [listRoute, itemRoute]) expect(src).toContain("normaliseThemeName(body.name)");
  });

  // MUTATION: swallow the missing table and an owner clicks Save on a deployment
  // without 0081 and is told nothing at all. Here the theme IS the request.
  it("names the un-applied migration on the write paths, and only there", () => {
    for (const src of [listRoute, itemRoute]) {
      expect(src).toContain("e instanceof CustomThemeTableMissingError");
      expect(src).toContain("503");
    }
    // ...while the LIST answers an honest empty list, because a practice with no
    // themes and a deployment with no table look the same on that screen.
    expect(listRoute).toContain("themes: [], migrationPending: true");
  });
});

describe("deleting a theme that is in use is refused, with the pages named", () => {
  // MUTATION: let the delete through. The public page WOULD cope — it falls back
  // to the shipped default — and that is exactly the problem: one click in a
  // settings-shaped list silently re-colours every live ad destination wearing
  // that scheme, with nothing having said so and no way back.
  it("checks first, and answers 409", () => {
    expect(itemRoute).toContain("campaignsUsingTheme(access.clientId, id)");
    expect(itemRoute).toContain("throw new ThemeInUseError(inUse)");
    expect(itemRoute).toContain("e instanceof ThemeInUseError");
    expect(itemRoute).toContain("409");
    // BEFORE the delete, not after it.
    expect(itemRoute.indexOf("campaignsUsingTheme")).toBeLessThan(
      itemRoute.indexOf("deleteCustomTheme("),
    );
  });

  it("names them, because 'it is in use' is not an actionable sentence", () => {
    expect(repo).toContain("class ThemeInUseError");
    // The error carries the names, so the owner knows which cards to visit.
    expect(repo).toContain("campaignNames.join");
    expect(repo).toContain("campaignNames.length");
  });

  // An un-applied 0079 means no campaign can be wearing anything, so a missing
  // `theme` column must answer "none" rather than failing every delete.
  it("does not block the delete on a database where 0079 has not been applied", () => {
    expect(repo).toContain('error.code === "42703" || error.code === "PGRST204"');
  });
});

/* ---------------------------------------------------------------------------
 * 4. The campaign's own theme field, which now has two namespaces.
 * ------------------------------------------------------------------------- */

describe("a campaign may wear a preset or one of the practice's own, and nothing else", () => {
  // MUTATION: check only the catalogue and a custom scheme can never be chosen;
  // check only ownership and a preset key stops working. Both routes must ask
  // both questions, and in that order, so a preset costs no database read.
  it.each([
    ["create", CREATE_ROUTE_PATH, createRoute],
    ["re-colour", PATCH_ROUTE_PATH, patchRoute],
  ])("the %s route asks the catalogue first, then ownership", (_label, path, src) => {
    expect(src, `${path} stopped asking the catalogue`).toContain("isPaletteKey(theme)");
    expect(src, `${path} does not check ownership`).toContain("ownsCustomTheme(client.id, theme)");
    expect(src.indexOf("isPaletteKey(theme)")).toBeLessThan(src.indexOf("ownsCustomTheme("));
  });

  // MUTATION: `custom:` + a uuid is 43 characters. The old 40-character cap
  // truncated every custom reference into an unknown one — a create that silently
  // dropped the owner's scheme and returned 200.
  it("does not truncate a custom reference on the way in", () => {
    expect(createRoute).toContain("str(body.theme, 48)");
  });

  // MUTATION: ownership IS the tenancy check here. Scoped by client_id inside the
  // repository, so another practice's theme id is not "a theme you may not use",
  // it is simply not one of yours.
  it("resolves ownership through the client-scoped repository, not from the body", () => {
    expect(repo).toContain("export async function ownsCustomTheme");
    expect(repo).toContain("parseCustomThemeRef(storedTheme)");
    expect(repo).toContain("await getCustomTheme(clientId, id)");
  });
});

/* ---------------------------------------------------------------------------
 * 5. The public page.
 * ------------------------------------------------------------------------- */

describe("the public page cannot be taken down, or injected into, by a row", () => {
  // MUTATION: resolve the theme with a throwing read and a transient database
  // blip 500s a paid ad destination over a colour.
  it("resolves through the never-throwing reader, and falls back to the catalogue", () => {
    expect(page).toContain("resolveCustomTheme(clientRecord.id, pub.theme)");
    expect(page).toContain("custom ? paletteVarsFrom(custom.vars) : paletteVars(pub.theme)");
    expect(repo).toContain("export async function resolveCustomTheme");
    // THE READ IS INSIDE THE try, not merely near one. A body that keeps a
    // try/catch for decoration while awaiting the throwing read outside it reads
    // as protected and is not — which is exactly what a text search for "try {"
    // would accept.
    const start = repo.indexOf("export async function resolveCustomTheme");
    const body = repo.slice(start, repo.indexOf("\n}", start));
    const tryAt = body.indexOf("try {");
    const readAt = body.indexOf("getCustomTheme(");
    const catchAt = body.indexOf("} catch");
    expect(tryAt, "no try block").toBeGreaterThan(-1);
    expect(readAt, "no read").toBeGreaterThan(-1);
    expect(catchAt, "no catch").toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(catchAt);
    // ...and the catch resolves to nothing rather than re-throwing.
    expect(body.slice(catchAt)).toContain("return null;");
    expect(body.slice(catchAt)).not.toContain("throw");
  });

  // MUTATION: query on every render. The prefix exists so a preset campaign — the
  // overwhelming majority — pays nothing on a force-dynamic public page.
  it("does not query at all unless the stored value names a custom theme", () => {
    const start = repo.indexOf("export async function resolveCustomTheme");
    const body = repo.slice(start, repo.indexOf("\n}", start));
    expect(body).toContain("parseCustomThemeRef(storedTheme)");
    expect(body).toContain("if (!id) return null;");
    expect(body.indexOf("if (!id) return null;")).toBeLessThan(body.indexOf("getCustomTheme("));
  });

  // MUTATION: emit the row's own keys instead of the closed list and a row
  // carrying an extra key puts an unrecognised custom property into a public
  // page's style attribute — whatever the validator did or did not catch.
  it("emits the closed token list, never the row's keys", () => {
    const palette = codeOnly(read("src/lib/assess/palette.ts"));
    expect(palette).toContain("export function paletteVarsFrom");
    const start = palette.indexOf("export function paletteVarsFrom");
    const body = palette.slice(start, palette.indexOf("\n}", start));
    expect(body).toContain("for (const token of PALETTE_TOKENS)");
    expect(body).not.toContain("Object.keys(vars)");
  });

  // The wrapper is still the wrapper: the quiz sits inside it and it paints the
  // gutters, which is the property campaign-theme.test.ts holds for presets.
  it("keeps the resolved vars on the full-height wrapper", () => {
    expect(page).toContain('<div className="min-h-screen w-full bg-cream" style={themeVars as CSSProperties}>');
    expect(page.indexOf("const themeVars")).toBeLessThan(page.indexOf("<AssessmentQuiz"));
  });
});
