import { describe, it, expect, vi } from "vitest";

// nav.ts pulls in lucide-react and (transitively) a server-only import through
// the guard it sits beside. Stubbing `server-only` is the standard escape hatch
// here — `nav.clinician.test.ts:8` does the same and for the same reason.
vi.mock("server-only", () => ({}));

import type { Role } from "@/lib/types";
import {
  CLINICIAN_SLUGS,
  STAFF_SLUGS,
  OWNER_ROLES,
  CLIENT_MODULE_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  canRoleAccessModule,
  navForRole,
} from "@/lib/nav";
import { PATIENT_ADMIN_ROLES, CLINICAL_WRITE_ROLES } from "@/lib/patient/roles";
import { APPROVER_ROLES } from "@/lib/absence/rules";
import { PAY_ACCESS_ROLES } from "@/lib/hr/access";
import { copilotAccessForRole } from "@/lib/copilot/scope";
import { CAPABILITIES, CAPABILITY_KEYS, type Capability } from "./keys";
import { ALL_ROLES, DEFAULT_PROVENANCE, ROLE_DEFAULTS, defaultHoldersOf } from "./defaults";

// ===========================================================================
// THE PROOF: NOBODY GAINED OR LOST ANYTHING EXCEPT WHERE WE SAY SO.
//
// Modelled on `nav.clinician.test.ts`, which got the structure right and is the
// precedent this file follows deliberately.
//
// A BARE SNAPSHOT WOULD BE WORTHLESS. "assert ROLE_DEFAULTS equals whatever
// ROLE_DEFAULTS currently is" pins nothing: it silently absorbs any widening
// committed alongside it. So this file is a BASELINE plus NAMED DELTAS:
//
//   TODAY      what each role could actually do at commit 68ab0a9, derived by
//              hand from the guard that enforces each act, one line per key.
//   TIGHTENED  what this change deliberately TAKES AWAY, with the reason.
//   WIDENED    what this change deliberately GIVES, with the reason.
//   NEW_KEYS   acts that did not exist before, so have no baseline.
//
// and the assertion is the equation:
//
//   ROLE_DEFAULTS[role]  ==  (TODAY[role] − TIGHTENED[role]) ∪ WIDENED[role] ∪ NEW[role]
//
// A future edit that widens a role fails here with the offending key named.
//
// THE SECOND HALF of the file re-derives every default from the REAL role
// constants and the REAL `canRoleAccessModule`, so `defaults.ts` cannot drift
// from the guards it claims to describe. And the LAST block re-asserts the nav
// itself, because the one thing this whole layer must not do is leak into module
// access: module = may you see this area, capability = may you do this thing.
// ===========================================================================

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * The four roles that EXISTED at the baseline commit. `client_staff` is new in
 * this campaign and therefore has no baseline to preserve — it is asserted
 * separately and exactly, further down.
 */
const BASELINE_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
];

/**
 * WHAT EACH ROLE COULD DO AT COMMIT 68ab0a9 — hand-derived, one line per key,
 * from the guard that enforced the act at that commit.
 *
 * The four ⚠️ lines are the ones that made this work necessary: those routes ran
 * on `requireUser -> requireClientAccess -> requireSiteAccess` and therefore
 * accepted EVERY role attached to the practice, receptionist included. A
 * coordinator could write a BPE, chart a tooth, sign off a medical history and
 * retract any of them — with their own name stamped on it by the GDC-attribution
 * check, which makes it worse rather than better.
 */
const TODAY: Record<string, Record<Capability, boolean>> = {
  agency_admin: {
    "diary.appointment.move": true, //  isPatientAdminRole (move-service.ts)
    "diary.appointment.cancel": true, //  module gate: no-show-defence
    "diary.entry.write": true, //  requireDiaryAdmin
    "patient.profile.edit": true, //  requirePatientAdmin
    "patient.status.change": true, //  requirePatientAdmin
    "patient.create": true, //  module gate: onboarding
    "patient.note.write": true, //  ⚠️ user+client+site only; every role of the practice
    "clinical.chart.write": true, //  ⚠️ no role check
    "clinical.perio.write": true, //  ⚠️ no role check
    "clinical.medical-history.write": true, //  ⚠️ no role check
    "clinical.record.retract": true, //  ⚠️ no role check
    "clinical.fp17.view": true, //  module gate: fp17
    "messaging.patient.reply": true, //  module gate: conversations
    "messaging.lifecycle.send": true, //  module gates: recall/reactivation/coordinator
    "messaging.campaign.launch": true, //  requireOwnerRole
    "people.absence.request": true, //  requireApproverRole
    "people.absence.approve": true, //  requireApproverRole
    "people.clock.self": true, //  module gate: staff-check-in
    "people.clock.record-for-other": true, //  requireApproverRole
    "reports.run": true, //  requireOwnerRole
    "reports.nhs.view": true, //  requireOwnerRole
    "reports.allocation.view": true, //  requireOwnerRole
    "system.toggle": true, //  requireOwnerRole
    "system.copilot.ask": true, //  module gate: co-pilot (owner-only)
    "security.capability.manage": true, //  NEW — see NEW_KEYS
    // The HR lane. Every route behind these was WRITTEN in this campaign, so there
    // is no baseline act to preserve; the value states the INTENDED holder and the
    // key is listed in NEW_KEYS. Section 6 states them again as closed per-role
    // lists, so "new" cannot become a place to hide a widening.
    "rota.view": true, //  NEW
    "rota.edit": true, //  NEW
    "rota.publish": true, //  NEW
    "hours.view": true, //  NEW
    "hr.view-pay": true, //  NEW
    "hr.view-documents": true, //  NEW
    "hr.manage-documents": true, //  NEW
    "esign.manage-policies": true, //  NEW
  },
  client_owner: {
    "diary.appointment.move": true,
    "diary.appointment.cancel": true,
    "diary.entry.write": true,
    "patient.profile.edit": true,
    "patient.status.change": true,
    "patient.create": true,
    "patient.note.write": true,
    "clinical.chart.write": true, //  ⚠️
    "clinical.perio.write": true, //  ⚠️
    "clinical.medical-history.write": true, //  ⚠️
    "clinical.record.retract": true, //  ⚠️
    "clinical.fp17.view": true,
    "messaging.patient.reply": true,
    "messaging.lifecycle.send": true,
    "messaging.campaign.launch": true,
    "people.absence.request": true,
    "people.absence.approve": true,
    "people.clock.self": true,
    "people.clock.record-for-other": true,
    "reports.run": true,
    "reports.nhs.view": true,
    "reports.allocation.view": true,
    "system.toggle": true,
    "system.copilot.ask": true,
    "security.capability.manage": true, //  NEW
    "rota.view": true, //  NEW
    "rota.edit": true, //  NEW
    "rota.publish": true, //  NEW
    "hours.view": true, //  NEW
    "hr.view-pay": true, //  NEW
    "hr.view-documents": true, //  NEW
    "hr.manage-documents": true, //  NEW
    "esign.manage-policies": true, //  NEW
  },
  client_coordinator: {
    "diary.appointment.move": true, //  isPatientAdminRole includes the coordinator
    "diary.appointment.cancel": true,
    "diary.entry.write": true,
    "patient.profile.edit": true,
    "patient.status.change": true,
    "patient.create": true,
    "patient.note.write": true,
    "clinical.chart.write": true, //  ⚠️ THE TIGHTENING: this is what she loses
    "clinical.perio.write": true, //  ⚠️
    "clinical.medical-history.write": true, //  ⚠️
    "clinical.record.retract": true, //  ⚠️
    "clinical.fp17.view": true,
    "messaging.patient.reply": true,
    "messaging.lifecycle.send": true,
    "messaging.campaign.launch": false, //  requireOwnerRole refuses her
    "people.absence.request": true, //  requireApproverRole admits her
    "people.absence.approve": true,
    "people.clock.self": true,
    "people.clock.record-for-other": true,
    "reports.run": false, //  requireOwnerRole
    "reports.nhs.view": false, //  requireOwnerRole
    "reports.allocation.view": false, //  requireOwnerRole
    "system.toggle": false, //  requireOwnerRole
    "system.copilot.ask": false, //  co-pilot is owner-only
    "security.capability.manage": false, //  NEW, and owner-only
    // THE ROTA WIDENING (orchestrator decision 4) IS THESE THREE LINES. At the
    // baseline the rota nav entry and all four rota routes were requireOwnerRole,
    // so the practice manager could not open the rota she runs. She can now.
    "rota.view": true, //  NEW
    "rota.edit": true, //  NEW
    "rota.publish": true, //  NEW — and it texts real phones, which is why it is its own key
    "hours.view": true, //  NEW — she is the person who runs the month
    // THE ONE SHE DOES NOT GET. Blerta's own stated requirement: the assistant
    // manager must not see what individuals are paid. Grantable per person, off
    // by default, and enforced by the fields never being built server side.
    "hr.view-pay": false, //  NEW, owner + agency only
    "hr.view-documents": true, //  NEW
    "hr.manage-documents": true, //  NEW
    // Publishing a policy asks the whole practice to affirm it and can never be
    // edited afterwards. Owner + agency.
    "esign.manage-policies": false, //  NEW, owner + agency only
  },
  client_clinician: {
    // The clinician's allow-list at 68ab0a9 was "", calendar, patients, absence,
    // staff-check-in. Everything below follows from that plus the role guards.
    "diary.appointment.move": false, //  isPatientAdminRole excludes the clinician
    "diary.appointment.cancel": false, //  no-show-defence is not in CLINICIAN_SLUGS
    "diary.entry.write": false, //  requireDiaryAdmin
    "patient.profile.edit": false, //  requirePatientAdmin
    "patient.status.change": false, //  requirePatientAdmin
    "patient.create": false, //  onboarding is not in CLINICIAN_SLUGS
    "patient.note.write": true, //  ⚠️ reaches "patients", no role check
    "clinical.chart.write": true, //  ⚠️ and KEEPS it — this is their job
    "clinical.perio.write": true, //  ⚠️ and keeps it
    "clinical.medical-history.write": true, //  ⚠️ and keeps it
    "clinical.record.retract": true, //  ⚠️ and keeps it
    "clinical.fp17.view": false, //  fp17 is not in CLINICIAN_SLUGS
    "messaging.patient.reply": false, //  conversations is not in CLINICIAN_SLUGS
    "messaging.lifecycle.send": false,
    "messaging.campaign.launch": false,
    "people.absence.request": false, //  the route calls requireApproverRole — the dead surface
    "people.absence.approve": false,
    "people.clock.self": true, //  staff-check-in IS in CLINICIAN_SLUGS
    "people.clock.record-for-other": false, //  requireApproverRole
    "reports.run": false,
    "reports.nhs.view": false,
    "reports.allocation.view": false,
    "system.toggle": false,
    "system.copilot.ask": false,
    "security.capability.manage": false,
    // The clinician gets NONE of the workforce-management lane. Their own shifts,
    // holiday and documents reach them through `my-work`, which reads the caller's
    // own rows from the session and is not governed by these keys at all.
    "rota.view": false, //  NEW
    "rota.edit": false, //  NEW
    "rota.publish": false, //  NEW
    "hours.view": false, //  NEW
    "hr.view-pay": false, //  NEW
    "hr.view-documents": false, //  NEW
    "hr.manage-documents": false, //  NEW
    "esign.manage-policies": false, //  NEW
  },
};

/**
 * WHAT THIS CHANGE TAKES AWAY. One role, four keys, and a reason per line.
 *
 * Signed off as a named delta (orchestrator decision 3) precisely because it is a
 * real behaviour change for a real person: a receptionist who marks up a chart
 * today loses that tomorrow. The route half of it already shipped as
 * `requireClinicalWriteRole`; this is the capability layer agreeing with it
 * rather than quietly contradicting it.
 */
const TIGHTENED: Record<string, Capability[]> = {
  agency_admin: [],
  client_owner: [],
  client_coordinator: [
    // Charting a tooth is a clinical act. It becomes part of the record and is
    // attributed to whoever made it (GDC 4.1.4). It is not the receptionist's.
    "clinical.chart.write",
    // Same, for a BPE or a full periodontal chart.
    "clinical.perio.write",
    // Same, for signing off a medical history on a patient's behalf.
    "clinical.medical-history.write",
    // And retraction most of all: withdrawing a clinical entry is the act an
    // inspector asks about by name.
    "clinical.record.retract",
  ],
  client_clinician: [],
};

/**
 * WHAT THIS CHANGE GIVES. Two roles, one key each, and the reason neither is a hole.
 */
const WIDENED: Record<string, Capability[]> = {
  agency_admin: [],
  client_owner: [],
  client_coordinator: [
    // THE MANAGER CO-PILOT (agent expansion, Wave 3 #5). This key is DERIVED, not
    // typed: its provenance is { base: "module", slug: "co-pilot" }, and the
    // co-pilot module's `roles` array in CLIENT_NAV gained "client_coordinator"
    // in that lane, so the default holder set follows the module by construction
    // (section 3 re-derives it and would fail if it did not).
    //
    // WHY IT IS NOT A HOLE. Holding this key means "you may ask the co-pilot",
    // not "you may read what the owner's co-pilot reads". What the co-pilot will
    // DO for the asker is decided per-turn from the SESSION's role by
    // `copilotAccessForRole` (src/lib/copilot/scope.ts): the manager is handed a
    // six-tool operational schema with no money tool, no report tool, no
    // marketing tool and no send tool, her practice-brain reads are capped at her
    // own clearance tier, and the one allowed tool that carries money has it
    // projected out before the result leaves the server. Capability and scope
    // compose exactly like capability and route guard do everywhere else in this
    // file: holding this is necessary and nowhere near sufficient.
    //
    // AND IT REMAINS REVOCABLE. It is a default, not a grant in stone — the owner
    // can switch it off for one named person on People & logins, which is the
    // whole reason the co-pilot was given a capability key rather than being left
    // to the module gate alone.
    "system.copilot.ask",
  ],
  client_clinician: [
    // NO EFFECTIVE ACCESS CHANGES TODAY. POST /api/absence still calls
    // requireApproverRole and still refuses a clinician — the "Holiday & absence"
    // page in their nav is a dead surface, and the route's own comment admits it.
    // The capability is granted so that the self-request fix (a separate,
    // deliberate change in this same campaign) is not silently blocked afterwards
    // by a permission nobody knew to set. Capability and route guard compose:
    // holding this key is necessary and not sufficient.
    "people.absence.request",
  ],
};

/**
 * Acts that did not exist at the baseline, so have no "today".
 *
 * The permissions screen itself (LOCKED — the owner-only default is the only way
 * anyone can ever hold it), plus the eight workforce keys, every one of which
 * guards a route this campaign WROTE: /api/rota/shifts, /api/rota/shift/[id],
 * /api/rota/publish, /api/hours/month, /api/hr/profile/pay-rate, /api/hr/document,
 * /api/hr/document/url, /api/hr/policy. None of them existed at 68ab0a9, so none
 * has a baseline to preserve.
 *
 * "No baseline" must not become "no scrutiny", so section 6 restates each role's
 * new keys as a closed list with the reason, and asserts the two the practice
 * manager deliberately does NOT get.
 */
const NEW_KEYS: Capability[] = [
  "security.capability.manage",
  "rota.view",
  "rota.edit",
  "rota.publish",
  "hours.view",
  "hr.view-pay",
  "hr.view-documents",
  "hr.manage-documents",
  "esign.manage-policies",
];

/** The eight, on their own, so section 6 cannot drift from NEW_KEYS. */
const WORKFORCE_KEYS: Capability[] = NEW_KEYS.filter((k) => k !== "security.capability.manage");

describe("1. the four existing roles are unchanged apart from the named deltas", () => {
  it.each(BASELINE_ROLES)("%s holds exactly (today − tightened) + widened", (role) => {
    const today = TODAY[role];
    const expected = CAPABILITY_KEYS.filter((key) => {
      if (NEW_KEYS.includes(key)) return today[key]; // new key: TODAY states the intended holder
      if (TIGHTENED[role].includes(key)) return false;
      if (WIDENED[role].includes(key)) return true;
      return today[key];
    });
    expect(sorted(ROLE_DEFAULTS[role])).toEqual(sorted(expected));
  });

  it("every capability appears in every baseline role's TODAY row exactly once", () => {
    // No key can dodge the proof by being left out of the table.
    for (const role of BASELINE_ROLES) {
      expect(sorted(Object.keys(TODAY[role]))).toEqual(sorted(CAPABILITY_KEYS));
    }
  });

  it("the tightening is real, and it is only the coordinator's", () => {
    // Guards the guard: if TIGHTENED were emptied, test 1 would still pass while
    // the coordinator silently kept four clinical writes.
    expect(TIGHTENED.client_coordinator).toHaveLength(4);
    for (const key of TIGHTENED.client_coordinator) {
      expect(TODAY.client_coordinator[key], `${key} must have been held to be lost`).toBe(true);
      expect(ROLE_DEFAULTS.client_coordinator.has(key)).toBe(false);
      // ...and the clinician, the role these surfaces exist for, keeps every one.
      expect(ROLE_DEFAULTS.client_clinician.has(key)).toBe(true);
    }
    expect(TIGHTENED.agency_admin.concat(TIGHTENED.client_owner, TIGHTENED.client_clinician)).toEqual([]);
  });

  it("the widenings are one key each, on two roles, and neither is sufficient on its own", () => {
    // The two roles that gained anything, named exactly. The two that did not are
    // asserted empty, so a third widening cannot arrive unannounced.
    expect(WIDENED.client_clinician).toEqual(["people.absence.request"]);
    expect(WIDENED.client_coordinator).toEqual(["system.copilot.ask"]);
    expect(WIDENED.agency_admin.concat(WIDENED.client_owner)).toEqual([]);
    // The capability is necessary, not sufficient: APPROVER_ROLES is what the
    // route checks and the clinician is not in it. If that ever changes, this
    // line fails and the widening has to be re-argued as a real one.
    expect(APPROVER_ROLES).not.toContain("client_clinician");
    // The same shape for the co-pilot key, and this is the line that keeps it
    // honest: holding it lets the manager ASK, and `copilotAccessForRole` decides
    // what she is answered with. If the manager were ever mapped to "full", the
    // capability would stop being a scoped grant and this fails.
    expect(copilotAccessForRole("client_coordinator")).toBe("manager");
    expect(copilotAccessForRole("client_owner")).toBe("full");
  });

  it("no role lost anything that is not in TIGHTENED", () => {
    // Stated separately from the equation so a failure reads as "you took X away
    // from Y" rather than as a set diff.
    for (const role of BASELINE_ROLES) {
      const lost = CAPABILITY_KEYS.filter((k) => TODAY[role][k] && !ROLE_DEFAULTS[role].has(k));
      expect(sorted(lost), `${role} lost capabilities not named in TIGHTENED`).toEqual(
        sorted(TIGHTENED[role]),
      );
    }
  });

  it("no role gained anything that is not in WIDENED or NEW_KEYS", () => {
    for (const role of BASELINE_ROLES) {
      const gained = CAPABILITY_KEYS.filter(
        (k) => !TODAY[role][k] && ROLE_DEFAULTS[role].has(k) && !NEW_KEYS.includes(k),
      );
      expect(sorted(gained), `${role} gained capabilities not named in WIDENED`).toEqual(
        sorted(WIDENED[role]),
      );
    }
  });
});

describe("2. the fifth role gets exactly two capabilities, both self-service", () => {
  it("client_staff holds their own holiday request and their own clocking, and nothing else", () => {
    // THE HEADLINE OF THE FIFTH ROLE, stated as a closed list. A nurse or a
    // receptionist login can ask for time off and clock themselves in. It cannot
    // touch the diary, the patient record, the clinical record, patient messaging,
    // a report, a kill switch or another person's anything. A future addition has
    // to be made HERE, by hand, with a reason.
    expect(sorted(ROLE_DEFAULTS.client_staff)).toEqual([
      "people.absence.request",
      "people.clock.self",
    ]);
  });

  it("and holds nothing that touches a patient", () => {
    const patientish = CAPABILITY_KEYS.filter((k) =>
      ["diary", "patient", "clinical", "messaging"].some((g) => k.startsWith(`${g}.`)),
    );
    expect(patientish.length).toBeGreaterThan(10);
    for (const key of patientish) expect(ROLE_DEFAULTS.client_staff.has(key)).toBe(false);
  });

  it("client_clinician is not a subset of client_coordinator, and that is correct", () => {
    // The obvious sanity check would be "the narrower role holds less", and it is
    // FALSE here on purpose: after the tightening the clinician holds four clinical
    // writes the coordinator does not. They are different jobs, not a ladder.
    const clinicianOnly = [...ROLE_DEFAULTS.client_clinician].filter(
      (k) => !ROLE_DEFAULTS.client_coordinator.has(k),
    );
    expect(sorted(clinicianOnly)).toEqual(sorted(TIGHTENED.client_coordinator));
  });
});

describe("3. every default is DERIVED from the guard it claims to come from", () => {
  const holdersOfModule = (slug: string): Role[] =>
    ALL_ROLES.filter((role) => canRoleAccessModule(role, slug));

  it.each(CAPABILITY_KEYS)("%s matches its stated provenance", (key) => {
    const p = DEFAULT_PROVENANCE[key];
    const actual = sorted(defaultHoldersOf(key));
    switch (p.base) {
      case "owner":
        expect(actual).toEqual(sorted(OWNER_ROLES));
        break;
      case "approver":
        expect(actual).toEqual(sorted(APPROVER_ROLES));
        break;
      case "patient-admin":
        expect(actual).toEqual(sorted(PATIENT_ADMIN_ROLES));
        break;
      case "clinical-write":
        expect(actual).toEqual(sorted(CLINICAL_WRITE_ROLES));
        break;
      case "pay-access":
        // Imported from src/lib/hr/access.ts, never retyped: the pay tier and the
        // capability default are the same fact, and this is what stops them
        // drifting the day one of them is edited.
        expect(actual).toEqual(sorted(PAY_ACCESS_ROLES));
        break;
      case "all":
        expect(actual).toEqual(sorted(ALL_ROLES));
        break;
      case "module": {
        const expected = new Set([...holdersOfModule(p.slug), ...(p.plus ?? [])]);
        expect(actual).toEqual(sorted(expected));
        // Every slug the entry claims to agree with really does admit the same roles.
        for (const other of p.agreesWith ?? []) {
          expect(sorted(holdersOfModule(other)), `${key}: ${p.slug} vs ${other}`).toEqual(
            sorted(holdersOfModule(p.slug)),
          );
        }
        break;
      }
    }
  });

  it("only a role with no baseline may be added by `plus`", () => {
    // `plus` is the escape hatch for the brand-new role. Using it on a role that
    // HAS a baseline would be a widening that dodged the named delta above.
    for (const key of CAPABILITY_KEYS) {
      const p = DEFAULT_PROVENANCE[key];
      const plus = "plus" in p ? (p.plus ?? []) : [];
      for (const role of plus) expect(BASELINE_ROLES, `${key} widens ${role} via plus`).not.toContain(role);
    }
  });

  it("the derivation is not vacuous: several distinct bases are in use", () => {
    const bases = new Set(CAPABILITY_KEYS.map((k) => DEFAULT_PROVENANCE[k].base));
    expect(bases.size).toBeGreaterThanOrEqual(5);
    expect(bases.has("module")).toBe(true);
    expect(bases.has("clinical-write")).toBe(true);
  });

  it("OWNER_ROLES is still exactly two, so 'owner' means what this file thinks", () => {
    expect(sorted(OWNER_ROLES)).toEqual(["agency_admin", "client_owner"]);
    expect(sorted(APPROVER_ROLES)).toEqual(["agency_admin", "client_coordinator", "client_owner"]);
    expect(sorted(PATIENT_ADMIN_ROLES)).toEqual(["agency_admin", "client_coordinator", "client_owner"]);
    expect(sorted(CLINICAL_WRITE_ROLES)).toEqual(["agency_admin", "client_clinician", "client_owner"]);
  });
});

// ===========================================================================
// 4. THE NAV IS UNTOUCHED.
//
// The single thing this layer must never do is leak into module access. Module
// = may you see this area; capability = may you do this thing. If capability
// resolution ever started feeding `canRoleAccessModule`, the allow-BY-DEFAULT
// nav would have to enumerate defaults for five roles across ~40 slugs and the
// non-widening proof would become unmaintainable.
//
// So the clinician's allow-list — the tightest in the platform, and the one a
// leak would show up in first — is re-asserted here from the capability side.
// ===========================================================================
describe("4. the capability layer did not leak into module access", () => {
  it("the clinician's allow-list is still exactly the six modules", () => {
    expect(sorted(CLINICIAN_SLUGS)).toEqual(
      sorted(["", "calendar", "patients", "absence", "staff-check-in", "my-work"]),
    );
  });

  it("and the clinician is still denied every slug outside it", () => {
    const all = [...CLIENT_MODULE_SLUGS, ...EXTRA_OWNER_ONLY_SLUGS];
    const denied = all.filter((s) => !CLINICIAN_SLUGS.has(s));
    expect(denied.length).toBeGreaterThan(20);
    for (const slug of denied) expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
  });

  it("the staff allow-list is still two entries and holds neither the diary nor the patients", () => {
    expect(sorted(STAFF_SLUGS)).toEqual(["", "my-work"]);
    expect(canRoleAccessModule("client_staff", "calendar")).toBe(false);
    expect(canRoleAccessModule("client_staff", "patients")).toBe(false);
  });

  it("holding a capability does not grant its module, and vice versa", () => {
    // The clinician holds clinical.chart.write and is still denied "fp17"; the
    // coordinator reaches "patients" and no longer holds clinical.chart.write.
    // Two facts, opposite directions, one point: the two layers are independent.
    expect(ROLE_DEFAULTS.client_clinician.has("clinical.chart.write")).toBe(true);
    expect(canRoleAccessModule("client_clinician", "fp17")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "patients")).toBe(true);
    expect(ROLE_DEFAULTS.client_coordinator.has("clinical.chart.write")).toBe(false);
  });

  it("the permissions module itself is owner-only in the nav", () => {
    for (const role of ALL_ROLES) {
      expect(canRoleAccessModule(role, "permissions")).toBe(OWNER_ROLES.includes(role));
    }
    // And it really is in the nav for the owner, not stranded.
    expect(navForRole("client_owner").flatMap((g) => g.items.map((i) => i.slug))).toContain("permissions");
  });
});

// ===========================================================================
// 6. THE WORKFORCE LANE, STATED AS A CLOSED LIST PER ROLE.
//
// These eight keys are in NEW_KEYS, which means the equation in section 1 takes
// their holders from TODAY rather than proving they did not change. That is
// correct — the routes did not exist — and it is exactly the kind of exemption
// that goes soft if nobody looks at it again. So the whole lane is restated here,
// per role, closed, with the two deliberate refusals asserted by name.
// ===========================================================================
describe("6. the workforce keys: who got them, and the two the practice manager did not", () => {
  it("every workforce key really is new (none of them existed to be taken from anybody)", () => {
    expect(WORKFORCE_KEYS).toHaveLength(8);
    for (const key of WORKFORCE_KEYS) {
      expect(NEW_KEYS, `${key} must be declared new`).toContain(key);
      // Not lost by anybody: a "new" key that some role held at the baseline would
      // be a tightening wearing a disguise.
      for (const role of BASELINE_ROLES) {
        if (TODAY[role][key]) expect(ROLE_DEFAULTS[role].has(key)).toBe(true);
      }
    }
  });

  it("the owner and the agency admin hold all eight", () => {
    for (const role of ["agency_admin", "client_owner"] as const) {
      for (const key of WORKFORCE_KEYS) {
        expect(ROLE_DEFAULTS[role].has(key), `${role} should hold ${key}`).toBe(true);
      }
    }
  });

  it("the practice manager holds exactly six: the rota, the month and the staff file", () => {
    // THE DECISION-4 WIDENING, WRITTEN OUT. At the baseline the rota was
    // requireOwnerRole on the nav entry and on all four routes, so the person who
    // actually runs the rota could not open it. A seventh entry here is a widening
    // that has to be argued, not typed.
    const held = WORKFORCE_KEYS.filter((k) => ROLE_DEFAULTS.client_coordinator.has(k));
    expect(sorted(held)).toEqual(
      sorted([
        "rota.view",
        "rota.edit",
        "rota.publish",
        "hours.view",
        "hr.view-documents",
        "hr.manage-documents",
      ]),
    );
  });

  it("...and NOT pay, and NOT publishing a policy", () => {
    // The practice's own stated requirement, asserted rather than described: the
    // assistant manager must not see what individuals are paid. Both are grantable
    // per person by an owner; neither comes with the role.
    expect(ROLE_DEFAULTS.client_coordinator.has("hr.view-pay")).toBe(false);
    expect(ROLE_DEFAULTS.client_coordinator.has("esign.manage-policies")).toBe(false);
    // And the pay tier is genuinely two roles, not "everyone senior".
    expect(sorted(PAY_ACCESS_ROLES)).toEqual(["agency_admin", "client_owner"]);
  });

  it("the clinician and the staff role hold none of the eight", () => {
    // Their own shifts, holiday and documents reach them through `my-work`, which
    // resolves the caller from the session. Managing OTHER people is not theirs.
    for (const role of ["client_clinician", "client_staff"] as const) {
      for (const key of WORKFORCE_KEYS) {
        expect(ROLE_DEFAULTS[role].has(key), `${role} must not hold ${key}`).toBe(false);
      }
    }
  });

  it("every workforce key names a route that enforces it", () => {
    // The catalog's own bidirectional sweep proves the files; this proves the
    // simpler thing it rests on — that none of the eight was added holding nothing.
    for (const key of WORKFORCE_KEYS) {
      const def = CAPABILITIES.find((c) => c.key === key);
      expect(def, `${key} is missing from the catalog`).toBeDefined();
      expect(def!.enforcedAt.length + (def!.enforcedIn?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it("the three that cannot be undone are marked destructive, and the reads are not", () => {
    // Drives the fail-closed branch in requireCapability: publishing a rota texts
    // real phones, an uploaded document lands in somebody's employment file, and a
    // published policy version can never be edited. None of those may happen on an
    // environment that cannot say who asked.
    const destructive = (k: string) => CAPABILITIES.find((c) => c.key === k)!.destructive;
    expect(destructive("rota.publish")).toBe(true);
    expect(destructive("rota.edit")).toBe(true);
    expect(destructive("hr.manage-documents")).toBe(true);
    expect(destructive("esign.manage-policies")).toBe(true);
    // ...and the reads stay readable without sign-in, or the pilot demo goes blank.
    expect(destructive("rota.view")).toBe(false);
    expect(destructive("hours.view")).toBe(false);
    expect(destructive("hr.view-pay")).toBe(false);
    expect(destructive("hr.view-documents")).toBe(false);
  });
});

describe("5. anti-vacuity on the proof itself", () => {
  it("the baseline covers four roles and the catalog is not empty", () => {
    expect(BASELINE_ROLES).toHaveLength(4);
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(24);
    expect(CAPABILITY_KEYS.length).toBe(CAPABILITIES.length);
  });

  it("TODAY is not all-true (which would make the equation trivial)", () => {
    const falses = BASELINE_ROLES.flatMap((r) => CAPABILITY_KEYS.filter((k) => !TODAY[r][k]));
    expect(falses.length).toBeGreaterThan(20);
  });
});
