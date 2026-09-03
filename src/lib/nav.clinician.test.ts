import { describe, it, expect, vi } from "vitest";

// guard.ts opens with `import "server-only"`, which is a Next.js-internal module
// with no top-level node_modules entry, so a plain node-env import of it fails to
// resolve. Stubbing it is the standard way to reach a server module from vitest;
// every OTHER test in the repo mocks the whole of guard.ts, but test 7 below has
// to exercise the REAL requireOwnerRole, or it pins nothing.
vi.mock("server-only", () => ({}));

import {
  navForRole,
  canRoleAccessModule,
  categoriesForRole,
  CLIENT_NAV,
  CLIENT_MODULE_SLUGS,
  CLINICIAN_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  OWNER_ROLES,
} from "./nav";
import { requireOwnerRole } from "./auth/guard";
import type { AuthedUser } from "./auth/session";

// ===========================================================================
// THE FOURTH ROLE: client_clinician.
//
// A separate file from nav.test.ts ON PURPOSE. nav.test.ts holds the pins the
// existing three roles have always had; if ADDING THE CLINICIAN had required
// editing one of them, that would itself have been the signal that the fourth
// role widened one of the other three. It did not: the clinician branch returns
// before any of their evaluation, and the proof of that is TEST 1 below, not this
// comment.
//
// CORRECTION, 2026-08-03: an earlier version of this header claimed "nothing in
// nav.test.ts changed", and by the time it was written that was already false.
// One expectation in it (the coordinator's Operations rail) was updated the same
// night, because the coordinator was DELIBERATELY granted "absence" and
// "staff-check-in" — a separate decision about the practice manager's job, made
// alongside the clinician work rather than caused by it. The distinction the
// original comment was reaching for is real and still holds, so it is stated
// precisely above instead of as a blanket claim that the file went untouched.
//
// The whole reason this file exists is that the nav is ALLOW-BY-DEFAULT:
// `roleCanSeeItem` returns true for any item carrying no `roles` array, and
// `canRoleAccessModule` returns true for a slug it does not recognise at all.
// Roughly two thirds of the modules carry no `roles` array, so a fourth role
// added the obvious way inherits Payments, Recall, Reactivation, Conversations,
// the agents and the rest by accident. CLINICIAN_SLUGS + an early return in both
// predicates is the only form of the fix that can be PROVEN not to widen the
// other three, and these tests are that proof.
// ===========================================================================

/** Every slug either predicate can be asked about, nav modules plus the owner-shell extras. */
const ALL_SLUGS = [...CLIENT_MODULE_SLUGS, ...EXTRA_OWNER_ONLY_SLUGS];

/** The owner-only list, copied from nav.test.ts so this file stands alone.
 *  "co-pilot" left it in the manager-co-pilot lane — see ADDED_MANAGER_COPILOT. */
const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "settings"];

function navSlugs(role: Parameters<typeof navForRole>[0]): string[] {
  return navForRole(role).flatMap((g) => g.items.map((i) => i.slug));
}

function allowedSlugs(role: Parameters<typeof canRoleAccessModule>[0]): string[] {
  return ALL_SLUGS.filter((slug) => canRoleAccessModule(role, slug));
}

// ---------------------------------------------------------------------------
// TEST 1 — the non-widening proof, stated as baseline + a named delta.
//
// A bare snapshot of today's values would only pin "whatever it is now", which
// silently absorbs any widening committed alongside it. So BASELINE holds the
// EXACT sets the three existing roles had at commit 6866aac, before the clinician
// role existed, and ADDED_TONIGHT names the only two slugs this change was
// allowed to give them and why. Together they say: nothing was removed, and
// nothing was added except these. A future edit that widens any of the three
// fails here with the offending slug named in the diff.
// ---------------------------------------------------------------------------
const BASELINE: Record<string, string[]> = {
  agency_admin: [
    "", "roi", "reports", "calendar", "patients", "payments", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_owner: [
    "", "roi", "reports", "calendar", "patients", "payments", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_coordinator: [
    "", "calendar", "patients", "payments", "landing-pages", "smile-assessment", "speed-to-lead",
    "onboarding", "booking", "power-dialler", "task-queue", "recall", "reactivation",
    "treatment-coordinator", "after-hours", "no-show-defence", "reviews", "conversations",
    "booking-agent", "whatsapp", "daily-brief", "notifications", "getting-started",
  ],
};

/**
 * The complete, deliberate delta of this change for the three existing roles.
 *
 * - "absence" is a brand-new module, so every role that may see it is an addition
 *   by definition. It is NOT owner-only: the practice manager (a client_coordinator
 *   in this platform) is the person who approves holiday.
 * - "staff-check-in" already existed and was already visible to agency + owner as a
 *   placeholder, so flipping it live added nothing for them. The coordinator IS a
 *   genuine grant, for the same reason: attendance exceptions are the manager's job.
 * - "fp17" (added in the clinical-record parity wave) is the NHS FP17/PR consent +
 *   exemption declaration module. It carries no `roles` array — reviewing captured
 *   declarations is front-desk records work, exactly like Onboarding — so all three
 *   non-clinician roles gain it. The clinician does NOT (it is not in CLINICIAN_SLUGS),
 *   which the tests below still prove.
 */
const ADDED_TONIGHT: Record<string, string[]> = {
  agency_admin: ["absence", "fp17"],
  client_owner: ["absence", "fp17"],
  client_coordinator: ["absence", "staff-check-in", "fp17"],
};

/**
 * A SECOND, LATER DELTA — campaign 6 (the fifth role + the HR lane).
 *
 * Kept separate from ADDED_TONIGHT rather than merged into it, for the same reason
 * ADDED_TONIGHT is separate from BASELINE: a delta folded into the layer beneath it
 * stops being a decision anybody can read, and the next reviewer cannot tell which
 * night granted what. Each line here has its counterpart in `nav.staff.test.ts`,
 * which is where the reasoning lives and where the fifth role itself is proven.
 *
 * - "my-work" is the new staff self-service surface. Every staff-facing role gets
 *   it, including the clinician (via CLINICIAN_SLUGS — see test 6 below, which is
 *   why that pin moved from five modules to six).
 * - "hours" and "staff-hr" are the new Hours & pay and Staff HR modules: owner,
 *   agency and the practice manager, matching absence and staff-check-in.
 * - "permissions" is People & logins, owner-only.
 * - "rota" for the COORDINATOR is a widening of an existing module, not a new one:
 *   the practice manager is the rota's primary user and the owner-only array locked
 *   her out of the page and all four of its API routes.
 */
const ADDED_CAMPAIGN_6: Record<string, string[]> = {
  agency_admin: ["my-work", "hours", "staff-hr", "permissions"],
  client_owner: ["my-work", "hours", "staff-hr", "permissions"],
  client_coordinator: ["my-work", "hours", "staff-hr", "rota"],
};

/**
 * A THIRD DELTA — the manager co-pilot (agent expansion, Wave 3 #5). One module,
 * one role, and it is a widening of an existing module rather than a new one.
 *
 * "co-pilot" was owner-only because the co-pilot reads across the whole practice
 * and there was no way to give a manager less of it. There is now:
 * `copilotAccessForRole` (src/lib/copilot/scope.ts) derives a six-tool
 * operational allow-list from the SESSION's role, caps the practice-brain
 * clearance at her own tier, and projects money out of the patient record — all
 * server-side, all before the model is handed a schema. Reaching the module is
 * therefore no longer the same question as reaching the owner's data, which is
 * what let this line be written at all.
 *
 * The two allow-list roles are unaffected: "co-pilot" is in neither
 * CLINICIAN_SLUGS nor STAFF_SLUGS, and their branches return before this array is
 * ever read. Tests 2 and 6 below still prove it.
 */
const ADDED_MANAGER_COPILOT: Record<string, string[]> = {
  agency_admin: [],
  client_owner: [],
  client_coordinator: ["co-pilot"],
};

/**
 * W1-C: the pre-visit triage module.
 *
 * A NEW named delta rather than an edit to any layer beneath it, which is this
 * file's own rule: "a delta folded into the layer beneath it stops being a
 * decision anybody can read."
 *
 * WHO GETS IT AND WHY. The page is the ADMIN surface for the module — the two
 * editable question banks, the per-treatment interest lists, and the
 * implant-interest list. The owner runs the banks; the practice manager (a
 * client_coordinator here) runs the interest lists, because following up a
 * patient who asked to hear about whitening is exactly her job and it sits
 * beside Leads, which she already has.
 *
 * WHO DOES NOT, AND THIS IS THE PART WORTH READING. The CLINICIAN is deliberately
 * absent. What a clinician needs from this module is the pre-visit SUMMARY on the
 * patient record ("this is what the patient shared"), and that is gated on
 * "patients" — a slug they already hold. Adding this slug to CLINICIAN_SLUGS
 * would hand them the editor that decides what every patient in the practice is
 * asked, which is a practice-policy decision and not a clinical one.
 *
 * client_staff is absent for the ordinary reason: STAFF_SLUGS is two entries.
 */
const ADDED_PREVISIT: Record<string, string[]> = {
  agency_admin: ["pre-visit-triage"],
  client_owner: ["pre-visit-triage"],
  client_coordinator: ["pre-visit-triage"],
};

/**
 * ADDED, W1-D — the two staff-facing desk modules: the equipment register and
 * its desk, and the IT desk.
 *
 * Their own map rather than a line appended to an earlier one, for the reason
 * this whole file is built the way it is: a delta folded into the layer beneath
 * it stops being a decision anybody can read.
 *
 * WHO GETS THEM. The owner, the agency and the PRACTICE MANAGER. The equipment
 * register is the practice manager's document in every practice that keeps one,
 * and front-desk IT problems land on her too; gating either on OWNER_ROLES would
 * lock out the primary user, which is the mistake Staff rota made and had to
 * undo.
 *
 * WHO DOES NOT. The clinician and the staff role, both by their own allow-lists,
 * which run first. That is a deliberate and slightly uncomfortable line for the
 * IT desk in particular — a nurse who cannot print is exactly the person it would
 * help — and it is drawn here on purpose: widening either allow-list is a
 * decision to take on written instruction, not one to make in passing while
 * shipping a module. The lane's brief says owner + manager, so it is owner +
 * manager.
 */
const ADDED_DESKS: Record<string, string[]> = {
  agency_admin: ["equipment", "it-desk"],
  client_owner: ["equipment", "it-desk"],
  client_coordinator: ["equipment", "it-desk"],
};

/**
 * WIDENED, Dental OS W1-E — the co-pilot, for the two allow-list roles.
 *
 * Its own map rather than a line appended to the maps above, for the reason each
 * of those states about itself: a delta folded into the layer beneath it stops
 * being reviewable as a delta, and the whole value of this file is that every
 * widening is readable as its own decision with its own reason.
 *
 * THE DECISION. Taken on the programme coordinator's written ruling of
 * 3 Sep 2026, on the Dental OS mandate that the co-pilot serves every staff
 * clearance. The lane built the clinician and staff catalogs first and left them
 * inert precisely so that switching them on could be one reviewed line rather
 * than a design exercise under time pressure.
 *
 * WHY THIS IS A DOOR AND NOT A ROOM. `canRoleAccessModule` decides whether a
 * login may reach /c/<client>/co-pilot at all. What it is ANSWERED with is
 * decided server-side per turn from the SESSION's role, three independent times
 * (src/lib/copilot/clearance.ts): the tool schema the model is shown, the gate
 * checked before any tool runs, and the projection applied on the way out.
 *
 *   client_clinician  six READ tools — their patients, their diary, the
 *                     practice's general knowledge at tier 1, their own work, and
 *                     second-opinion decision support on a named patient — and NO
 *                     act domain. A clinician does not send to a patient from
 *                     here (ruling 1 of the same message).
 *   client_staff      ONE tool, `my_work`, about the person signed in. It takes
 *                     no staff id and resolves the record from the session, so it
 *                     cannot be pointed at a colleague. No patient, no diary, no
 *                     money.
 *
 * `indexRedirectFor` is untouched: a client_staff login still lands on My work
 * before any dashboard read runs, so the takings are still never fetched for it.
 */
const WIDENED_COPILOT_ALL_CLEARANCES: Record<string, string[]> = {
  agency_admin: [],
  client_owner: [],
  client_coordinator: [],
  client_clinician: ["co-pilot"],
};

/**
 * WIDENED, Dental OS W2-A/1 — the equipment desk and the IT desk, for the two
 * allow-list roles.
 *
 * Its own map rather than a line appended to ADDED_DESKS, for the reason every
 * layer in this file states about itself: a delta folded into the layer beneath
 * it stops being reviewable as a delta. ADDED_DESKS records that the two modules
 * shipped owner + agency + practice manager, and its comment says in as many
 * words that the line was "deliberate and slightly uncomfortable for the IT desk
 * in particular — a nurse who cannot print is exactly the person it would help"
 * and would only move "on written instruction". This is that instruction.
 *
 * THE RULING (programme coordinator, 3 Sep 2026): the IT desk and the equipment
 * READ surfaces widen to ALL five clearances, including clinician and
 * client_staff. A dental nurse is a client_staff; "the autoclave is beeping" and
 * "I'm locked out" are her questions; neither module holds patient data; and
 * both agents' gates already refuse credentials and safety bypasses.
 *
 * WHAT THE SLUG BUYS, AND WHAT IT DOES NOT. The slug is the door.
 *   equipment  read the register, search the manuals, ask the desk. The CSV
 *              import and adding, editing or deleting an item clear
 *              `requireApproverRole` per action in
 *              src/app/api/equipment/[action]/route.ts, and every method of
 *              .../equipment/manual/route.ts clears it unconditionally — so a
 *              nurse can read the register the practice shows CQC and cannot
 *              rewrite it.
 *   it-desk    ask the desk, read the playbooks. Setting the practice's IT
 *              contact stays `requireOwnerRole`, because who the practice
 *              escalates to changes what every member of staff is told to do.
 *
 * Both slugs are consequently modules NO role is denied, which makes their
 * module guard inert on its own. That is declared in
 * src/app/api/client-api-module-guard-coverage.test.ts's UNIVERSAL_MODULES with
 * the second lock each route carries, so the sweep now demands MORE of them.
 *
 * `indexRedirectFor` is untouched. A client_staff login still lands on My work
 * and the practice dashboard's money and diary are still never fetched for it;
 * these two modules are reached from the nav, not from the landing.
 */
const WIDENED_DESKS_ALL_CLEARANCES: Record<string, string[]> = {
  agency_admin: [],
  client_owner: [],
  client_coordinator: [],
  client_clinician: ["equipment", "it-desk"],
};

/** practice-brain is not a CLIENT_NAV module, so it never appears in navForRole. */
const EXTRA_ALLOWED_NOT_IN_NAV: Record<string, string[]> = {
  agency_admin: ["practice-brain"],
  client_owner: ["practice-brain"],
  client_coordinator: [],
};

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe("1. the existing three roles are byte-identical apart from the named delta", () => {
  it.each(["agency_admin", "client_owner", "client_coordinator"] as const)(
    "%s sees exactly its baseline nav plus tonight's named additions, and nothing else",
    (role) => {
      const expected = [
        ...BASELINE[role],
        ...ADDED_TONIGHT[role],
        ...ADDED_CAMPAIGN_6[role],
        ...ADDED_MANAGER_COPILOT[role],
        ...ADDED_PREVISIT[role],
        ...ADDED_DESKS[role],
        ...WIDENED_COPILOT_ALL_CLEARANCES[role],
        ...WIDENED_DESKS_ALL_CLEARANCES[role],
      ];
      expect(sorted(navSlugs(role))).toEqual(sorted(expected));
    },
  );

  it.each(["agency_admin", "client_owner", "client_coordinator"] as const)(
    "%s may reach exactly its baseline module set plus tonight's named additions",
    (role) => {
      const expected = [
        ...BASELINE[role],
        ...ADDED_TONIGHT[role],
        ...ADDED_CAMPAIGN_6[role],
        ...ADDED_MANAGER_COPILOT[role],
        ...ADDED_PREVISIT[role],
        ...ADDED_DESKS[role],
        ...WIDENED_COPILOT_ALL_CLEARANCES[role],
        ...WIDENED_DESKS_ALL_CLEARANCES[role],
        ...EXTRA_ALLOWED_NOT_IN_NAV[role],
      ];
      expect(sorted(allowedSlugs(role))).toEqual(sorted(expected));
    },
  );

  it("the clinician branch is unreachable for the other three (their path is the old one)", () => {
    // Direct statement of the mechanism: the early return keys on the role only, so
    // for any other role CLINICIAN_SLUGS membership is irrelevant. "payments" is in
    // no allow-list yet is open to all three; "controls" is in no allow-list and is
    // owner-only. Both answers come from the ORIGINAL rules, not the new branch.
    //
    // ("co-pilot" was the owner-only example here until the manager-co-pilot lane
    // made it shared. "controls" replaces it and is a stronger one: the kill
    // switches are the thing this platform will never hand to a non-owner.)
    expect(CLINICIAN_SLUGS.has("payments")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "payments")).toBe(true);
    expect(CLINICIAN_SLUGS.has("controls")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "controls")).toBe(false);
    expect(canRoleAccessModule("client_owner", "controls")).toBe(true);
  });
});

describe("2. the clinician is denied every slug outside the allow-list", () => {
  it("iterates the FULL slug list, not a hand-picked sample", () => {
    const denied = ALL_SLUGS.filter((slug) => !CLINICIAN_SLUGS.has(slug));
    // Guards the guard: if the allow-list ever swallowed the nav, this loop would
    // be empty and assert nothing.
    expect(denied.length).toBeGreaterThan(20);
    for (const slug of denied) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    }
  });

  it("and is allowed every slug that IS in the allow-list", () => {
    for (const slug of CLINICIAN_SLUGS) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(true);
    }
  });
});

describe("3. the clinician is denied every owner-only module", () => {
  it.each(OWNER_ONLY)("cannot reach '%s'", (slug) => {
    expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    // Control: the owner still can, so this is a role difference and not a slug that
    // has quietly been switched off for everyone.
    expect(canRoleAccessModule("client_owner", slug)).toBe(true);
  });
});

describe("4. the clinician is denied the owner-shell practice-brain", () => {
  it("blocks the EXTRA_OWNER_ONLY_SLUGS path", () => {
    expect(EXTRA_OWNER_ONLY_SLUGS.has("practice-brain")).toBe(true);
    expect(canRoleAccessModule("client_clinician", "practice-brain")).toBe(false);
    expect(canRoleAccessModule("client_owner", "practice-brain")).toBe(true);
  });
});

describe("5. an UNKNOWN slug does not fall through to true for the clinician", () => {
  it("refuses a slug that is in no list at all", () => {
    // canRoleAccessModule ends `if (!item) return true` for a slug it cannot find.
    // That fall-through is deliberate for the existing three (the page itself 404s),
    // but for a deny-by-default role it would be a hole wide enough to drive a
    // future module through: any module added without a nav entry would be open.
    for (const slug of ["not-a-real-module", "payroll", "finance/export", ""]
      .filter((s) => !CLINICIAN_SLUGS.has(s) && !CLIENT_MODULE_SLUGS.includes(s))) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    }
    expect(canRoleAccessModule("client_clinician", "not-a-real-module")).toBe(false);
  });

  it("while the existing three keep the documented fall-through, unchanged", () => {
    for (const role of ["agency_admin", "client_owner", "client_coordinator"] as const) {
      expect(canRoleAccessModule(role, "not-a-real-module")).toBe(true);
    }
  });
});

describe("6. CLINICIAN_SLUGS contains only real modules", () => {
  it("is a subset of CLIENT_MODULE_SLUGS", () => {
    // A typo'd slug would grant nothing AND hide nothing, so it would never show up
    // as a failure anywhere else: the module stays denied and the test suite stays
    // green while the clinician silently cannot reach the page they were given.
    for (const slug of CLINICIAN_SLUGS) {
      expect(CLIENT_MODULE_SLUGS).toContain(slug);
    }
  });

  it("names the exact nine modules a clinician gets", () => {
    // WAS FIVE. "my-work" was added in campaign 6 and this pin moved with it,
    // deliberately: the clinician's allow-list is the tightest in the platform and a
    // silent addition to it is exactly what this assertion exists to catch, so the
    // addition has to be made here, by hand, with a reason.
    //
    // The reason: my-work is the staff self-service surface (own published rota, own
    // holiday, own documents, own policy signatures) and a clinician is a member of
    // staff. Every tab of it is scoped to the CALLER'S OWN staff record resolved from
    // the session, so it grants no data the clinician did not already hold — unlike
    // "calendar" or "patients", which are practice-wide.
    //
    // NOW SEVEN. "co-pilot" was added on the programme coordinator's written
    // ruling of 3 Sep 2026 (Dental OS, lane W1-E), and the same reasoning applies
    // as for my-work: it grants a second way to ask about data this role already
    // holds. A clinician's co-pilot is six READ tools — the patients and diary
    // their own screens already show, the practice's general knowledge at tier 1,
    // their own work, and second-opinion decision support on a named patient —
    // with NO act domain at all, so it cannot send, book, cancel or create
    // anything. That catalog is enforced server-side on every turn and is pinned
    // in src/lib/copilot/clearance.test.ts, not here.
    //
    // NOW NINE. "equipment" and "it-desk" were added on the programme
    // coordinator's written ruling of 3 Sep 2026 (Dental OS, W2-A/1) — see
    // WIDENED_DESKS_ALL_CLEARANCES above for the ruling in full. Neither module
    // holds a patient row or an appointment: one is the practice's machine
    // register and its manuals, the other is a troubleshooting chat with the
    // practice's playbooks in it. The write half of each stays behind
    // requireApproverRole / requireOwnerRole in the routes, so what this line
    // grants a clinician is reading and asking, not editing.
    expect(sorted([...CLINICIAN_SLUGS])).toEqual(
      sorted([
        "",
        "calendar",
        "patients",
        "absence",
        "staff-check-in",
        "my-work",
        "co-pilot",
        "equipment",
        "it-desk",
      ]),
    );
  });
});

describe("7. the API guard refuses the clinician", () => {
  const clinician: AuthedUser = {
    id: "u-clinician",
    name: "Dr Sara Malik",
    email: "sara@vitalitydental.co.uk",
    role: "client_clinician",
    clientId: "vitality",
    siteIds: ["site-cc"],
  };

  it("requireOwnerRole returns a 403 Response for a clinician", async () => {
    const res = requireOwnerRole(clinician);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("and still passes the owner and the agency admin through", () => {
    expect(requireOwnerRole({ ...clinician, role: "client_owner" })).toBeNull();
    expect(requireOwnerRole({ ...clinician, role: "agency_admin" })).toBeNull();
    expect(requireOwnerRole({ ...clinician, role: "client_coordinator" })?.status).toBe(403);
  });
});

describe("8. navForRole for the clinician", () => {
  it("returns only allow-listed items and drops every emptied group", () => {
    const groups = navForRole("client_clinician");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(CLINICIAN_SLUGS.has(item.slug)).toBe(true);
      }
    }
    // The whole allow-list is actually reachable in the nav (nothing stranded).
    expect(sorted(navSlugs("client_clinician"))).toEqual(sorted([...CLINICIAN_SLUGS]));
    // And it really is a shrunk nav, not the full one.
    expect(navSlugs("client_clinician").length).toBeLessThan(navSlugs("client_owner").length);
  });

  it("drops whole groups the clinician has nothing in", () => {
    const clinicianGroups = navForRole("client_clinician").map((g) => g.label);
    const allGroups = CLIENT_NAV.map((g) => g.label);
    expect(clinicianGroups.length).toBeLessThan(allGroups.length);
    // Acquisition is entirely outside the allow-list, so the group disappears.
    expect(clinicianGroups).not.toContain("Acquisition");
    expect(allGroups).toContain("Acquisition");
  });
});

describe("9. categoriesForRole for the clinician", () => {
  it("contains no owner-only slug in any rail category", () => {
    const slugs = categoriesForRole("client_clinician").flatMap((c) => c.items.map((i) => i.slug));
    for (const ownerOnly of OWNER_ONLY) expect(slugs).not.toContain(ownerOnly);
    for (const slug of slugs) expect(CLINICIAN_SLUGS.has(slug)).toBe(true);
    // Non-empty, so "contains nothing" is not the reason it passes.
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs).toContain("calendar");
  });
});

describe("10. the new role was not added to the owner list", () => {
  it("OWNER_ROLES still has exactly two members", () => {
    expect(OWNER_ROLES).toEqual(["agency_admin", "client_owner"]);
    expect(OWNER_ROLES).toHaveLength(2);
    expect(OWNER_ROLES).not.toContain("client_clinician");
  });
});
