import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// THE GUARD COMMENT IN os-band.tsx IS A CLAIM ABOUT ROLES, SO IT IS CHECKED.
//
// Charter §0 item 1: in this tree the comments ARE the calibration contract.
// The band's empty-guard carried one for two waves — "a clinician may reach
// none of these modules" — which ruling W2-A/1 (3 Sep 2026) falsified the same
// day it widened the equipment and IT desks to all five clearances. Two review
// rounds found it and two lanes had to hand it off, because the sentence lived
// in a third file with no pin on it while the library header
// (src/lib/home/os-band.ts) and the Overview's note (os-band-note.test.ts) both
// had one.
//
// This file closes that gap. The guard's REASONING is now the true one — no
// clearance is drawn an empty band today, and the guard stands for the module
// that narrows later — and the reasoning is derived here from the real
// `OS_TILES` and the real `canRoleAccessModule`, in both directions: a comment
// that denies a role its band is as red as a widening that empties one.
//
// No behaviour is under test here. The guard's own behaviour is pinned by
// "draws nothing at all for a role with no tiles" in src/lib/home/os-band.test.ts,
// and the last test below holds the comment's citation of it to existing.
// ===========================================================================

vi.mock("server-only", () => ({}));

// os-band.ts is a server module that pulls six repositories at import time. Only
// its tile TABLE is read here, so each is stubbed to the shape the module
// imports, and none of them runs. (Same stub set as os-band-note.test.ts.)
vi.mock("@/lib/systems/repository", () => ({ getSystemStates: async () => [] }));
vi.mock("@/lib/speed-to-lead/repository", () => ({ listLeads: async () => [] }));
vi.mock("@/lib/triage/repository", () => ({ listTargets: async () => [] }));
vi.mock("@/lib/equipment/repository", () => ({ ASSET_ROW_CAP: 400, listAssets: async () => [] }));
vi.mock("@/lib/itdesk/repository", () => ({ getItContact: async () => null }));
vi.mock("@/lib/dentally/sync-ledger", () => ({ COUNT_CAP: 900, countWriteIntents: async () => null }));

const { OS_TILES } = await import("@/lib/home/os-band");
const { canRoleAccessModule } = await import("@/lib/nav");
type Role = import("@/lib/types").Role;

/**
 * EXHAUSTIVE BY THE TYPE, not by a list somebody remembered to extend. A sixth
 * clearance fails to compile here until it is placed — the same device the
 * clearance model uses, and the reason the FIFTH one could arrive without
 * anybody noticing the comment it falsified.
 */
const EVERY_ROLE: Record<Role, true> = {
  agency_admin: true,
  client_owner: true,
  client_coordinator: true,
  client_clinician: true,
  client_staff: true,
};
const ALL_ROLES = Object.keys(EVERY_ROLE) as Role[];

/** Exactly the filter `readOsBand` applies, from the same two sources it uses. */
function labelsFor(role: Role): string[] {
  return OS_TILES.filter((t) => canRoleAccessModule(role, t.moduleSlug)).map((t) => t.label);
}

/**
 * The guard's comment, sliced by its own opening words and with its wrapping
 * flattened.
 *
 * THE FLATTENING IS LOAD-BEARING. The sentence this file forbids wrapped as
 * "may reach none of these\n  // modules", so a phrase scan over the raw text
 * would sail straight past it. Where a comment's line breaks fall is a function
 * of where the prose reached column 80; no claim here may depend on it.
 */
function guardNote(): string {
  const src = readFileSync("src/components/client/dashboard/os-band.tsx", "utf8");
  const start = src.indexOf("NOTHING TO SHOW IS NOTHING DRAWN");
  expect(start, "the guard comment scan went stale: its opening words moved").toBeGreaterThan(-1);
  const end = src.indexOf("if (band.tiles.length === 0)", start);
  expect(end, "the guard comment no longer sits above the guard it explains").toBeGreaterThan(start);
  return src.slice(start, end).replace(/\s+/g, " ");
}

describe("the empty-band guard's comment in os-band.tsx", () => {
  it("never says a role reaches none of these modules while that role is drawn tiles", () => {
    // The exact defect, forbidden for EVERY clearance rather than only the
    // clinician it was written about.
    const note = guardNote();
    const words: Record<Role, RegExp> = {
      agency_admin: /agency[^.]*\b(none|no tiles|no band)\b/i,
      client_owner: /owner[^.]*\b(none|no tiles|no band)\b/i,
      client_coordinator: /(practice )?manager[^.]*\b(none|no tiles|no band)\b/i,
      client_clinician: /clinician[^.]*\b(none|no tiles|no band)\b/i,
      client_staff: /staff[^.]*\b(none|no tiles|no band)\b/i,
    };
    for (const role of ALL_ROLES) {
      if (labelsFor(role).length === 0) continue;
      expect(note, `the guard comment claims ${role} reaches none of these modules`).not.toMatch(
        words[role],
      );
    }
  });

  it("is right that no clearance is drawn an empty band today", () => {
    // The comment's own premise. If a module narrows and some clearance drops to
    // zero tiles, the guard starts describing a real person again and the
    // sentence above it has to be rewritten — here, not two review rounds later.
    for (const role of ALL_ROLES) {
      expect(labelsFor(role).length, `${role} is drawn no tiles at all`).toBeGreaterThan(0);
    }
  });

  it("names the narrowest band the code actually produces", () => {
    // The comment calls it "the two desks, Equipment and IT". Derived, so a
    // widening or a narrowing of either desk reddens the claim that rests on it.
    const narrowest = ALL_ROLES.map(labelsFor).sort((a, b) => a.length - b.length)[0];
    expect(narrowest).toEqual(["Equipment", "IT desk"]);
    const note = guardNote().toLowerCase();
    for (const label of narrowest) {
      expect(note, `the comment calls the narrowest band the two desks but never names "${label}"`)
        .toContain(label.toLowerCase());
    }
  });

  it("cites a test that exists", () => {
    // W3/17: a comment naming a test that does not exist is corrected or the
    // test is written. This one cites the guard's behavioural pin by name.
    const cited = "draws nothing at all for a role with no tiles";
    expect(guardNote()).toContain(cited);
    expect(readFileSync("src/lib/home/os-band.test.ts", "utf8")).toContain(`it("${cited}"`);
  });
});
