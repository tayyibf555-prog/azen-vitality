import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ALL_ROLES, defaultHoldersOf } from "@/lib/capabilities/defaults";
import { CLINICIAN_SLUGS, STAFF_SLUGS, canRoleAccessModule } from "@/lib/nav";
import { copilotAccessForRole } from "@/lib/copilot/scope";

// ===========================================================================
// THIS ROUTE'S COMMENTS DESCRIBE THE LOCKS THIS ROUTE ACTUALLY HAS (§0/1, W3/17).
//
// WHY THIS FILE EXISTS. In this codebase a comment IS the calibration contract —
// the charter's first standard is that a lane reads the module's comments before
// writing, because they are where the live decisions are recorded. So a comment
// that describes a lock which no longer exists is not untidiness: it is a false
// entry in the contract, and the next reader either trusts it (and records an
// unproven property as proven) or deletes the thing that replaced it.
//
// IT WAS WRONG HERE. Until this fix the file contradicted itself inside twelve
// lines. One block said "co-pilot" was in neither CLINICIAN_SLUGS nor
// STAFF_SLUGS, so `requireModuleApiAccess` refused the clinician and the staff
// member before a turn started, and that COPILOT_ACCESS refused them again; the
// block immediately below it said — correctly — that ruling W1-E/2 had put the
// slug in both allow-lists and that the boundary had MOVED to ACCESS_BY_ROLE.
// The false half read first. A third line called module access "already
// owner-only", which is what the per-person capability was said to be narrowing.
//
// SO THE TRUTH IS ASSERTED FIRST, FROM THE REAL PREDICATES, and only then is the
// prose checked against it. That ordering is the point: if the co-pilot is ever
// narrowed again, the first half of each test fails and somebody has to come and
// rewrite these comments deliberately, rather than the pin quietly turning into a
// grep for a sentence nobody says any more.
//
// Comments only — no behaviour changes here. `turn-wiring.test.ts` drives the
// handler; `src/lib/copilot/route-boundary.test.ts` proves the moved boundary
// holds. This file is the third leg: that the file SAYS what those two PROVE.
// ===========================================================================

const routeSrc = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

/**
 * The route's prose as one flat string.
 *
 * The claims below are written across several `//` lines and wrap wherever the
 * line length happened to fall, so a regex over the raw source matches or misses
 * on formatting rather than on meaning. Strip the comment markers, collapse the
 * whitespace, and a claim is one searchable sentence however it was wrapped.
 */
const prose = routeSrc
  .replace(/^\s*\/\/ ?/gm, "")
  .replace(/\s+/g, " ")
  .trim();

describe("the co-pilot route's comments match its locks", () => {
  it("does not claim the module guard still refuses the clinician and the staff member", () => {
    // THE TRUTH, from the allow-lists themselves and from the predicate the API
    // guard consults — never retyped.
    expect(CLINICIAN_SLUGS.has("co-pilot"), "W1-E/2 put the slug in CLINICIAN_SLUGS").toBe(true);
    expect(STAFF_SLUGS.has("co-pilot"), "W1-E/2 put the slug in STAFF_SLUGS").toBe(true);
    for (const role of ALL_ROLES) {
      expect(canRoleAccessModule(role, "co-pilot"), `${role} is refused the module`).toBe(true);
    }
    // ...and the capability default admits all five too, so the second half of
    // the deleted claim ("COPILOT_ACCESS refuses them again") is false as well.
    expect([...defaultHoldersOf("system.copilot.ask")].sort()).toEqual([...ALL_ROLES].sort());

    // THEREFORE the file may not say the opposite. Each phrase below is one the
    // stale block actually carried.
    for (const claim of [
      "is in neither CLINICIAN_SLUGS nor STAFF_SLUGS",
      "refuses both roles before a turn starts",
      "DECLARED BUT NOT YET SWITCHED ON",
      "refuses them again",
    ]) {
      expect(prose, `the route still claims: ${claim}`).not.toContain(claim);
    }
  });

  it("does not describe module access as owner-only, which is what the capability was said to narrow", () => {
    // The per-person capability is not narrowing an owner-only module; it is the
    // named-people gate sitting ON TOP of a module every clearance reaches. The
    // clearance Record is what decides what each of them may then do.
    expect(copilotAccessForRole("client_coordinator")).toBe("manager");
    expect(copilotAccessForRole("client_clinician")).toBe("clinician");
    expect(copilotAccessForRole("client_staff")).toBe("staff");

    expect(prose).not.toContain("Module access is already owner-only");
    expect(prose).toContain("Module access now admits every known role (W1-E/2)");
    expect(prose).toContain("decides WHICH named people may ask at all");
  });

  it("does not repeat a catalog size, because sizes live where they are pinned", () => {
    // The block naming the access levels used to say the manager got "the six
    // operational read tools" and that "everyone else still gets nothing". Both
    // were true when written and neither survived W1-E/2 and W2-A. A count copied
    // into prose 400 lines from the table that produces it is a fact with no test
    // behind it, so this route states the SHAPE and defers the numbers to
    // src/lib/copilot/clearance.test.ts, which counts the real catalogs.
    for (const claim of ["six operational read tools", "everyone else still gets nothing"]) {
      expect(prose, `the route still claims: ${claim}`).not.toContain(claim);
    }
    expect(prose).toContain("The sizes are pinned there, not here");
  });
});
