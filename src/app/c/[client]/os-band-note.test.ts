import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// THE OVERVIEW'S NOTE ABOUT THE OPERATING-SYSTEM BAND IS PART OF THE CONTRACT.
//
// Charter §0 item 1: in this tree the comments ARE the calibration contract —
// this codebase records what a thing does where the thing is used, and a later
// lane opens the page file before it opens the library. So a page comment that
// says who is drawn what is a claim like any other, and it goes stale like any
// other.
//
// It did. The note above `<OperatingSystemBand>` said the band was
// "role-filtered inside — a practice manager gets her operational subset and a
// clinician gets no band at all". That was true while the equipment desk and the
// IT desk were owner + manager. Ruling W2-A/1 (3 Sep 2026) widened both to every
// clearance, `CLINICIAN_SLUGS` gained them, and the band — which gates on
// `canRoleAccessModule` and on nothing else — began drawing a clinician two
// tiles. The commit that made the sentence false is the commit that wrote it,
// and production has no clinician login to be surprised by it.
//
// `src/lib/home/os-band.ts` pins its OWN header to this behaviour
// (os-band.test.ts, "the header's account of who sees a tile is the one the code
// gives"). This file does the same for the page, so the feature stops carrying
// two accounts of itself with only one of them checked.
//
// IT IS DERIVED, NEVER COPIED. Every expectation below is computed from the real
// `OS_TILES` and the real `canRoleAccessModule`/`indexRedirectFor`, and checked
// per role in BOTH directions — a line that omits a tile the role gets is as red
// as a line that claims one it does not. A first draft of this file asserted only
// that every label appeared SOMEWHERE in the note; widening the clinician to
// `controls` sailed straight through it, because the owner's line already named
// those two labels. Per-role, both directions, or it proves nothing.
// ===========================================================================

vi.mock("server-only", () => ({}));

// os-band.ts is a server module that pulls six repositories at import time. Only
// its tile TABLE is under test here, so each is stubbed to the shape the module
// imports, and none of them runs.
vi.mock("@/lib/systems/repository", () => ({ getSystemStates: async () => [] }));
vi.mock("@/lib/speed-to-lead/repository", () => ({ listLeads: async () => [] }));
vi.mock("@/lib/triage/repository", () => ({ listTargets: async () => [] }));
vi.mock("@/lib/equipment/repository", () => ({ ASSET_ROW_CAP: 400, listAssets: async () => [] }));
vi.mock("@/lib/itdesk/repository", () => ({ getItContact: async () => null }));
vi.mock("@/lib/dentally/sync-ledger", () => ({ COUNT_CAP: 900, countWriteIntents: async () => null }));

const { OS_TILES } = await import("@/lib/home/os-band");
const { canRoleAccessModule, indexRedirectFor } = await import("@/lib/nav");
type Role = import("@/lib/types").Role;

/**
 * EXHAUSTIVE BY THE TYPE, not by a list somebody remembered to extend. A sixth
 * clearance added to `Role` fails to compile here until it is placed, which is
 * the same device the clearance model uses (charter §2, W1-E) and the reason the
 * FIFTH one could be added without anybody noticing the note it falsified.
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

/** The roles this page actually DRAWS, rather than forwarding off itself. */
const RENDERING_ROLES = ALL_ROLES.filter((r) => indexRedirectFor(r, "vitality") === null);
const FORWARDED_ROLES = ALL_ROLES.filter((r) => indexRedirectFor(r, "vitality") !== null);

/**
 * The note as it stands in the page, sliced by its own opening words and with
 * its wrapping flattened.
 *
 * THE FLATTENING IS LOAD-BEARING, and was added after the first mutation run:
 * the stale sentence wrapped as "a clinician gets no\n            band at all",
 * so a phrase scan for "no band" over the raw text sailed past the very sentence
 * this file exists to forbid. Where a comment's line breaks fall is a function of
 * where the prose reached column 80; no claim here may depend on it.
 */
function bandNote(): string {
  const src = readFileSync("src/app/c/[client]/page.tsx", "utf8");
  const start = src.indexOf("THE PLATFORM'S OWN STATE");
  expect(start, "the note-block scan went stale: its opening words moved").toBeGreaterThan(-1);
  const end = src.indexOf("*/}", start);
  expect(end, "the note block is not closed").toBeGreaterThan(start);
  return src.slice(start, end).replace(/\s+/g, " ");
}

/**
 * The note's per-role lines, keyed by role. A line opens with the roles it
 * covers in brackets and runs to the next bracket, so the note reads as prose
 * and still says which sentence belongs to whom.
 */
function linesByRole(): Map<Role, string> {
  const note = bandNote();
  const out = new Map<Role, string>();
  for (const chunk of note.split("[").slice(1)) {
    const close = chunk.indexOf("]");
    expect(close, `an unclosed role bracket in the note: ${chunk.slice(0, 40)}`).toBeGreaterThan(-1);
    const roles = chunk
      .slice(0, close)
      .split(",")
      .map((r) => r.trim());
    const body = chunk.slice(close + 1);
    for (const r of roles) {
      expect(ALL_ROLES, `the note names a role that does not exist: ${r}`).toContain(r);
      out.set(r as Role, body);
    }
  }
  return out;
}

describe("the Overview's note about the operating-system band", () => {
  it("still sits above the band it describes", () => {
    // The scan is worth something only while the note is where the reader is. If
    // the element moves out from under its own paragraph, everything below is
    // measuring a comment about something else.
    const src = readFileSync("src/app/c/[client]/page.tsx", "utf8");
    const note = src.indexOf("THE PLATFORM'S OWN STATE");
    const band = src.indexOf("<OperatingSystemBand");
    expect(note).toBeGreaterThan(-1);
    expect(band).toBeGreaterThan(note);
  });

  it("accounts for every clearance that exists, exactly once", () => {
    // A sixth role added to the union without a line here is a silent hole in
    // the contract, which is how the fifth one produced the defect above.
    const lines = linesByRole();
    expect([...lines.keys()].sort()).toEqual([...ALL_ROLES].sort());
  });

  it("names exactly the tiles each rendering role is drawn — no more, no fewer", () => {
    const lines = linesByRole();
    expect(RENDERING_ROLES.length, "no role renders this page any more").toBeGreaterThan(0);
    for (const role of RENDERING_ROLES) {
      const line = lines.get(role)!.toLowerCase();
      const drawn = labelsFor(role);
      expect(drawn.length, `${role} is drawn no tiles at all`).toBeGreaterThan(0);
      for (const t of OS_TILES) {
        const named = line.includes(t.label.toLowerCase());
        if (drawn.includes(t.label)) {
          expect(named, `the note's ${role} line never names the "${t.label}" tile it is drawn`).toBe(
            true,
          );
        } else {
          expect(named, `the note's ${role} line claims a "${t.label}" tile ${role} is not drawn`).toBe(
            false,
          );
        }
      }
    }
  });

  it("never claims a role gets no band while that role's band is drawn", () => {
    // The specific sentence this file exists for, forbidden for EVERY drawn
    // role rather than only the clinician it was written about.
    const note = bandNote();
    const words: Record<string, RegExp> = {
      agency_admin: /agency[^.]*no (band|tiles)/i,
      client_owner: /owner[^.]*no (band|tiles)/i,
      client_coordinator: /(practice )?manager[^.]*no (band|tiles)/i,
      client_clinician: /clinician[^.]*no (band|tiles)/i,
    };
    for (const role of RENDERING_ROLES) {
      if (labelsFor(role).length === 0) continue;
      expect(note, `the note claims ${role} gets no band`).not.toMatch(words[role]);
    }
  });

  it("says a forwarded role never reaches the band, and does not list tiles for it", () => {
    // The other half of an honest enumeration. `client_staff` IS admitted to the
    // two desks by the predicate and never sees them here, because the page's own
    // guard forwards it first — a line listing its tiles would be as wrong as one
    // denying the clinician's.
    const lines = linesByRole();
    expect(FORWARDED_ROLES, "no role is forwarded off this page any more").toContain("client_staff");
    for (const role of FORWARDED_ROLES) {
      const line = lines.get(role)!.toLowerCase();
      for (const t of OS_TILES) {
        expect(
          line.includes(t.label.toLowerCase()),
          `the note lists a "${t.label}" tile for ${role}, which never reaches the band`,
        ).toBe(false);
      }
      expect(line, `the note never says why ${role} does not reach the band`).toContain("forwards");
    }
  });
});
