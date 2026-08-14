import { describe, it, expect } from "vitest";
import {
  PATIENT_ADMIN_ROLES,
  CLINICAL_WRITE_ROLES,
  isPatientAdminRole,
  isClinicalWriteRole,
} from "./roles";
import type { Role } from "@/lib/types";

// ===========================================================================
// THE TWO PATIENT-RECORD ROLE LISTS, AND THE ONE ROLE THAT IS IN NEITHER.
//
// These are pure lists, which is exactly why they need a test: nothing else in
// the codebase would notice a name added to either one, and both are read by the
// server guards AND by the components that hide the controls. A silent addition
// here is a silent grant everywhere.
//
// The fifth role (client_staff) is the reason this file exists now. A nurse or a
// receptionist must reach NO part of the patient record — not the chart, not the
// perio, not the medical history, not the status flags, not the profile. That is
// asserted here against both lists rather than assumed from the nav allow-list,
// because these two guards run on routes the nav never sees.
// ===========================================================================

const ALL_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
];

describe("PATIENT_ADMIN_ROLES: who may administer a patient record", () => {
  it("is exactly the three accountable non-clinical roles", () => {
    // An exact set, so the NEXT unannounced addition fails here rather than
    // quietly widening two server guards and four components at once.
    expect([...PATIENT_ADMIN_ROLES].sort()).toEqual(
      ["agency_admin", "client_coordinator", "client_owner"].sort(),
    );
  });

  it("admits the practice manager, because she is the one who does this work", () => {
    // client_coordinator IS the practice manager in this platform. Gating patient
    // administration on owner-only would lock out its primary user, which is the
    // documented reason this list is not requireOwnerRole's.
    expect(isPatientAdminRole("client_coordinator")).toBe(true);
  });

  it("refuses the clinician and the staff role", () => {
    expect(isPatientAdminRole("client_clinician")).toBe(false);
    expect(isPatientAdminRole("client_staff")).toBe(false);
  });

  it("refuses null, undefined and a non-role string", () => {
    expect(isPatientAdminRole(null)).toBe(false);
    expect(isPatientAdminRole(undefined)).toBe(false);
    expect(isPatientAdminRole("")).toBe(false);
    expect(isPatientAdminRole("client_ownerr")).toBe(false);
  });
});

describe("CLINICAL_WRITE_ROLES: who may author an entry in the clinical record", () => {
  it("is exactly clinician + owner + agency", () => {
    expect([...CLINICAL_WRITE_ROLES].sort()).toEqual(
      ["agency_admin", "client_clinician", "client_owner"].sort(),
    );
  });

  it("admits the clinician, who is the role the list exists for", () => {
    expect(isClinicalWriteRole("client_clinician")).toBe(true);
  });

  it("REFUSES THE COORDINATOR — the tightening this list was added to make", () => {
    // A deliberate narrowing, not an oversight. Charting a tooth, recording a
    // periodontal finding and signing off a medical history are clinical acts
    // attributed to whoever made them; the coordinator books around them and reads
    // them, but does not author them. Before this list existed, every route that now
    // calls isClinicalWriteRole accepted a coordinator session.
    expect(isClinicalWriteRole("client_coordinator")).toBe(false);
    // ...and the same person is still a patient ADMIN, so the two lists really are
    // different questions and not a copy that drifted.
    expect(isPatientAdminRole("client_coordinator")).toBe(true);
  });

  it("refuses the staff role", () => {
    expect(isClinicalWriteRole("client_staff")).toBe(false);
  });

  it("refuses null, undefined and a non-role string", () => {
    expect(isClinicalWriteRole(null)).toBe(false);
    expect(isClinicalWriteRole(undefined)).toBe(false);
    expect(isClinicalWriteRole("")).toBe(false);
    expect(isClinicalWriteRole("client_clinicians")).toBe(false);
  });
});

describe("the fifth role reaches no part of the patient record", () => {
  it("client_staff is in NEITHER list", () => {
    expect(PATIENT_ADMIN_ROLES).not.toContain("client_staff");
    expect(CLINICAL_WRITE_ROLES).not.toContain("client_staff");
  });

  it("every role is judged by both predicates, so the sweep cannot pass vacuously", () => {
    // Guards the guard: iterate the FULL role union rather than a hand-picked
    // sample, so a sixth role added later cannot slip past unjudged.
    expect(ALL_ROLES).toHaveLength(5);
    const admin = ALL_ROLES.filter(isPatientAdminRole);
    const clinical = ALL_ROLES.filter(isClinicalWriteRole);
    expect(admin.sort()).toEqual([...PATIENT_ADMIN_ROLES].sort());
    expect(clinical.sort()).toEqual([...CLINICAL_WRITE_ROLES].sort());
    // Both lists are non-empty and neither has swallowed the whole union.
    expect(admin.length).toBeGreaterThan(0);
    expect(clinical.length).toBeGreaterThan(0);
    expect(admin.length).toBeLessThan(ALL_ROLES.length);
    expect(clinical.length).toBeLessThan(ALL_ROLES.length);
  });

  it("the owner and the agency admin hold both, so neither list is a strict subset by accident", () => {
    for (const role of ["client_owner", "agency_admin"]) {
      expect(isPatientAdminRole(role)).toBe(true);
      expect(isClinicalWriteRole(role)).toBe(true);
    }
    // And the two lists genuinely differ, in both directions.
    expect(isPatientAdminRole("client_coordinator")).toBe(true);
    expect(isClinicalWriteRole("client_coordinator")).toBe(false);
    expect(isPatientAdminRole("client_clinician")).toBe(false);
    expect(isClinicalWriteRole("client_clinician")).toBe(true);
  });
});
