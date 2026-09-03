import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

// nav.ts pulls in lucide-react and a server-only transitive through the guard it
// sits beside; tools.ts reaches the speed-to-lead contact path, which opens with
// `import "server-only"`. Stubbing it is the standard escape hatch here
// (nav.clinician.test.ts:8, scope.test.ts:9) and it is exactly what the module
// is on the server.
vi.mock("server-only", () => ({}));

import type { Role } from "@/lib/types";
import { ALL_ROLES } from "@/lib/capabilities/defaults";
import { ROLE_DEFAULTS } from "@/lib/capabilities/defaults";
import { resolveCapabilities } from "@/lib/capabilities/resolve";
import { maxTierForRole } from "@/lib/practice-brain/clearance";
import { CLINICIAN_SLUGS, STAFF_SLUGS, canRoleAccessModule, indexRedirectFor } from "@/lib/nav";
import { COPILOT_TOOLS } from "./tools";
import {
  ACCESS_DOMAINS,
  ACT_DOMAINS,
  COPILOT_ACCESS_LEVELS,
  COPILOT_TOOL_NAMES,
  READ_DOMAINS,
  TOOL_CATALOG,
  TOOL_DOMAIN,
  accessHoldsToolDomain,
  catalogAllows,
  type ActDomain,
  type CopilotAccess,
  type CopilotToolName,
  type ReadDomain,
} from "./clearance";
import { copilotAccessForRole, copilotClearanceForRole, copilotKnowledgeTier, copilotToolsFor } from "./scope";

// ===========================================================================
// THE CLEARANCE MODEL, PROVEN BY ENUMERATION.
//
// The claims this file has to establish are NEGATIVE ones — "the practice
// manager cannot reach money", "a receptionist cannot reach a patient" — and a
// negative is never proven by trying six questions and being refused. So almost
// everything here crosses EVERY access level with EVERY tool, over the REAL
// COPILOT_TOOLS array and the REAL role constants, rather than over a list
// retyped in this file. A tool written tomorrow is in these tests the moment it
// is written.
//
// Seven parts:
//   1. totality — the tables cover every level, every tool, every domain;
//   2. the catalog — derived, and exactly what each level should hold;
//   3. THE NON-WIDENING SNAPSHOT — a baseline plus NAMED deltas, so a widening
//      committed alongside this file cannot be absorbed silently;
//   4. the manager's five closed doors, one test each;
//   5. staff and clinician: what they are, and what they emphatically are not;
//   6. composition — the capability layer, the module lock and the kill switch
//      all still sit around this and none of them was widened by it;
//   7. the wiring — the model really is what the schema filter and the gate use.
// ===========================================================================

const OWNER_ROLES: Role[] = ["agency_admin", "client_owner"];
const ALL_TOOL_NAMES = COPILOT_TOOLS.map((t) => t.name);

describe("1. the tables are total", () => {
  it("names every access level exactly once", () => {
    expect([...COPILOT_ACCESS_LEVELS].sort()).toEqual([
      "clinician",
      "full",
      "manager",
      "none",
      "staff",
    ]);
    expect(new Set(COPILOT_ACCESS_LEVELS).size).toBe(COPILOT_ACCESS_LEVELS.length);
    // And every one of them has a row. A level added to the union but not to
    // ACCESS_DOMAINS is a tsc error; this is the runtime half of the same claim.
    for (const level of COPILOT_ACCESS_LEVELS) {
      expect(ACCESS_DOMAINS[level], `${level} has no clearance row`).toBeDefined();
      expect(ACCESS_DOMAINS[level].summary.length, `${level} has no summary`).toBeGreaterThan(20);
    }
  });

  it("files every REAL tool under exactly one domain, and invents none", () => {
    // Both directions. A tool in the array with no domain would run unclassified;
    // a name in the model with no tool behind it is a stale rule that reads as a
    // grant. `CopilotToolName` makes the first a compile error inside tools.ts —
    // this is the assertion that the two lists are the same set at runtime too.
    expect([...COPILOT_TOOL_NAMES].sort()).toEqual([...ALL_TOOL_NAMES].sort());
    for (const name of COPILOT_TOOL_NAMES) {
      expect(TOOL_DOMAIN[name], `${name} is filed under no domain`).toBeDefined();
    }
    expect(Object.keys(TOOL_DOMAIN).sort()).toEqual([...COPILOT_TOOL_NAMES].sort());
  });

  it("every domain a tool names is a declared domain", () => {
    const reads = new Set<string>(READ_DOMAINS);
    const acts = new Set<string>(ACT_DOMAINS);
    for (const name of COPILOT_TOOL_NAMES) {
      const d = TOOL_DOMAIN[name];
      const known = d.kind === "read" ? reads.has(d.domain) : acts.has(d.domain);
      expect(known, `${name} names an undeclared ${d.kind} domain "${d.domain}"`).toBe(true);
    }
  });

  it("every domain a level holds is a declared domain", () => {
    const reads = new Set<string>(READ_DOMAINS);
    const acts = new Set<string>(ACT_DOMAINS);
    for (const level of COPILOT_ACCESS_LEVELS) {
      for (const d of ACCESS_DOMAINS[level].reads) {
        expect(reads.has(d), `${level} holds undeclared read domain "${d}"`).toBe(true);
      }
      for (const d of ACCESS_DOMAINS[level].acts) {
        expect(acts.has(d), `${level} holds undeclared act domain "${d}"`).toBe(true);
      }
    }
  });

  it("declares the domains that have no tool yet, which is the point of declaring them", () => {
    // A model that can only talk about subjects it already has a tool for cannot
    // say "a manager may not reach the system controls" until somebody writes a
    // controls tool — and on that day the answer gets decided by whoever writes
    // it. These are the wave-2 extension points, and they are all owner-only.
    const covered = new Set(Object.values(TOOL_DOMAIN).map((d) => d.domain));
    const unimplementedReads = READ_DOMAINS.filter((d) => !covered.has(d));
    const unimplementedActs = ACT_DOMAINS.filter((d) => !covered.has(d));
    // WAVE 2, LANE A IS THE MECHANISM'S FIRST REAL TEST, and it passed: three of
    // the seven declared-and-toolless domains (agent-status, controls,
    // diary-write) got a tool this wave and every one of them landed OWNER-ONLY
    // without anybody re-deciding, because the decision was already written down.
    // Four remain, and they are still owner-only:
    //   reports        business performance, ROI, UDA. No tool yet.
    //   hr             other people's rota, hours, pay and documents.
    //   compliance     CQC/GDC readiness, audits, the training matrix.
    //   task-create    DELIBERATELY still toolless: the task queue is COMPUTED
    //                  (src/lib/task-queue/generate.ts computes candidates on
    //                  read and stores none; task_overlay persists only the
    //                  done/snoozed/assigned state of a computed task). There is
    //                  no authored-task write path to route a tool through, so a
    //                  `create_task` would have had to invent a table. The domain
    //                  stays declared so the answer for the manager is already
    //                  written on the day one exists.
    expect(unimplementedReads).toEqual(["reports", "hr", "compliance"]);
    expect(unimplementedActs).toEqual(["task-create"]);
    // Held by the owner and by nobody else, so the day a tool lands in one of
    // them it lands owner-only rather than wherever it fell.
    for (const level of COPILOT_ACCESS_LEVELS) {
      if (level === "full") continue;
      for (const d of unimplementedReads) {
        expect(ACCESS_DOMAINS[level].reads as readonly string[], `${level} holds ${d}`).not.toContain(d);
      }
      for (const d of unimplementedActs) {
        expect(ACCESS_DOMAINS[level].acts as readonly string[], `${level} holds ${d}`).not.toContain(d);
      }
    }
  });

  it("maps every role to a level, and the map is exhaustive", () => {
    const mapped = Object.fromEntries(ALL_ROLES.map((r) => [r, copilotAccessForRole(r)]));
    expect(mapped).toEqual({
      agency_admin: "full",
      client_owner: "full",
      client_coordinator: "manager",
      client_clinician: "clinician",
      client_staff: "staff",
    });
  });
});

describe("2. the catalog is derived, and it is what it should be", () => {
  it("hands the owner every tool there is", () => {
    expect([...TOOL_CATALOG.full].sort()).toEqual([...COPILOT_TOOL_NAMES].sort());
  });

  it("hands the manager exactly ten, named", () => {
    expect([...TOOL_CATALOG.manager].sort()).toEqual([
      "appointments",
      "equipment_lookup",
      "interest_lists",
      "it_desk",
      "list_recent_assessment_leads",
      "list_speed_to_lead",
      "patient_record",
      "previsit_summary",
      "search_knowledge",
      "search_patients",
    ]);
  });

  it("hands the clinician their patients, their diary, the brain, their own work, second opinion and the pre-visit answers", () => {
    expect([...TOOL_CATALOG.clinician].sort()).toEqual([
      "appointments",
      "equipment_lookup",
      "it_desk",
      "my_work",
      "patient_record",
      "previsit_summary",
      "search_knowledge",
      "search_patients",
      "second_opinion",
    ]);
  });

  it("hands a member of staff THREE tools: their own work, and the two desks", () => {
    // ONE until ruling W2-A/1. The exact set is spelled out rather than derived,
    // so a fourth has to be typed here by somebody who meant it.
    expect([...TOOL_CATALOG.staff].sort()).toEqual(["equipment_lookup", "it_desk", "my_work"]);
  });

  it("hands 'none' nothing at all, over the whole tool list", () => {
    expect([...TOOL_CATALOG.none]).toEqual([]);
    for (const name of ALL_TOOL_NAMES) expect(catalogAllows("none", name)).toBe(false);
    expect(copilotToolsFor("none", COPILOT_TOOLS)).toEqual([]);
  });

  it("is an ALLOW-list: a tool nobody has written yet is already denied to everyone but the owner", () => {
    for (const level of COPILOT_ACCESS_LEVELS) {
      const expected = level === "full";
      expect(catalogAllows(level, "read_takings"), level).toBe(expected);
      expect(catalogAllows(level, "some_tool_written_next_year"), level).toBe(expected);
      // Prototype keys are not tool names either: a Set has no prototype chain to
      // walk, which is the same hole `copilotAccessForRole` closed with a Map.
      expect(catalogAllows(level, "constructor"), level).toBe(expected);
      expect(catalogAllows(level, "toString"), level).toBe(expected);
    }
  });

  it("the owner's permissive shortcut and the owner's catalog agree on every REAL name", () => {
    // `catalogAllows("full", x)` short-circuits to true so an unknown name still
    // falls to the dispatch's own "unknown tool" answer, exactly as it always
    // did. That shortcut is only safe while the owner genuinely holds every
    // domain, so that is what is asserted rather than assumed.
    for (const name of COPILOT_TOOL_NAMES) {
      expect(accessHoldsToolDomain("full", name), `owner does not hold ${name}`).toBe(true);
    }
  });

  it("the predicate reads only (level, name) — there is nothing for an injected instruction to reach", () => {
    expect(catalogAllows.length).toBe(2);
    for (const name of ALL_TOOL_NAMES) {
      const first = catalogAllows("staff", name);
      for (let i = 0; i < 10; i += 1) expect(catalogAllows("staff", name)).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. THE NON-WIDENING SNAPSHOT
//
// Modelled on capabilities/non-widening.test.ts, which got this right: a BARE
// snapshot ("assert the catalog equals whatever the catalog is") pins nothing,
// because it absorbs any widening committed alongside it. So this is a BASELINE
// plus NAMED DELTAS, and the assertion is the equation.
// ---------------------------------------------------------------------------

/** What each level could run BEFORE this lane, at commit 6b93b40. */
const BEFORE: Record<string, CopilotToolName[]> = {
  full: [
    "patient_record",
    "search_patients",
    "appointments",
    "outstanding_balances",
    "practice_overview",
    "search_knowledge",
    "list_recent_assessment_leads",
    "list_speed_to_lead",
    "assessment_dropoff_summary",
    "send_sms",
    "send_email",
    "create_outreach_campaign",
    "launch_outreach_campaign",
    "create_landing_page",
    "launch_landing_page",
    "create_meta_campaign",
    "publish_meta_campaign",
    "create_patient",
    "nudge_lead",
  ],
  manager: [
    "appointments",
    "search_patients",
    "patient_record",
    "search_knowledge",
    "list_recent_assessment_leads",
    "list_speed_to_lead",
  ],
  // Both levels did not exist: `client_clinician` and `client_staff` mapped to
  // "none" and had no co-pilot at all.
  clinician: [],
  staff: [],
  none: [],
};

/**
 * What W1-E deliberately gave, with the reason. UNCHANGED BY WAVE 2 — this is the
 * clearance lane's own delta and it stays exactly as that lane left it, so its
 * claim ("the practice manager gained nothing at all") can still be read and
 * checked a year from now rather than being absorbed into a running total.
 */
const WIDENED_W1E: Record<string, CopilotToolName[]> = {
  // Two new tools, and the owner holds every domain, so the owner gets both.
  full: ["second_opinion", "my_work"],
  // NOTHING. The whole claim of this lane about the practice manager.
  manager: [],
  // The clinician level, created by the charter (section 2, W1-E). Every entry
  // is a READ the clinician's own nav already grants them on screen, plus the
  // two things this lane built.
  clinician: [
    "patient_record",
    "search_patients",
    "appointments",
    "search_knowledge",
    "second_opinion",
    "my_work",
  ],
  // The staff level. One tool, about themselves, through the self-service seam.
  staff: ["my_work"],
  none: [],
};

/**
 * WHAT WAVE 2, LANE A DELIBERATELY GIVES. Seven tools, and the placement of every
 * one of them was decided before the tool existed:
 *
 *   agent_status   read `agent-status`   — declared owner-only by W1-E and by the
 *                                          programme decisions log. The manager
 *                                          asking "is the recall agent running"
 *                                          is asking about System controls, which
 *                                          her nav does not give her either.
 *   sync_status    read `controls`       — same ruling, same domain. It reports
 *                                          the master Dentally write-back switch,
 *                                          which is the definition of a control.
 *   previsit_summary read `patients`     — one patient's record, so every login
 *                                          that holds `patients` gets it. The
 *                                          SYMPTOM half is projected inside the
 *                                          tool by the triage module's own
 *                                          CLINICAL_SUMMARY_ROLES (W1-C/2), which
 *                                          is a narrower rule applied ON TOP of
 *                                          this one, never instead of it.
 *   interest_lists read `leads`          — the acquisition pipeline, which the
 *                                          manager already holds.
 *   equipment_lookup read `equipment`    — a NEW domain, granted to owner and
 *                                          manager to match the module's own nav
 *                                          entry and the charter's W1-D line.
 *   it_desk        read `it-desk`        — a NEW domain, same two roles, same two
 *                                          reasons.
 *   diary_write    act `diary-write`     — declared owner-only by W1-E. The
 *                                          riskiest tool in the wave landed in
 *                                          the narrowest place, without a
 *                                          judgement call being made under
 *                                          pressure, which is what declaring the
 *                                          domain early was for.
 *
 * THE CLINICIAN AND STAFF ROWS. The clinician gains `previsit_summary` and
 * nothing else, because `patients` is a domain they already held; staff gain
 * NOTHING, because `self` is still the only domain on their row.
 */
const WIDENED_W2A: Record<string, CopilotToolName[]> = {
  full: [
    "agent_status",
    "sync_status",
    "previsit_summary",
    "interest_lists",
    "equipment_lookup",
    "it_desk",
    "diary_write",
  ],
  manager: ["previsit_summary", "interest_lists", "equipment_lookup", "it_desk"],
  // RULING W2-A/1 (the programme coordinator, 3 Sep 2026): the two desks widen to
  // EVERY clearance. The clinician therefore gains three, not one.
  clinician: ["previsit_summary", "equipment_lookup", "it_desk"],
  // ...and the staff row, which had gained nothing from this lane, gains the two
  // desks. It is the row the ruling was asked for: a dental nurse is a
  // `client_staff` login and those are her two questions. She gains NO patient
  // data, NO diary and NO knowledge — asserted by enumeration below.
  staff: ["equipment_lookup", "it_desk"],
  none: [],
};

/**
 * The two deltas, composed. The equation the tests below assert is
 * `(BEFORE - TIGHTENED) + WIDENED_W1E + WIDENED_W2A`, so each lane's own claim
 * survives as a readable list and neither can absorb the other's widening.
 */
const WIDENED: Record<string, CopilotToolName[]> = Object.fromEntries(
  COPILOT_ACCESS_LEVELS.map((level) => [level, [...WIDENED_W1E[level], ...WIDENED_W2A[level]]]),
) as Record<string, CopilotToolName[]>;

/** What this lane deliberately TAKES AWAY. Nothing, and that is asserted. */
const TIGHTENED: Record<string, CopilotToolName[]> = {
  full: [],
  manager: [],
  clinician: [],
  staff: [],
  none: [],
};

describe("3. the non-widening snapshot", () => {
  it.each(COPILOT_ACCESS_LEVELS)("%s holds exactly (before - tightened) + widened", (level) => {
    const expected = new Set<string>(BEFORE[level]);
    for (const k of TIGHTENED[level]) expected.delete(k);
    for (const k of WIDENED[level]) expected.add(k);
    expect([...TOOL_CATALOG[level]].sort()).toEqual([...expected].sort());
  });

  it("no level gained anything that is not named in WIDENED", () => {
    for (const level of COPILOT_ACCESS_LEVELS) {
      const before = new Set<string>(BEFORE[level]);
      const gained = TOOL_CATALOG[level].filter((n) => !before.has(n));
      expect([...gained].sort(), `${level} gained tools not named in WIDENED`).toEqual(
        [...WIDENED[level]].sort(),
      );
    }
  });

  it("no level lost anything, and nothing is claimed as tightened that was not", () => {
    for (const level of COPILOT_ACCESS_LEVELS) {
      const now = new Set<string>(TOOL_CATALOG[level]);
      const lost = BEFORE[level].filter((n) => !now.has(n));
      expect([...lost].sort(), `${level} lost tools`).toEqual([...TIGHTENED[level]].sort());
    }
  });

  it("THE PRACTICE MANAGER GAINED NOTHING AT ALL FROM THE CLEARANCE LANE", () => {
    // Stated on its own line because it is the claim the owner asked for, and a
    // claim buried inside an it.each is a claim nobody reads in a failure log.
    // It is about W1-E and it is still true: that lane, which opened the co-pilot
    // to two new logins, handed the practice manager not one extra tool.
    expect(WIDENED_W1E.manager).toEqual([]);
  });

  it("and from WAVE 2, LANE A she gained exactly four, each one named", () => {
    // The second lane DID widen her, so the claim is restated as an equation
    // rather than quietly dropped. Four tools, every one of them a subject she
    // already works in on a screen she already has.
    expect([...WIDENED_W2A.manager].sort()).toEqual([
      "equipment_lookup",
      "interest_lists",
      "it_desk",
      "previsit_summary",
    ]);
    const before = new Set<string>(BEFORE.manager);
    expect([...TOOL_CATALOG.manager].filter((n) => !before.has(n)).sort()).toEqual(
      [...WIDENED_W2A.manager].sort(),
    );
    // AND THE DOORS THAT STAYED SHUT. Money, reports, marketing performance, the
    // controls and every act: this lane wrote a tool in two of those subjects
    // (agent_status and sync_status are both `controls`-adjacent, diary_write is
    // an act) and she reached none of them.
    for (const name of ["agent_status", "sync_status", "diary_write"] as const) {
      expect(catalogAllows("manager", name), `manager reached ${name}`).toBe(false);
    }
  });

  it("STAFF GAINED EXACTLY THE TWO DESKS, and the exact set is pinned", () => {
    // The row gained nothing from W1-E and nothing from the first cut of this
    // lane; ruling W2-A/1 gave it the two desks and NOTHING else. Stated as the
    // equation, and then as the literal set, because this is the row where an
    // accidental extra grant would be a patient-data leak.
    expect([...WIDENED_W2A.staff].sort()).toEqual(["equipment_lookup", "it_desk"]);
    expect(WIDENED_W1E.staff).toEqual(["my_work"]);
    expect([...TOOL_CATALOG.staff].sort()).toEqual(["equipment_lookup", "it_desk", "my_work"]);
    // AND THE DOORS THAT STAYED SHUT, over the WHOLE toolbox rather than a
    // sample: everything that is not one of those three is denied.
    const held = new Set<string>(TOOL_CATALOG.staff);
    for (const name of COPILOT_TOOL_NAMES) {
      if (held.has(name)) continue;
      expect(catalogAllows("staff", name), `staff reached ${name}`).toBe(false);
    }
  });

  it("THE CLINICIAN GAINED THREE, and the exact set is pinned", () => {
    expect([...WIDENED_W2A.clinician].sort()).toEqual([
      "equipment_lookup",
      "it_desk",
      "previsit_summary",
    ]);
    expect([...TOOL_CATALOG.clinician].sort()).toEqual([
      "appointments",
      "equipment_lookup",
      "it_desk",
      "my_work",
      "patient_record",
      "previsit_summary",
      "search_knowledge",
      "search_patients",
      "second_opinion",
    ]);
    const held = new Set<string>(TOOL_CATALOG.clinician);
    for (const name of COPILOT_TOOL_NAMES) {
      if (held.has(name)) continue;
      expect(catalogAllows("clinician", name), `clinician reached ${name}`).toBe(false);
    }
  });

  it("the two desks are the ONLY domains held by every clearance that has any", () => {
    // The shape ruling W2-A/1 created, stated once: `equipment` and `it-desk` are
    // now universal, and nothing else is. If a future edit made `patients` or
    // `money` universal by copying this pattern, this goes red.
    const levels = COPILOT_ACCESS_LEVELS.filter((l) => l !== "none");
    const universal = READ_DOMAINS.filter((d) =>
      levels.every((l) => (ACCESS_DOMAINS[l].reads as readonly string[]).includes(d)),
    );
    expect(universal.sort()).toEqual(["equipment", "it-desk"]);
    // 'none' still holds nothing at all, desks included.
    expect(ACCESS_DOMAINS.none.reads).toEqual([]);
    expect(catalogAllows("none", "equipment_lookup")).toBe(false);
    expect(catalogAllows("none", "it_desk")).toBe(false);
  });

  it("is not vacuous: the baseline is the real nineteen and the levels really differ", () => {
    expect(BEFORE.full).toHaveLength(19);
    expect(TOOL_CATALOG.full.length).toBeGreaterThan(TOOL_CATALOG.manager.length);
    expect(TOOL_CATALOG.manager.length).toBeGreaterThan(TOOL_CATALOG.staff.length);
    expect(TOOL_CATALOG.staff.length).toBeGreaterThan(TOOL_CATALOG.none.length);
  });
});

// ---------------------------------------------------------------------------
// 4. THE MANAGER'S FIVE CLOSED DOORS
// ---------------------------------------------------------------------------

/**
 * The doors, as DOMAINS rather than as tool names, which is the whole reason the
 * model is domain-shaped: "she cannot reach money" has to stay true when the
 * money tool is renamed, split, or replaced by three of them.
 */
const MANAGER_CLOSED_READS: ReadDomain[] = ["money", "reports", "marketing", "controls"];

describe("4. the practice manager's closed doors", () => {
  it.each(MANAGER_CLOSED_READS)("cannot reach %s, as a domain", (domain) => {
    expect(ACCESS_DOMAINS.manager.reads as readonly string[]).not.toContain(domain);
    // ...and therefore cannot run any tool that reaches it, whatever it is called.
    for (const name of COPILOT_TOOL_NAMES) {
      const d = TOOL_DOMAIN[name];
      if (d.kind === "read" && d.domain === domain) {
        expect(catalogAllows("manager", name), `manager can run ${name}`).toBe(false);
      }
    }
  });

  it("cannot send anything to a patient, by any tool, under any name", () => {
    // The fifth door, and the one with real-world consequences: a message that
    // went out cannot be unsent. Asserted over the ACT domain rather than over a
    // list of send tools, so a sixth send tool is covered on the day it is
    // written.
    expect(ACCESS_DOMAINS.manager.acts).toEqual([]);
    for (const name of COPILOT_TOOL_NAMES) {
      if (TOOL_DOMAIN[name].kind !== "act") continue;
      expect(catalogAllows("manager", name), `manager can act with ${name}`).toBe(false);
    }
  });

  it("holds no ACT domain at all — read-only is a property, not a list", () => {
    // A read-only claim that has to be argued tool by tool is a claim that will
    // be wrong one day. This is the one-line version.
    for (const level of ["manager", "clinician", "staff", "none"] as CopilotAccess[]) {
      expect(ACCESS_DOMAINS[level].acts, `${level} holds an act domain`).toEqual([]);
    }
    expect(ACCESS_DOMAINS.full.acts.length).toBe(ACT_DOMAINS.length);
  });

  it("is never SHOWN a tool she may not run", () => {
    const shown = copilotToolsFor("manager", COPILOT_TOOLS).map((t) => t.name);
    expect(shown.sort()).toEqual([...TOOL_CATALOG.manager].sort());
    expect(shown).toHaveLength(10);
    // And the schemas handed over are the REAL objects, not copies.
    for (const tool of copilotToolsFor("manager", COPILOT_TOOLS)) {
      expect(COPILOT_TOOLS).toContain(tool);
    }
  });

  it("the nav's own description of her login and this model agree", () => {
    // The nav documents the manager as an operational login without money,
    // reports, marketing or the controls. If either side is edited alone this
    // fails. Read from the REAL nav predicate, never retyped.
    const denied = copilotClearanceForRole("client_coordinator").deniedReads;
    expect(denied).toEqual(expect.arrayContaining(MANAGER_CLOSED_READS));
    for (const slug of ["roi", "reports", "settings"]) {
      expect(canRoleAccessModule("client_coordinator", slug), `nav gives her ${slug}`).toBe(false);
    }
  });
});

describe("5. the clinician and the member of staff", () => {
  it("a member of staff reaches NOTHING about a patient, the diary or the practice", () => {
    const forbidden: ReadDomain[] = [
      "patients",
      "diary",
      "money",
      "reports",
      "marketing",
      "leads",
      "knowledge",
      "agent-status",
      "hr",
      "compliance",
      "controls",
      "clinical-support",
    ];
    for (const d of forbidden) {
      expect(ACCESS_DOMAINS.staff.reads as readonly string[], `staff holds ${d}`).not.toContain(d);
    }
    // Three domains since ruling W2-A/1, and the two new ones are exactly the two
    // that hold no patient data, no diary and no figure.
    expect([...ACCESS_DOMAINS.staff.reads].sort()).toEqual(["equipment", "it-desk", "self"]);
  });

  it("a member of staff is shown three tools, and my_work still takes no staff id", () => {
    const shown = copilotToolsFor("staff", COPILOT_TOOLS);
    expect(shown.map((t) => t.name).sort()).toEqual(["equipment_lookup", "it_desk", "my_work"]);
    // THE SELF-SERVICE RULE, checked on the schema itself: a tool that accepted a
    // staff id, a name or an email would be a tool a model could be talked into
    // pointing at a colleague. There is no such property to fill in.
    const myWork = shown.find((t) => t.name === "my_work")!;
    const props = Object.keys(
      (myWork.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(props.sort()).toEqual(["days", "section"]);
    for (const forbidden of ["staffId", "staff", "name", "email", "person", "who"]) {
      expect(props, `my_work accepts ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("a clinician reaches no money, no leads, no marketing and no action", () => {
    for (const d of ["money", "leads", "marketing", "reports", "controls", "hr", "compliance"] as ReadDomain[]) {
      expect(ACCESS_DOMAINS.clinician.reads as readonly string[], `clinician holds ${d}`).not.toContain(d);
    }
    for (const d of ACT_DOMAINS as readonly ActDomain[]) {
      expect(ACCESS_DOMAINS.clinician.acts as readonly string[], `clinician holds ${d}`).not.toContain(d);
    }
  });

  it("second opinion is the CLINICIAN's, and it is not the front desk's", () => {
    expect(catalogAllows("clinician", "second_opinion")).toBe(true);
    expect(catalogAllows("full", "second_opinion")).toBe(true);
    expect(catalogAllows("manager", "second_opinion")).toBe(false);
    expect(catalogAllows("staff", "second_opinion")).toBe(false);
    expect(catalogAllows("none", "second_opinion")).toBe(false);
  });
});

describe("6. it composes with the three locks around it, and widened none of them", () => {
  it("the practice-brain tier drops with the level and NEVER exceeds the role's tier elsewhere", () => {
    expect(copilotKnowledgeTier("full")).toBe(4);
    expect(copilotKnowledgeTier("manager")).toBe(2);
    expect(copilotKnowledgeTier("clinician")).toBe(1);
    expect(copilotKnowledgeTier("staff")).toBe(1);
    expect(copilotKnowledgeTier("none")).toBe(1);
    // Imported, never retyped: the co-pilot must not be the one surface where a
    // role reads above the clearance it has everywhere else in the platform.
    for (const role of ALL_ROLES) {
      const here = copilotKnowledgeTier(copilotAccessForRole(role));
      expect(here, `${role} reads above its platform tier in the co-pilot`).toBeLessThanOrEqual(
        maxTierForRole(role),
      );
    }
  });

  it("THE DOOR IS OPEN TO ALL FIVE, on the coordinator's ruling of 3 Sep 2026", () => {
    // This test used to assert the OPPOSITE — that "co-pilot" was in neither
    // allow-list, so the clinician and staff catalogs were declared and inert. The
    // ruling switched them on, and the assertion is inverted rather than deleted,
    // because what matters is that the nav and this model never disagree about
    // who gets in. Asserted against the REAL nav, never against a comment.
    expect(CLINICIAN_SLUGS.has("co-pilot")).toBe(true);
    expect(STAFF_SLUGS.has("co-pilot")).toBe(true);
    for (const role of ALL_ROLES) {
      expect(canRoleAccessModule(role, "co-pilot"), `${role} cannot reach the co-pilot`).toBe(true);
    }
  });

  it("opening the door widened WHO MAY ASK and not what any answer contains", () => {
    // The load-bearing half of the ruling. `system.copilot.ask` is checked by the
    // route before a turn starts and now every role holds it — and the catalogs
    // are untouched by that, which is the whole reason the widening was safe to
    // make in one line. The staff member who may now ask still reaches ONE tool.
    for (const role of ALL_ROLES) {
      expect(ROLE_DEFAULTS[role].has("system.copilot.ask"), `${role} may not ask`).toBe(true);
    }
    expect([...TOOL_CATALOG.staff].sort()).toEqual(["equipment_lookup", "it_desk", "my_work"]);
    // The manager's surface is what W1-E left plus the four wave-2 tools that
    // were named for her, and nothing else — asserted as the equation rather than
    // as a bare list, so a fifth cannot arrive with a green suite.
    expect([...TOOL_CATALOG.manager].sort()).toEqual(
      [...BEFORE.manager, ...WIDENED_W2A.manager].sort(),
    );
    expect(TOOL_CATALOG.clinician).not.toContain("outstanding_balances");
  });

  it("the staff index redirect still holds, so the takings are never even fetched", () => {
    // The property `indexRedirectFor` exists for: a receptionist who lands on
    // /c/<client> is forwarded to My work BEFORE any dashboard read runs, so the
    // practice's numbers are not fetched for a role that may not see them.
    // Granting her the co-pilot slug must not, and does not, touch it — the
    // redirect keys off the ROLE, not off the allow-list.
    expect(indexRedirectFor("client_staff", "vitality")).toBe("/c/vitality/my-work");
    for (const role of ALL_ROLES) {
      if (role === "client_staff") continue;
      expect(indexRedirectFor(role, "vitality"), `${role} was redirected`).toBeNull();
    }
  });

  it("a per-person override still applies on top, in both directions", () => {
    // The capability layer is an OVERLAY, not something this model replaces. An
    // owner can take the co-pilot off a named manager, and can hand it to a named
    // clinician — and neither act changes what the level reaches, which is the
    // separation of concerns the whole design rests on.
    const revoked = resolveCapabilities("client_coordinator", [
      { capability: "system.copilot.ask", granted: false },
    ]);
    expect(revoked.has("system.copilot.ask")).toBe(false);

    const granted = resolveCapabilities("client_clinician", [
      { capability: "system.copilot.ask", granted: true },
    ]);
    expect(granted.has("system.copilot.ask")).toBe(true);
    // ...and she STILL only gets the clinician catalog, not the owner's.
    expect([...TOOL_CATALOG.clinician]).not.toContain("outstanding_balances");
  });

  it("the reachable-today flag says exactly who can get in", () => {
    const reachable = ALL_ROLES.filter((r) => copilotClearanceForRole(r).reachableToday);
    expect(reachable.sort()).toEqual([
      "agency_admin",
      "client_clinician",
      "client_coordinator",
      "client_owner",
      "client_staff",
    ]);
    // The flag is not decoration: it must agree with the nav, which is the thing
    // that actually refuses them.
    for (const role of ALL_ROLES) {
      expect(
        copilotClearanceForRole(role).reachableToday,
        `${role}: the flag and the nav disagree`,
      ).toBe(canRoleAccessModule(role, "co-pilot"));
    }
  });
});

describe("7. it stays safe to import from a browser bundle", () => {
  // WHY THIS MATTERS AND WHY IT IS NOT OBVIOUS. `copilot-thread.ts` derives the
  // starter buttons from `catalogAllows`, and that file is imported by client
  // components — so this module now ships in an authenticated browser chunk. Two
  // consequences, and this pins both:
  //
  //   * it must stay PURE. The day somebody adds `import "server-only"`, a DB
  //     client or an env read here, the build breaks in a way whose error message
  //     will point at a React component and not at this file.
  //   * what ships is POLICY, not data: tool names and which login holds which
  //     subject. No patient, no figure, no key, and nothing a holder of that
  //     login could not learn by asking their own co-pilot a question. The
  //     enforcement is the server's; this is a description of it.
  const source = readFileSync(new URL("./clearance.ts", import.meta.url), "utf8");

  it("imports nothing that cannot run in a browser", () => {
    expect(source).not.toMatch(/import\s+"server-only"/);
    expect(source).not.toMatch(/from "@\/lib\/supabase/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/@anthropic-ai/);
    // Its only imports are TYPES, which vanish at build time.
    const imports = [...source.matchAll(/^import\s+(.+?)\s+from/gm)].map((m) => m[1]);
    for (const i of imports) {
      expect(i.startsWith("type "), `clearance.ts has a value import: ${i}`).toBe(true);
    }
  });

  it("carries no credential and no practice data", () => {
    // Word-bounded: an unanchored /sk-/ matches the word "risk-scoring" in a
    // comment, and a guard that cries wolf gets deleted rather than fixed.
    expect(source).not.toMatch(/\bsk-[A-Za-z0-9]{8}|\bapi[_-]?key\b|\bsecret\b|\bpassword\b|\bBearer\b/i);
    // No practice data of any kind: this is a description of a permission model.
    expect(source).not.toMatch(/@[a-z0-9.-]+\.(com|co\.uk|org)/i);
    expect(source).not.toMatch(/\b07\d{9}\b/);
  });
});

describe("8. the role view is the same model, read the other way round", () => {
  it.each(ALL_ROLES)("%s: grants and denials partition the domains, with nothing missing", (role) => {
    const c = copilotClearanceForRole(role);
    expect([...c.reads, ...c.deniedReads].sort()).toEqual([...READ_DOMAINS].sort());
    expect([...c.acts, ...c.deniedActs].sort()).toEqual([...ACT_DOMAINS].sort());
    for (const d of c.reads) expect(c.deniedReads).not.toContain(d);
    for (const d of c.acts) expect(c.deniedActs).not.toContain(d);
    expect(c.role).toBe(role);
    expect(c.tools).toEqual(TOOL_CATALOG[c.access]);
  });

  it("prints the table a practice would be shown, and it is the one we claim", () => {
    const table = ALL_ROLES.map((r) => {
      const c = copilotClearanceForRole(r);
      return `${r}|${c.access}|${c.tools.length}|tier${c.maxTier}|${c.reachableToday ? "live" : "declared"}`;
    });
    expect(table).toEqual([
      "agency_admin|full|28|tier4|live",
      "client_owner|full|28|tier4|live",
      "client_coordinator|manager|10|tier2|live",
      "client_clinician|clinician|9|tier1|live",
      "client_staff|staff|3|tier1|live",
    ]);
  });
});
