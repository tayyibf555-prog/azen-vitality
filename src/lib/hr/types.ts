import type { EntitlementResult } from "./entitlement";

// ---------------------------------------------------------------------------
// The employee file: the shapes.
//
// TWO TABLES, TWO TYPES, AND THEY ARE NEVER MERGED INTO ONE OBJECT ON THE WAY
// OUT. `StaffHrProfile` is what a practice manager may see; `StaffPayRate` is
// what only an owner or the agency may see. Keeping them apart in the type
// system is what makes "omit pay server side" a thing the compiler helps with
// rather than a rule somebody remembers.
// ---------------------------------------------------------------------------

export interface HrAddress {
  line1?: string | null;
  line2?: string | null;
  town?: string | null;
  postcode?: string | null;
}

export interface HrEmergencyContact {
  name?: string | null;
  relationship?: string | null;
  phone?: string | null;
}

/** The non-pay employee file. One row per staff member (0075). */
export interface StaffHrProfile {
  staffId: string;
  dateOfBirth: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  address: HrAddress | null;
  emergencyContact: HrEmergencyContact | null;
  employmentStart: string | null;
  employmentEnd: string | null;
  contractedDaysPerWeek: number | null;
  entitlementDaysOverride: number | null;
  leaveYearStartMonth: number;
  gdcNumber: string | null;
  /** The LAST FOUR characters only. The full number is never stored. */
  niNumberLast4: string | null;
  updatedAt: string | null;
}

/** One effective-dated hourly rate. Appended, never updated. */
export interface StaffPayRate {
  id: string;
  staffId: string;
  /** Pence per hour. Integer. */
  hourlyPence: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string | null;
}

/**
 * One person, as the Staff HR screen reads them.
 *
 * `pay` is OPTIONAL and absent (not null) for a caller without pay access: the
 * route never even reads the rate table for them, so there is nothing in the
 * payload to leak and nothing for a component to render by accident.
 */
export interface HrPerson {
  staffId: string;
  name: string;
  role: string;
  siteId: string | null;
  active: boolean;
  profile: StaffHrProfile | null;
  /** Computed holiday entitlement, with its working. Decision support. */
  entitlement: EntitlementResult;
  pay?: {
    /** The rate in force today, or null when none is recorded. */
    currentPence: number | null;
    /** The whole history, newest first. */
    history: StaffPayRate[];
  };
}

/** What GET /api/hr/profile answers. */
export interface HrProfileResponse {
  ok: boolean;
  /** False while migration 0075 is unapplied: the page says so out loud. */
  ready: boolean;
  /** Whether the caller may see pay at all. Drives the screen's copy, not its data. */
  includesPay: boolean;
  /**
   * Whether the caller may WRITE the employee file (`hr.edit`: owner + agency).
   *
   * A hint for the screen, never the lock: the PATCH route re-checks the role,
   * because a flag in a JSON payload is a suggestion to a browser.
   */
  canEdit: boolean;
  /** The London day the entitlement figures are as of. */
  asOfDay: string;
  people: HrPerson[];
  error?: string;
}
