import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

// guard.ts opens with `import "server-only"`, a Next.js-internal module with no
// top-level node_modules entry, so a plain node-env import of it fails to resolve.
// Stubbing it is the standard way to reach a server module from vitest, and tests
// 7 and 8 below have to exercise the REAL guards or they pin nothing.
vi.mock("server-only", () => ({}));
vi.mock("./auth/session", () => ({
  canAccessClient: () => true,
  getSessionUser: async () => null,
}));

import {
  navForRole,
  canRoleAccessModule,
  categoriesForRole,
  CLIENT_NAV,
  CLIENT_MODULE_SLUGS,
  CLINICIAN_SLUGS,
  STAFF_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  OWNER_ROLES,
} from "./nav";
import { requireOwnerRole, requireApproverRole, requireClinicalWriteRole } from "./auth/guard";
import type { AuthedUser } from "./auth/session";
import type { Role } from "./types";

// ===========================================================================
// THE FIFTH ROLE: client_staff.
//
// A separate file from nav.test.ts and nav.clinician.test.ts ON PURPOSE, and the
// separation is itself part of the proof. nav.test.ts holds the pins the original
// three roles have always had; nav.clinician.test.ts holds the fourth role's. If
// adding the FIFTH role had silently widened any of the four, the failure would
// surface in one of those files rather than being absorbed into a fresh snapshot
// written the same night.
//
// It did not widen them by accident. It widened two of them ON PURPOSE, and those
// two widenings are named below as WIDENED — the rota for the coordinator, and
// my-work for the clinician — with the reason for each. A future edit that widens
// anything else fails here with the offending slug in the diff.
//
// It also TIGHTENED three routes (the clinical writes), which is the rarer and more
// dangerous direction: a tightening that nobody wrote down looks exactly like a bug
// report a month later. TIGHTENED names them.
//
// The mechanism, restated because it is the whole safety argument: this nav is
// allow-BY-DEFAULT. `roleCanSeeItem` returns true for any item carrying no `roles`
// array and `canRoleAccessModule` returns true for a slug it does not recognise at
// all, and roughly two thirds of the modules carry no `roles` array. A fifth role
// added the obvious way inherits Conversations, Recall, Reactivation, Payments and
// every agent on the day it is created. STAFF_SLUGS plus an early return in both
// predicates is the only form of the fix that can be PROVEN not to widen the other
// four, and this file is that proof.
// ===========================================================================

const ALL_SLUGS = [...CLIENT_MODULE_SLUGS, ...EXTRA_OWNER_ONLY_SLUGS];

const EXISTING_ROLES = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
] as const;

function navSlugs(role: Role): string[] {
  return navForRole(role).flatMap((g) => g.items.map((i) => i.slug));
}

function allowedSlugs(role: Role): string[] {
  return ALL_SLUGS.filter((slug) => canRoleAccessModule(role, slug));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// THE HARD BASELINE — the exact nav each of the four existing roles had BEFORE
// this change, at commit 68ab0a9. Not a snapshot of "whatever it is now": a
// snapshot absorbs whatever widening ships alongside it, which is precisely the
// failure this file exists to make impossible.
// ---------------------------------------------------------------------------
const BASELINE: Record<(typeof EXISTING_ROLES)[number], string[]> = {
  agency_admin: [
    "", "roi", "reports", "calendar", "patients", "payments", "fp17", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "absence", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_owner: [
    "", "roi", "reports", "calendar", "patients", "payments", "fp17", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "absence", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_coordinator: [
    "", "calendar", "patients", "payments", "fp17", "landing-pages", "smile-assessment",
    "speed-to-lead", "onboarding", "booking", "power-dialler", "task-queue", "recall",
    "reactivation", "treatment-coordinator", "after-hours", "no-show-defence", "reviews",
    "conversations", "booking-agent", "whatsapp", "absence", "staff-check-in", "daily-brief",
    "notifications", "getting-started",
  ],
  client_clinician: ["", "calendar", "patients", "absence", "staff-check-in"],
};

/**
 * ADDED — brand-new modules. Every role that may see a new module is an addition by
 * definition, so these are listed rather than folded into the baseline.
 *
 * - "my-work"     the staff self-service surface (own rota, own holiday, own
 *                 documents, own signatures). Every staff-facing role gets it.
 * - "hours"       Hours & pay: the month's worked hours and their cost. Owner,
 *                 agency and the practice manager, matching absence/check-in.
 * - "staff-hr"    the employee file + document vault. Same three.
 * - "permissions" People & logins. OWNER-ONLY and not negotiable: it is the screen
 *                 that decides who can reach what, so a role that could edit it
 *                 could grant itself anything.
 */
const ADDED: Record<(typeof EXISTING_ROLES)[number], string[]> = {
  agency_admin: ["my-work", "hours", "staff-hr", "permissions"],
  client_owner: ["my-work", "hours", "staff-hr", "permissions"],
  client_coordinator: ["my-work", "hours", "staff-hr"],
  client_clinician: ["my-work"],
};

/**
 * WIDENED — modules that already existed and that a role did NOT have before.
 * These are the two decisions this change makes about the existing four roles, and
 * nothing else moved.
 *
 * - client_coordinator gains "rota". The module's own note says "owners and
 *   managers", but its `roles` array said OWNER_ROLES, so the practice manager —
 *   the rota's primary user — could not open the page or make a single rota API
 *   call. Its two siblings (absence, staff-check-in) were widened for exactly this
 *   reason on 2026-08-03 and the rota was missed. All four rota routes move from
 *   requireOwnerRole to requireApproverRole in the same change (pinned in test 7).
 *
 * - client_clinician gains "my-work". Listed under ADDED above as a new module, and
 *   also a widening of CLINICIAN_SLUGS, which is why it is called out here too: the
 *   clinician's allow-list is the tightest in the platform and adding to it is
 *   never incidental. A clinician is a member of staff; every tab of my-work is
 *   scoped to the caller's OWN staff record, so it grants no data they did not have.
 */
const WIDENED: Partial<Record<(typeof EXISTING_ROLES)[number], string[]>> = {
  client_coordinator: ["rota"],
  client_clinician: [], // "my-work" is counted once, under ADDED
};

/**
 * WIDENED, A LATER LANE — the manager co-pilot (agent expansion, Wave 3 #5).
 *
 * Its own map rather than a line appended to WIDENED above, for the reason this
 * whole file is built the way it is: a delta folded into the layer beneath it
 * stops being a decision anybody can read, and the next reviewer cannot tell
 * which change granted what.
 *
 * - client_coordinator gains "co-pilot". The module was owner-only because the
 *   co-pilot reads across the whole practice and there was no way to give a
 *   manager less of it. There is now: `copilotAccessForRole`
 *   (src/lib/copilot/scope.ts) derives a six-tool operational allow-list from the
 *   SESSION's role, caps her practice-brain clearance at her own tier, and
 *   projects the money out of the patient record — server-side, before the model
 *   is handed a tool schema. Reaching the module stopped being the same question
 *   as reaching the owner's data.
 *
 * The fifth role is untouched: "co-pilot" is not in STAFF_SLUGS, the staff branch
 * returns before this array is read, and test 2 proves it over the full slug list.
 */
const WIDENED_MANAGER_COPILOT: Partial<Record<(typeof EXISTING_ROLES)[number], string[]>> = {
  client_coordinator: ["co-pilot"],
};

/**
 * ADDED, W1-C — the pre-visit triage module (a brand new CLIENT_NAV entry).
 *
 * Its own map rather than a line appended to ADDED above, for the reason this
 * whole file is built the way it is: a delta folded into the layer beneath it
 * stops being a decision anybody can read.
 *
 * The page is the module's ADMIN surface — the two editable question banks, the
 * per-treatment interest lists and the implant-interest list — so it goes to the
 * owner, the agency and the practice manager, who runs the interest follow-ups.
 *
 * BOTH ALLOW-LIST ROLES ARE ABSENT, and the clinician's absence is a decision
 * rather than an oversight. What a clinician needs from this module is the
 * pre-visit summary on the PATIENT RECORD, which is gated on "patients" — a slug
 * they already hold. Putting this slug in CLINICIAN_SLUGS would hand them the
 * editor that decides what every patient in the practice is asked.
 */
const ADDED_PREVISIT: Partial<Record<(typeof EXISTING_ROLES)[number], string[]>> = {
  agency_admin: ["pre-visit-triage"],
  client_owner: ["pre-visit-triage"],
  client_coordinator: ["pre-visit-triage"],
};

/**
 * ADDED, W1-D — the equipment module and the IT desk (two brand new CLIENT_NAV
 * entries).
 *
 * Owner, agency and the practice manager, who keeps the equipment register and
 * fields the front-desk IT problems.
 *
 * BOTH ALLOW-LIST ROLES ARE ABSENT, and for the IT desk that is the line worth
 * reading twice: a nurse who cannot print is precisely the person it would help,
 * and she still does not get it, because widening STAFF_SLUGS is a decision taken
 * on written instruction rather than in passing. The lane's brief says owner +
 * manager. If the practice later wants the receptionist to have the IT desk, that
 * is one line in STAFF_SLUGS and this map, made deliberately.
 */
const ADDED_DESKS: Partial<Record<(typeof EXISTING_ROLES)[number], string[]>> = {
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
const WIDENED_COPILOT_ALL_CLEARANCES: Partial<Record<(typeof EXISTING_ROLES)[number], string[]>> = {
  client_clinician: ["co-pilot"],
};

/** practice-brain is not a CLIENT_NAV module, so it never appears in navForRole. */
const EXTRA_ALLOWED_NOT_IN_NAV: Record<(typeof EXISTING_ROLES)[number], string[]> = {
  agency_admin: ["practice-brain"],
  client_owner: ["practice-brain"],
  client_coordinator: [],
  client_clinician: [],
};

function expected(role: (typeof EXISTING_ROLES)[number]): string[] {
  return [
    ...BASELINE[role],
    ...ADDED[role],
    ...(WIDENED[role] ?? []),
    ...(WIDENED_MANAGER_COPILOT[role] ?? []),
    ...(ADDED_PREVISIT[role] ?? []),
    ...(ADDED_DESKS[role] ?? []),
    ...(WIDENED_COPILOT_ALL_CLEARANCES[role] ?? []),
  ];
}

describe("1. the four existing roles are unchanged apart from the named deltas", () => {
  it.each(EXISTING_ROLES)(
    "%s sees exactly its baseline nav plus the named ADDED/WIDENED slugs, and nothing else",
    (role) => {
      expect(sorted(navSlugs(role))).toEqual(sorted(expected(role)));
    },
  );

  it.each(EXISTING_ROLES)("%s may REACH exactly that same set (nav and predicate agree)", (role) => {
    expect(sorted(allowedSlugs(role))).toEqual(
      sorted([...expected(role), ...EXTRA_ALLOWED_NOT_IN_NAV[role]]),
    );
  });

  it("nothing was taken away from anybody: every baseline slug survives", () => {
    // Stated separately from the equality above because it is the half that matters
    // most in production. An equality failure could be a removal or an addition;
    // this one names removals specifically.
    for (const role of EXISTING_ROLES) {
      for (const slug of BASELINE[role]) {
        expect(canRoleAccessModule(role, slug), `${role} lost ${slug}`).toBe(true);
      }
    }
  });

  it("the staff branch is unreachable for the other four (their path is the old one)", () => {
    // Direct statement of the mechanism: the early return keys on the ROLE only, so
    // for any other role STAFF_SLUGS membership is irrelevant. "payments" is in no
    // allow-list yet is open to three of them; "controls" is in no allow-list and is
    // owner-only. Both answers come from the ORIGINAL rules, not the new branch.
    //
    // ("co-pilot" was the owner-only example here until the manager-co-pilot lane
    // made it shared with the practice manager. "controls" replaces it and is the
    // stronger example anyway: the kill switches never leave the owner.)
    expect(STAFF_SLUGS.has("payments")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "payments")).toBe(true);
    expect(STAFF_SLUGS.has("controls")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "controls")).toBe(false);
    expect(canRoleAccessModule("client_owner", "controls")).toBe(true);
  });
});

describe("2. the staff role is denied every slug outside its allow-list", () => {
  it("iterates the FULL slug list, not a hand-picked sample", () => {
    const denied = ALL_SLUGS.filter((slug) => !STAFF_SLUGS.has(slug));
    // Guards the guard: if the allow-list ever swallowed the nav, this loop would be
    // empty and assert nothing.
    expect(denied.length).toBeGreaterThan(30);
    for (const slug of denied) {
      expect(canRoleAccessModule("client_staff", slug), `staff reached ${slug}`).toBe(false);
    }
  });

  it("and is allowed both slugs that ARE in the allow-list", () => {
    for (const slug of STAFF_SLUGS) {
      expect(canRoleAccessModule("client_staff", slug)).toBe(true);
    }
  });

  it("names the exact three modules a staff login gets", () => {
    // Two until the coordinator's ruling of 3 Sep 2026 added the co-pilot, scoped
    // to a ONE-TOOL catalog that answers about the person signed in. The count is
    // asserted as well as the members so a fourth cannot arrive unnoticed.
    expect(sorted([...STAFF_SLUGS])).toEqual(["", "co-pilot", "my-work"]);
    expect(STAFF_SLUGS.size).toBe(3);
  });

  it("is a subset of CLIENT_MODULE_SLUGS, so neither entry is a typo", () => {
    // A typo'd slug would grant nothing AND hide nothing: the module stays denied
    // and the suite stays green while the staff login silently cannot reach the one
    // page it was given.
    for (const slug of STAFF_SLUGS) expect(CLIENT_MODULE_SLUGS).toContain(slug);
  });
});

describe("3. the staff role never reaches the diary or the patient database", () => {
  // The single most important pair of facts in this file. CLINICIAN_SLUGS grants
  // "calendar" and "patients"; reusing it for a receptionist would have handed over
  // the live diary and 51,000 patient records, and that is the entire reason this is
  // a fifth role rather than a capability set on the fourth.
  it.each(["calendar", "patients"])("cannot reach '%s', which the clinician CAN", (slug) => {
    expect(canRoleAccessModule("client_staff", slug)).toBe(false);
    expect(canRoleAccessModule("client_clinician", slug)).toBe(true);
    expect(CLINICIAN_SLUGS.has(slug)).toBe(true);
    expect(STAFF_SLUGS.has(slug)).toBe(false);
  });

  it("the two allow-lists are genuinely different sets", () => {
    expect(sorted([...CLINICIAN_SLUGS])).not.toEqual(sorted([...STAFF_SLUGS]));
    // They overlap on exactly the three surfaces both roles legitimately share.
    // "co-pilot" joined the overlap on the 3 Sep ruling and is the interesting
    // one: the SLUG is shared and the CATALOG is not — a clinician gets six read
    // tools there and a member of staff gets one. That is the whole design, and
    // it is why a shared slug is not a shared surface.
    const shared = [...STAFF_SLUGS].filter((s) => CLINICIAN_SLUGS.has(s));
    expect(sorted(shared)).toEqual(["", "co-pilot", "my-work"]);
  });
});

describe("4. the staff role is denied every owner-only module and the owner shell extras", () => {
  // "co-pilot" CAME OFF this list on the coordinator's ruling of 3 Sep 2026. It
  // had survived the manager-co-pilot lane because that lane only added the
  // practice manager; the Dental OS ruling gives every clearance a co-pilot, each
  // with its own server-side catalog. What a staff login reaches there is ONE
  // tool about herself (src/lib/copilot/clearance.ts), which is asserted in that
  // lane rather than here — this list is about modules, not about their contents.
  //
  // Everything else on it is unmoved, and the eight remaining lines are the
  // reason removing one entry is not the start of a slide.
  const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "settings", "controls", "permissions"];

  it.each(OWNER_ONLY)("cannot reach '%s'", (slug) => {
    expect(canRoleAccessModule("client_staff", slug)).toBe(false);
    // Control: the owner still can, so this is a role difference and not a slug that
    // has quietly been switched off for everyone.
    expect(canRoleAccessModule("client_owner", slug)).toBe(true);
  });

  it("blocks the EXTRA_OWNER_ONLY_SLUGS path too", () => {
    expect(EXTRA_OWNER_ONLY_SLUGS.has("practice-brain")).toBe(true);
    expect(canRoleAccessModule("client_staff", "practice-brain")).toBe(false);
  });
});

describe("5. an UNKNOWN slug does not fall through to true for the staff role", () => {
  it("refuses a slug that is in no list at all", () => {
    // canRoleAccessModule ends `if (!item) return true` for a slug it cannot find.
    // That fall-through is deliberate for the three open roles (the page itself
    // 404s), but for a deny-by-default role it is a hole wide enough to drive a
    // future module through: any module added without a nav entry would be open.
    for (const slug of ["not-a-real-module", "payroll", "finance/export", "hr/pay-rates"]) {
      expect(canRoleAccessModule("client_staff", slug)).toBe(false);
    }
  });

  it("while the three open roles keep the documented fall-through, unchanged", () => {
    for (const role of ["agency_admin", "client_owner", "client_coordinator"] as const) {
      expect(canRoleAccessModule(role, "not-a-real-module")).toBe(true);
    }
    // ...and the clinician keeps its own deny-by-default, also unchanged.
    expect(canRoleAccessModule("client_clinician", "not-a-real-module")).toBe(false);
  });
});

describe("6. navForRole / categoriesForRole for the staff role", () => {
  it("returns only allow-listed items and drops every emptied group", () => {
    const groups = navForRole("client_staff");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) expect(STAFF_SLUGS.has(item.slug)).toBe(true);
    }
    // The whole allow-list is actually reachable in the nav (nothing stranded).
    expect(sorted(navSlugs("client_staff"))).toEqual(sorted([...STAFF_SLUGS]));
    // And it really is a shrunk nav, not the full one — smaller even than the
    // clinician's, which is the point of the role.
    expect(navSlugs("client_staff").length).toBeLessThan(navSlugs("client_clinician").length);
  });

  it("drops whole groups the staff role has nothing in", () => {
    const staffGroups = navForRole("client_staff").map((g) => g.label);
    const allGroups = CLIENT_NAV.map((g) => g.label);
    expect(staffGroups.length).toBeLessThan(allGroups.length);
    for (const gone of ["Acquisition", "Clinic", "Lifecycle", "Conversational", "Insights"]) {
      expect(staffGroups).not.toContain(gone);
      expect(allGroups).toContain(gone);
    }
  });

  it("the sidebar rail shows the staff role its own two areas and nothing more", () => {
    // One area until the co-pilot joined the allow-list; it lives in the
    // "operations" group of CLIENT_NAV, so the rail now shows two. Both are
    // asserted whole, so a third area, or a stray extra module inside either,
    // fails here rather than appearing quietly in a receptionist's sidebar.
    const cats = categoriesForRole("client_staff");
    expect(cats.map((c) => c.key)).toEqual(["home", "operations"]);
    expect(cats[0].items.map((i) => i.slug)).toEqual(["", "my-work"]);
    expect(cats[1].items.map((i) => i.slug)).toEqual(["co-pilot"]);
  });
});

describe("7. THE ROTA WIDENING, named and pinned at both layers", () => {
  const API_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "app", "api");
  const ROTA_ROUTES = ["rota/staff", "rota/staff/[id]", "rota/generate", "rota/config"];

  function rotaSource(route: string): string {
    return readFileSync(join(API_DIR, route, "route.ts"), "utf8");
  }

  it("the nav entry now names the coordinator", () => {
    const rota = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "rota");
    expect(rota).toBeDefined();
    expect(new Set(rota!.roles)).toEqual(
      new Set(["agency_admin", "client_owner", "client_coordinator"]),
    );
    expect(canRoleAccessModule("client_coordinator", "rota")).toBe(true);
  });

  it.each(ROTA_ROUTES)("/api/%s calls requireApproverRole and no longer requireOwnerRole", (route) => {
    const src = rotaSource(route);
    expect(src).toContain("requireApproverRole(");
    // The page and the API must agree. A nav entry that admits the coordinator on a
    // route that still calls requireOwnerRole is worse than either alone: the module
    // opens, every action 403s, and the screen looks broken rather than forbidden.
    //
    // The CALL, not the bare word: each of these files carries a comment explaining
    // what it was widened FROM, and matching the word alone would fail on the
    // explanation while the code was correct.
    expect(src).not.toContain("requireOwnerRole(");
  });

  it("the widening stops at the approver list: the clinician and the staff role are still refused", () => {
    const staff = user("client_staff");
    expect(requireApproverRole(staff)?.status).toBe(403);
    expect(requireApproverRole(user("client_clinician"))?.status).toBe(403);
    expect(requireApproverRole(user("client_coordinator"))).toBe(null);
    // And the rota module itself stays out of both allow-lists.
    expect(canRoleAccessModule("client_staff", "rota")).toBe(false);
    expect(canRoleAccessModule("client_clinician", "rota")).toBe(false);
  });
});

describe("8. THE CLINICAL-WRITE TIGHTENING, named because a silent narrowing reads as a bug", () => {
  it("requireClinicalWriteRole admits clinician + owner + agency", () => {
    expect(requireClinicalWriteRole(user("client_clinician"))).toBe(null);
    expect(requireClinicalWriteRole(user("client_owner"))).toBe(null);
    expect(requireClinicalWriteRole(user("agency_admin"))).toBe(null);
  });

  it("TIGHTENED: the coordinator loses the clinical WRITE it previously had", () => {
    // Charting a tooth, recording a periodontal finding and signing off a medical
    // history are clinical acts attributed to whoever made them. Before this change
    // /api/charting/draft, /api/perio/[action] and /api/medical-history/[action]
    // accepted a coordinator session on every write. They no longer do — and the
    // coordinator keeps the READ, and keeps patient administration entirely.
    const denied = requireClinicalWriteRole(user("client_coordinator"));
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
    expect(canRoleAccessModule("client_coordinator", "patients")).toBe(true);
  });

  it("and refuses the staff role, like every other patient-record guard", () => {
    expect(requireClinicalWriteRole(user("client_staff"))?.status).toBe(403);
  });

  it("is a no-op when enforcement is off, like every other guard in that file", () => {
    expect(requireClinicalWriteRole(null)).toBe(null);
  });
});

describe("9. the guards that already refused a fifth role still do", () => {
  it("requireOwnerRole gives the staff role a 403", async () => {
    const res = requireOwnerRole(user("client_staff"));
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("and still passes the owner and the agency admin through, unchanged", () => {
    expect(requireOwnerRole(user("client_owner"))).toBeNull();
    expect(requireOwnerRole(user("agency_admin"))).toBeNull();
    expect(requireOwnerRole(user("client_coordinator"))?.status).toBe(403);
  });

  it("the new role was NOT added to the owner list", () => {
    expect(OWNER_ROLES).toEqual(["agency_admin", "client_owner"]);
    expect(OWNER_ROLES).not.toContain("client_staff");
    expect(OWNER_ROLES).not.toContain("client_clinician");
  });
});

describe("10. the four new modules are wired the way the deltas claim", () => {
  const byslug = (slug: string) => CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);

  it("permissions is owner-only", () => {
    expect(new Set(byslug("permissions")!.roles)).toEqual(new Set(OWNER_ROLES));
    for (const role of ["client_coordinator", "client_clinician", "client_staff"] as const) {
      expect(canRoleAccessModule(role, "permissions")).toBe(false);
    }
  });

  it.each(["hours", "staff-hr"])("%s is owner + agency + the practice manager", (slug) => {
    expect(new Set(byslug(slug)!.roles)).toEqual(
      new Set(["agency_admin", "client_owner", "client_coordinator"]),
    );
    expect(canRoleAccessModule("client_coordinator", slug)).toBe(true);
    // NOT the clinician and NOT the staff role: pay and employee files are the
    // manager's, and a staff member sees their own through my-work instead.
    expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    expect(canRoleAccessModule("client_staff", slug)).toBe(false);
  });

  it("my-work is reachable by every staff-facing role, through whichever mechanism governs it", () => {
    for (const role of [
      "agency_admin",
      "client_owner",
      "client_coordinator",
      "client_clinician",
      "client_staff",
    ] as const) {
      expect(canRoleAccessModule(role, "my-work"), `${role} cannot reach my-work`).toBe(true);
    }
    // The `roles` array is documentary for the two allow-list roles, so assert the
    // allow-lists themselves rather than trusting the array to be doing the work.
    expect(CLINICIAN_SLUGS.has("my-work")).toBe(true);
    expect(STAFF_SLUGS.has("my-work")).toBe(true);
  });

  it("every new module is a real CLIENT_NAV item with a label and an icon", () => {
    for (const slug of ["permissions", "my-work", "hours", "staff-hr"]) {
      const item = byslug(slug);
      expect(item, `${slug} missing from CLIENT_NAV`).toBeDefined();
      expect(item!.label.length).toBeGreaterThan(0);
      expect(item!.icon).toBeDefined();
    }
  });
});

/** One representative AuthedUser per role, for the guard tests above. */
function user(role: Role): AuthedUser {
  return {
    id: `user-${role}`,
    name: "Test",
    email: "t@example.com",
    role,
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
}
