import { describe, it, expect } from "vitest";
import {
  CLIENT_NAV,
  NAV_CATEGORIES,
  NAV_SWITCH_EXEMPT_SLUGS,
  canRoleAccessModule,
  categoriesForRole,
} from "./nav";
import type { Role } from "./types";
import { SYSTEM_BY_SLUG, DEFAULT_OFF_SLUGS } from "./systems/catalog";

// ===========================================================================
// WHERE THE DENTAL OS WAVE-1 SURFACES LIVE, AND WHO REACHES THEM.
//
// Wave 1 landed five surfaces in five parallel lanes, each of which placed its
// own module in the nav without seeing the others. This suite is the join: it
// asserts the placements against the programme coordinator's WRITTEN rulings
// rather than against whatever the last lane happened to write, and it is
// deliberately a TABLE rather than a list of `expect` lines, so a sixth role or
// a sixth surface cannot be added without being placed.
//
// THE RULINGS THIS FILE PINS (docs/superpowers/plans/2026-09-03-dental-os-
// program.md, and the DECISIONS LOG in the programme memory):
//
//   pre-visit-triage  owner + agency + practice manager. The clinician is
//                     deliberately denied: what a clinician needs is the pre-
//                     visit SUMMARY on the patient record, gated on "patients",
//                     not the editor that decides what every patient is asked.
//   equipment         WIDENED on W2-A/1 (3 Sep 2026) to ALL FIVE clearances.
//                     The lane's brief said "owner+manager; clinician/staff
//                     denied — as built", and the coordinator's later ruling
//                     replaced it: "a dental nurse is client_staff, and 'the
//                     autoclave is beeping' / 'I'm locked out' are her
//                     questions; neither module holds patient data; both gates
//                     refuse credentials and safety bypasses." The boundary
//                     moved rather than vanished — the register WRITES (import,
//                     save, delete) clear requireApproverRole per action in the
//                     route, and every method of equipment/manual clears it.
//   it-desk           the same widening; setting the practice's IT contact
//                     stays requireOwnerRole.
//   controls (+sync)  owner + agency only. It is the kill switch and the
//                     Dentally write ledger; a manager reaches neither.
//   authorities       owner-only, and it is not a module at all — it is a panel
//                     inside the co-pilot page, absent from the HTML for anyone
//                     else. Asserted here as "not a nav slug", because a lane
//                     that promoted it to one would have widened it silently.
//
//   NAV_SWITCH_EXEMPT for equipment + it-desk was APPROVED on the ground that
//   the switch halts the CHAT, not the page: the register, the manuals and the
//   IT contact all have to be loadable BEFORE the switch goes on.
// ===========================================================================

/** Every role, exhaustively. A sixth role is a compile error until it is placed. */
const ROLES: Record<Role, true> = {
  agency_admin: true,
  client_owner: true,
  client_coordinator: true,
  client_clinician: true,
  client_staff: true,
};

/** The wave-1 surfaces that ARE nav modules, and the exact roles that reach each. */
const OS_MODULE_ACCESS: Record<string, Record<Role, boolean>> = {
  "pre-visit-triage": {
    agency_admin: true,
    client_owner: true,
    client_coordinator: true,
    client_clinician: false,
    client_staff: false,
  },
  // Both desks are open to every clearance on W2-A/1. What each role may CHANGE
  // there is a route-level guard, not a nav one, and is pinned in
  // nav.staff.test.ts section 8 and the two route suites.
  equipment: {
    agency_admin: true,
    client_owner: true,
    client_coordinator: true,
    client_clinician: true,
    client_staff: true,
  },
  "it-desk": {
    agency_admin: true,
    client_owner: true,
    client_coordinator: true,
    client_clinician: true,
    client_staff: true,
  },
  controls: {
    agency_admin: true,
    client_owner: true,
    client_coordinator: false,
    client_clinician: false,
    client_staff: false,
  },
  // The co-pilot itself is open to every role by W1-E/2's ruling; the room each
  // of them reaches inside is decided by the clearance Record, not by the nav.
  // It is in this table so the DOOR staying open is pinned in the same place as
  // the doors that are shut.
  "co-pilot": {
    agency_admin: true,
    client_owner: true,
    client_coordinator: true,
    client_clinician: true,
    client_staff: true,
  },
};

describe("wave-1 surfaces are placed where the rulings put them", () => {
  it("every role's access to every OS module is exactly the ruled value", () => {
    // Built as a TABLE and compared in one assertion, so a failure prints the
    // whole map rather than the first cell that went wrong.
    const actual: Record<string, Record<string, boolean>> = {};
    for (const slug of Object.keys(OS_MODULE_ACCESS)) {
      actual[slug] = {};
      for (const role of Object.keys(ROLES) as Role[]) {
        actual[slug][role] = canRoleAccessModule(role, slug);
      }
    }
    expect(actual).toEqual(OS_MODULE_ACCESS);
  });

  it("the nav ITEM and the access predicate agree for every OS module", () => {
    // A `roles` array that says one thing while the predicate says another is
    // the drift this catches: the predicate is what the guard calls, and the
    // array is what a reader believes.
    const bySlug = new Map(CLIENT_NAV.flatMap((g) => g.items).map((i) => [i.slug, i]));
    for (const [slug, table] of Object.entries(OS_MODULE_ACCESS)) {
      const item = bySlug.get(slug);
      expect(item, `${slug} is not in CLIENT_NAV`).toBeTruthy();
      for (const role of Object.keys(ROLES) as Role[]) {
        const inNav = categoriesForRole(role)
          .flatMap((c) => c.items)
          .some((i) => i.slug === slug);
        expect(inNav, `${slug} in nav for ${role}`).toBe(table[role]);
      }
    }
  });

  it("the approved-sources list is a PANEL, never a module slug", () => {
    // If a lane ever gives it a nav entry it inherits the nav's allow-by-default
    // rule and becomes visible to the practice manager, which is the one thing
    // the co-pilot page's server-side role check exists to prevent.
    const slugs = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs).not.toContain("authorities");
    expect(slugs).not.toContain("approved-authorities");
    expect(NAV_CATEGORIES.flatMap((c) => c.slugs)).not.toContain("authorities");
  });

  it("each OS module sits in exactly one category, and in the one it belongs to", () => {
    const categoryOf = (slug: string) =>
      NAV_CATEGORIES.filter((c) => c.slugs.includes(slug)).map((c) => c.key);
    // Patients: the pre-visit questions are asked of patients before their
    // appointment and read by the person working the patient list.
    expect(categoryOf("pre-visit-triage")).toEqual(["patients"]);
    // Operations: the two desks and the master switch panel are the practice
    // manager's and the owner's back-office, not a patient surface.
    expect(categoryOf("equipment")).toEqual(["operations"]);
    expect(categoryOf("it-desk")).toEqual(["operations"]);
    expect(categoryOf("controls")).toEqual(["operations"]);
    expect(categoryOf("co-pilot")).toEqual(["operations"]);
  });
});

describe("a default-off preparation surface stays reachable while it is off", () => {
  // THE RULE, stated as a rule rather than as three slugs: a module that ships
  // switched OFF and whose page is where the practice PREPARES the thing the
  // switch turns on must be exempt from the kill switch's nav hiding, or the
  // owner is handed a system they cannot prepare and therefore cannot sensibly
  // turn on. The switch still halts the work — enforced in the routes.
  const PREPARATION_SURFACES = [
    // slug, what the page is FOR before switch-on
    ["equipment", "the asset register and the manuals"],
    ["it-desk", "the practice's named IT contact"],
    ["pre-visit-triage", "the two question lists"],
  ] as const;

  it("every one of them ships default-off", () => {
    for (const [slug] of PREPARATION_SURFACES) {
      expect(DEFAULT_OFF_SLUGS.has(slug), `${slug} is no longer default-off`).toBe(true);
    }
  });

  it("every one of them is switch-exempt in the nav", () => {
    for (const [slug, prepares] of PREPARATION_SURFACES) {
      expect(
        NAV_SWITCH_EXEMPT_SLUGS.has(slug),
        `${slug} is hidden while off, so ${prepares} cannot be prepared before switch-on`,
      ).toBe(true);
    }
  });

  it("the sidebar still shows them to the owner with every system switched off", () => {
    // THE DELTA THIS FILE ADDS (Dental OS wave 2): pre-visit-triage was NOT in
    // NAV_SWITCH_EXEMPT_SLUGS, so on every practice — where it seeds off twice
    // over — the module was missing from the sidebar from the first day, and the
    // owner's own instruction ("review the two question lists, then switch on")
    // pointed at a screen the switch was hiding.
    const allOff = new Set(CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug)));
    const visible = categoriesForRole("client_owner", allOff).flatMap((c) =>
      c.items.map((i) => i.slug),
    );
    for (const [slug] of PREPARATION_SURFACES) {
      expect(visible, `${slug} vanished from the sidebar with its switch off`).toContain(slug);
    }
    // And the exemption is NOT a blanket one: a module with no preparation to do
    // still disappears when its system is switched off, which is what the kill
    // switch is for.
    expect(visible).not.toContain("recall");
    expect(visible).not.toContain("reviews");
  });

  it("being switch-exempt is not being switch-less: each still has a real system", () => {
    for (const [slug] of PREPARATION_SURFACES) {
      expect(SYSTEM_BY_SLUG.get(slug), `${slug} has no controllable system`).toBeTruthy();
    }
  });

  // ===========================================================================
  // AND THE SIDEBAR SAYS SO. W3/9: copy matches code, never the reverse.
  //
  // The System controls nav note is the sentence an owner reads BEFORE opening
  // the panel, and it carried the identical over-claim the panel's own paragraph
  // did until kill-switch-copy.test.ts pinned that one: "Switching one off is a
  // full kill switch: it hides the module and halts its server-side work, so
  // nothing sends until it is switched back on."
  //
  // Both halves are falsified by this very file. "It hides the module" is untrue
  // of all four NAV_SWITCH_EXEMPT_SLUGS — the assertion three tests above proves
  // the owner still sees them with every system off — and "halts its server-side
  // work" is untrue of outreach, whose build-continuation pass runs ahead of the
  // send gate by design, and of post-op check-in, whose `halts` sentence says
  // replies are still triaged by a person.
  //
  // Two surfaces described the same switch and only ONE of them was joined to the
  // code, which is exactly how the two drifted apart. This is the other join.
  // ===========================================================================
  describe("the System controls nav note describes the switch this file implements", () => {
    const controlsNote =
      CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "controls")?.note ?? "";

    it("is present, so the assertions below are not vacuous", () => {
      expect(controlsNote.length).toBeGreaterThan(80);
      expect(NAV_SWITCH_EXEMPT_SLUGS.size).toBeGreaterThan(0);
    });

    // MUTATION: put "it hides the module" back. Four modules stay in the sidebar
    // with their switch off — the owner who flips Pre-visit questions off, still
    // finds it, and reasonably concludes the switch did not take.
    it("does not claim the switch hides the module while any slug is exempt", () => {
      expect(NAV_SWITCH_EXEMPT_SLUGS.size, "nothing is exempt, so re-read this rule").toBeGreaterThan(
        0,
      );
      expect(controlsNote).not.toMatch(/hides the module/i);
      expect(controlsNote).not.toMatch(/\bfull kill switch\b/i);
    });

    // MUTATION: restore "halts its server-side work", which outreach's ungated
    // build pass and post-op's own halts sentence both falsify.
    it("does not claim every scrap of server-side work stops", () => {
      expect(controlsNote).not.toMatch(/halts its server-side work/i);
      expect(controlsNote).not.toMatch(/stops all of its work/i);
    });

    it("says what IS true of every system, and that the preparation screens remain", () => {
      expect(controlsNote).toContain("halts that system's work");
      expect(controlsNote).toContain("it writes nothing to Dentally");
      expect(controlsNote).toMatch(/preparation screens stay reachable/);
    });
  });
});
