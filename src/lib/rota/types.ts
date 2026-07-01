import type { OpeningHours, Weekday } from "@/lib/types";

export type { Weekday };

/** The lifecycle of a generated shift. */
export type RotaShiftStatus = "scheduled" | "notified" | "cancelled";

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
}

/** A site's identity + opening hours, the subset the generator needs. */
export interface RotaSite {
  id: string;
  name: string;
  openingHours: OpeningHours;
}
