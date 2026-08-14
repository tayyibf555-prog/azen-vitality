import type { OpeningHours, Weekday } from "@/lib/types";

export type { Weekday };

/**
 * The lifecycle of a shift.
 *
 * `cancelled` and `removed` are NOT synonyms and the difference is load-bearing:
 *  - `cancelled` frees the slot. Deactivating a staff member cancels their future
 *    shifts precisely so somebody else is generated into them.
 *  - `removed` is a TOMBSTONE left by a person deleting a shift. The slot stays
 *    empty until a person says otherwise. Without it a deletion is just an absent
 *    row, which is indistinguishable from an ungenerated slot, so the next
 *    generation puts the shift straight back.
 */
export type RotaShiftStatus = "scheduled" | "notified" | "cancelled" | "removed";

/**
 * Who decided this shift.
 *
 * `manual` means a human did, and the generator must never overwrite it. This is
 * the single fact that stops auto-generation from silently undoing an edit.
 */
export type RotaShiftOrigin = "generated" | "manual";

/** Statuses that mean the shift is really happening (someone is expected in). */
export const LIVE_SHIFT_STATUSES: readonly RotaShiftStatus[] = ["scheduled", "notified"] as const;

/** Whether a shift is still live (as opposed to cancelled or tombstoned). */
export function isLiveShift(shift: Pick<RotaShift, "status">): boolean {
  return LIVE_SHIFT_STATUSES.includes(shift.status ?? "scheduled");
}

/** Which weekdays a staff member is available to work. Missing key = not available. */
export type Availability = Partial<Record<Weekday, boolean>>;

/** A rota-able staff member (an employee, not a patient). */
export interface RotaStaff {
  id: string;
  clientId: string;
  /** Home site, or null if the person floats across sites. */
  siteId: string | null;
  name: string;
  /** Coverage role, e.g. "dentist" | "nurse" | "reception". Free text, matched against config. */
  role: string;
  /** E.164 phone; null means they cannot be texted (the sweep skips them). */
  phone: string | null;
  email: string | null;
  active: boolean;
  availability: Availability;
  createdAt?: string;
}

/**
 * Coverage + automation config for a client.
 * - rolesNeeded: how many people of each role to schedule per open day per site.
 * - notifyLeadDays: only text shifts starting within this many days from now.
 * - generateWeeksAhead: how many weeks ahead the sweep keeps shifts generated.
 */
export interface RotaConfig {
  rolesNeeded: Record<string, number>;
  notifyLeadDays: number;
  generateWeeksAhead: number;
  /**
   * The two coverage roles that work as a pair: a clinician and the person
   * supporting them.
   *
   * THREE STATES, AND ALL THREE ARE DIFFERENT.
   *   a pair    this practice pairs these two roles
   *   null      this practice does not work in pairs, and that is a decision
   *   absent    nothing has been said, so the default pair applies
   *
   * The last two are the ones worth separating: a config saved before pairing
   * existed has no key at all, and reading that as "pairing off" would silently
   * strip the pairing from every practice already using the rota. `resolvePairRoles`
   * is the single place that distinction is made.
   *
   * It lives in config rather than as a constant because "dentist works with nurse"
   * is a fact about a practice, not about dentistry: a hygienist-led site pairs
   * differently, and hard-coding the pair would quietly mispair them.
   */
  pairRoles?: PairRoles | null;
}

/** A clinician role and the support role that works alongside it. */
export interface PairRoles {
  clinical: string;
  support: string;
}

/** What a practice pairs when it has not said otherwise. */
export const DEFAULT_PAIR_ROLES: PairRoles = { clinical: "dentist", support: "nurse" };

/**
 * The pairing in force for a config: the practice's own, the default when it has
 * never said, or null when it has said "we do not pair".
 *
 * Every pairing rule goes through here so `undefined` and `null` cannot come to
 * mean the same thing in one module and different things in another.
 */
export function resolvePairRoles(config: Pick<RotaConfig, "pairRoles">): PairRoles | null {
  if (config.pairRoles === null) return null;
  if (config.pairRoles === undefined) return DEFAULT_PAIR_ROLES;
  return config.pairRoles;
}

/** A generated shift for one staff member on one day at one site. */
export interface RotaShift {
  id?: string;
  clientId: string;
  siteId: string;
  staffId: string;
  /** London calendar day, `YYYY-MM-DD`. */
  shiftDate: string;
  /** Wall-clock start/end, `HH:MM`, taken from that day's opening hours. */
  startTime: string;
  endTime: string;
  role: string;
  status?: RotaShiftStatus;
  notifiedAt?: string | null;
  createdAt?: string;
  /** Defaults to "generated" when absent, so an un-migrated row reads correctly. */
  origin?: RotaShiftOrigin;
  /** The nurse's dentist, or the dentist's nurse. Null means genuinely unpaired. */
  pairedStaffId?: string | null;
  /** A free-text note from whoever edited the shift ("covering reception till 2"). */
  note?: string | null;
  /** When this shift was last included in a published version of its week. */
  publishedAt?: string | null;
  /** The version of the week's publication this shift was last included in. */
  publishedVersion?: number | null;
}

/** A site's identity + opening hours, the subset the generator needs. */
export interface RotaSite {
  id: string;
  name: string;
  openingHours: OpeningHours;
}
