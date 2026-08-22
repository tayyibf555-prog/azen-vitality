import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { srcPath } from "@/lib/test-support/walk-src";

import { buildDashboardView, type BuildViewInput } from "./view";

// ---------------------------------------------------------------------------
// F3 — A GROUP-LEVEL FIELD THAT EVERY READER HAD TO REMEMBER TO NARROW.
//
// `takingsFailedSites` was assembled once for the whole group and hung on the view.
// Exactly one consumer narrowed it to the scope it was rendering — practice-dashboard,
// in a useMemo — so the bug was fixed at the one place it had been noticed and left
// live in the type for everyone else. The next reader of this disclosure (the
// co-pilot's narration, the owner overview) would have started from the same unscoped
// list and told a manager of one practice that HER blank was caused by a practice she
// is not looking at.
//
// So the narrowing moved into buildDashboardView, onto the scope structure, and the
// unscoped list is no longer reachable on PracticeDashboardView at all. A fix that
// removes the wrong thing from the types is a fix the next consumer inherits.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-22T09:42:00Z");
const A = { id: "site-cc", name: "N15 Vitality Dental" };
const B = { id: "site-rv", name: "N17 Dental" };
const C = { id: "site-ng", name: "Romford Road" };

function view(failed: readonly string[]) {
  const input: BuildViewInput = {
    now: NOW,
    sites: [A, B, C],
    practitioners: [],
    payments: [],
    paymentsCoverage: null,
    takingsWindowTotals: new Map(),
    takingsFailedSites: [...failed],
    appointments: null,
    appointmentsCoverage: null,
    appointmentRows: [],
    patients: null,
    plans: null,
    invoices: null,
    balances: null,
    claims: null,
  };
  return buildDashboardView(input);
}

const scopeOf = (v: ReturnType<typeof view>, siteId: string | null) =>
  v.scopes.find((s) => s.siteId === siteId)!;

describe("F3: each scope names only the failures it can see", () => {
  it("gives a single-practice scope its OWN failure and nobody else's", () => {
    const v = view([A.id, B.id]);

    expect(scopeOf(v, A.id).takingsFailedSites).toEqual([A.id]);
    expect(scopeOf(v, B.id).takingsFailedSites).toEqual([B.id]);
  });

  it("gives a scope whose own practice answered an empty list, not a borrowed explanation", () => {
    const v = view([B.id]);
    expect(scopeOf(v, A.id).takingsFailedSites).toEqual([]);
    expect(scopeOf(v, C.id).takingsFailedSites).toEqual([]);
  });

  it("CONTROL: the all-sites scope still carries every failure, in the sites' own order", () => {
    const v = view([C.id, A.id]);
    // It covers every practice, so narrowing to what it can see narrows nothing.
    expect(scopeOf(v, null).takingsFailedSites).toEqual([C.id, A.id]);
  });

  it("is empty on every scope of a healthy assembly", () => {
    const v = view([]);
    for (const scope of v.scopes) expect(scope.takingsFailedSites).toEqual([]);
  });

  it("drops a failed id that is not one of this client's sites rather than naming it", () => {
    const v = view(["site-belonging-to-nobody"]);
    for (const scope of v.scopes) expect(scope.takingsFailedSites).toEqual([]);
  });
});

describe("F3: the unscoped list is not reachable on the view", () => {
  it("PracticeDashboardView carries no group-level takingsFailedSites", () => {
    const v = view([A.id]);
    expect(
      Object.prototype.hasOwnProperty.call(v, "takingsFailedSites"),
      "the unscoped list is back on the view; the next consumer will forget to narrow it",
    ).toBe(false);
  });

  it("and the type does not declare one either", () => {
    // The runtime check above cannot see a field that is declared but happens to be
    // undefined on this fixture. The declaration is what the next consumer reads.
    const source = readFileSync(srcPath("lib/dashboard/view.ts"), "utf8");
    const viewBlock = source.slice(
      source.indexOf("export interface PracticeDashboardView"),
      source.indexOf("export interface BuildViewInput"),
    );
    expect(viewBlock.length).toBeGreaterThan(0);
    expect(
      /^\s*takingsFailedSites\s*[?:]/m.test(viewBlock),
      "PracticeDashboardView declares an unscoped takingsFailedSites again",
    ).toBe(false);
    // ScopeView is where it belongs, and it is not optional there.
    const scopeBlock = source.slice(
      source.indexOf("export interface ScopeView"),
      source.indexOf("// --- The appointment list"),
    );
    expect(/^\s*takingsFailedSites: string\[\];/m.test(scopeBlock)).toBe(true);
  });
});
