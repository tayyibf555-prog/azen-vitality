import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CLIENT_NAV, canRoleAccessModule, indexRedirectFor } from "@/lib/nav";
import type { Role } from "@/lib/types";

// ===========================================================================
// THE MODULE LOCK IS PER PAGE, SO IT HAS TO BE PROVEN PER PAGE.
//
// Three separate things are often mistaken for the role lock on this route, and
// none of them is it:
//
//   1. the sidebar (`navForRole` / `categoriesForRole`) only decides which LINKS
//      are drawn — it stops nobody typing /c/vitality/payments;
//   2. `layout.tsx`'s `guardPage` only decides who may enter the /c shell at all,
//      and it admits all four roles, clinician included;
//   3. `canRoleAccessModule` is a pure predicate that does nothing until somebody
//      calls it.
//
// The lock is `await requireModuleAccess("<slug>")` inside the module's own page,
// which is the one thing that turns (3) into a 404 for a role that may not have
// the module. It is also the easiest line in the codebase to forget: a new page
// renders perfectly without it, and 24 of the 39 pages under this route had in
// fact shipped without it, leaving every module reachable by direct URL to any
// role the layout let in — which is the whole of the deny-by-default
// `client_clinician` allow-list (CLINICIAN_SLUGS) bypassed.
//
// So this test derives the page list from the FILESYSTEM crossed with CLIENT_NAV
// rather than from a list anybody has to maintain. A module added tomorrow is
// covered the moment its directory exists; it cannot ship unguarded, and it
// cannot be quietly excluded from the check either (see NON_MODULE_ROUTES).
// ===========================================================================

const ROUTE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Directories here that hold a page.tsx but are NOT modules, listed explicitly so
 * that "this one is fine" is a decision on the record rather than a silent gap.
 * Both are REDIRECT-ONLY stubs kept alive for old bookmarks; the test below proves
 * they stay that way, so neither can quietly grow into an unguarded module page.
 */
const NON_MODULE_ROUTES: Record<string, string> = {
  // Folded into the Overview ("One Front Door"); redirects to /c/[client].
  today: "redirect-only stub: the Today module was folded into the Overview",
  // The practice dashboard IS the Overview now; redirects to /c/[client].
  dashboard: "redirect-only stub: the dashboard became the Overview",
};

/**
 * Every role the platform has. Typed so adding another Role fails tsc HERE first —
 * which is exactly what happened when `client_staff` was added: this line was the
 * first compile error of that change, before a single page had been written, which
 * is the whole reason the exhaustiveness map exists rather than a bare array.
 */
const ALL_ROLES = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
] as const;
const _EXHAUSTIVE: Record<Role, true> = {
  agency_admin: true,
  client_owner: true,
  client_coordinator: true,
  client_clinician: true,
  client_staff: true,
};
void _EXHAUSTIVE;

/** Slugs CLIENT_NAV knows about, minus "" (the index — see its own test below). */
const NAV_SLUGS = new Set(
  CLIENT_NAV.flatMap((g) => g.items)
    .map((i) => i.slug)
    .filter((s) => s !== ""),
);

/** Every directory directly under /c/[client] that renders a page. */
const PAGE_DIRS = readdirSync(ROUTE_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => existsSync(join(ROUTE_DIR, name, "page.tsx")))
  .sort();

/** The ones that are modules, i.e. that a role can be allowed or denied. */
const MODULE_DIRS = PAGE_DIRS.filter((name) => NAV_SLUGS.has(name));

function pageSource(...segments: string[]): string {
  return readFileSync(join(ROUTE_DIR, ...segments), "utf8");
}

describe("every client module page enforces its own module access", () => {
  it.each(MODULE_DIRS)('/c/[client]/%s calls requireModuleAccess for its own slug', (slug) => {
    const src = pageSource(slug, "page.tsx");
    // The exact slug, not merely "some call": a page that guards a NEIGHBOUR's slug
    // is worse than one that guards nothing, because it reads as protected.
    expect(src).toContain(`requireModuleAccess("${slug}")`);
    // And it must be awaited — a floating promise resolves after the page has
    // already rendered, so notFound() would arrive too late to stop anything.
    expect(src).toContain(`await requireModuleAccess("${slug}")`);
  });

  it("checks every module that has a page, and covers every module in the nav", () => {
    // Sanity on the derivation itself: if a bad glob ever left MODULE_DIRS empty or
    // short, every it.each above would pass vacuously and prove nothing.
    expect(MODULE_DIRS.length).toBeGreaterThanOrEqual(34);
    // Every nav module owns a directory here, so a module cannot dodge the check by
    // never getting one. (If a future module deliberately has no /c page, it belongs
    // in NON_MODULE_ROUTES-style documentation, not in silence.)
    expect([...NAV_SLUGS].filter((s) => !MODULE_DIRS.includes(s))).toEqual([]);
  });

  it("every page directory is either a guarded module or a documented non-module", () => {
    const undocumented = PAGE_DIRS.filter(
      (name) => !NAV_SLUGS.has(name) && !(name in NON_MODULE_ROUTES),
    );
    expect(undocumented).toEqual([]);
  });

  it("the documented non-module routes are still redirect-only stubs", () => {
    for (const name of Object.keys(NON_MODULE_ROUTES)) {
      const src = pageSource(name, "page.tsx");
      // A redirect leaks nothing, which is the entire reason these two are exempt.
      // The moment one renders a view instead, that reasoning is void and this fails.
      expect(src).toContain("redirect(");
      expect(src).not.toMatch(/return\s+</);
    }
  });
});

describe("the routes that are deliberately NOT guarded per page", () => {
  it("the Overview index is REACHABLE by every role, and RENDERED for only four", () => {
    // THIS TEST USED TO SAY SOMETHING ELSE, AND WHAT IT SAID WAS WRONG.
    //
    // It read "the Overview index needs no guard because every role may reach it"
    // and looped ALL_ROLES asserting `canRoleAccessModule(role, "") === true`. Once
    // `client_staff` existed that sentence certified the exposure instead of
    // catching it: the index IS the practice dashboard — takings, outstanding
    // accounts, invoiced totals, UDA and the day's appointment list with patient
    // names — and the one role defined as having neither the money nor the diary
    // was landing on all of it, with this file calling it intended.
    //
    // Both halves are still true and they are now stated separately, because they
    // are different claims:
    //   REACHABLE  — "" stays in every role's allow-list, including STAFF_SLUGS,
    //                or "/" would bounce a staff login back and forth for ever.
    //   RENDERED   — the PAGE forwards `client_staff` to /c/<client>/my-work before
    //                it reads anything, which is `indexRedirectFor` + the call to
    //                `requireIndexAccess` asserted below.
    for (const role of ALL_ROLES) expect(canRoleAccessModule(role, "")).toBe(true);
    expect(existsSync(join(ROUTE_DIR, "page.tsx"))).toBe(true);

    // Exactly one role is forwarded, and it is the one that must be. A future role
    // added to STAFF_SLUGS-style deny-by-default has to make this decision here.
    const forwarded = ALL_ROLES.filter((role) => indexRedirectFor(role, "vitality") !== null);
    expect(forwarded).toEqual(["client_staff"]);
    expect(indexRedirectFor("client_staff", "vitality")).toBe("/c/vitality/my-work");
  });

  it("the index page really calls the forwarding guard, and BEFORE it reads anything", () => {
    // The predicate is inert until somebody calls it — the same lesson as
    // `requireModuleAccess`, and the reason 24 pages once shipped unguarded. The
    // ORDER is asserted as well as the presence: a forward that ran after
    // `readPracticeDashboard` would still have fetched the practice's takings for a
    // login that may not see them, and a redirect is not an excuse for a read.
    const src = pageSource("page.tsx");
    expect(src).toContain("await requireIndexAccess(clientSlug)");
    expect(src.indexOf("await requireIndexAccess(clientSlug)")).toBeLessThan(
      src.indexOf("readPracticeDashboard("),
    );
  });

  it("the patient record's nested pages are guarded by their shared layout", () => {
    // patients/[id]/page.tsx and patients/[id]/[tab]/page.tsx do NOT inherit the
    // guard on patients/page.tsx — that is a sibling route, not a parent — so the
    // guard sits on the layout they share, and is asserted here because the
    // filesystem sweep above only walks one level.
    expect(pageSource("patients", "[id]", "layout.tsx")).toContain(
      'await requireModuleAccess("patients")',
    );
  });
});

describe("the guard and the predicate are the pair that locks a module", () => {
  it("denies the clinician Payments in the predicate AND calls it on the page", () => {
    // Neither half is a lock on its own. This is the concrete case that was open:
    // a clinician could open /c/vitality/payments by URL because the page never
    // asked the predicate that has always said no.
    expect(canRoleAccessModule("client_clinician", "payments")).toBe(false);
    expect(pageSource("payments", "page.tsx")).toContain('await requireModuleAccess("payments")');
  });

  it("denies the coordinator an owner-only module the same way", () => {
    expect(canRoleAccessModule("client_coordinator", "settings")).toBe(false);
    expect(pageSource("settings", "page.tsx")).toContain('await requireModuleAccess("settings")');
  });
});
