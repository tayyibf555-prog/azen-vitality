// ---------------------------------------------------------------------------
// Holiday and absence: domain types.
//
// Types and constant data only. Every PREDICATE lives in `./rules.ts` with a
// sibling test, so no rule can hide in a React closure (this repo shipped five
// defects that way). Components receive objects computed by `rules.ts`, never
// raw rows plus an inline condition.
// ---------------------------------------------------------------------------

/** Why someone is away. Mirrors the `kind` CHECK in migration 0067. */
export type AbsenceKind = "holiday" | "sick" | "training" | "unpaid" | "other";

/**
 * The lifecycle of a request. `refused` and `cancelled` are terminal and, crucially,
 * NON-BLOCKING: neither may ever stop a later overlapping request, and neither may
 * take a staff member off the generated rota.
 */
export type AbsenceStatus = "pending" | "approved" | "refused" | "cancelled";

/** Every valid kind, in the order the request form offers them. */
export const ABSENCE_KINDS: readonly AbsenceKind[] = [
  "holiday",
  "sick",
  "training",
  "unpaid",
  "other",
] as const;

/** Every valid status. */
export const ABSENCE_STATUSES: readonly AbsenceStatus[] = [
  "pending",
  "approved",
  "refused",
  "cancelled",
] as const;

/**
 * The statuses that COUNT when looking for a clash: an outstanding request and an
 * agreed absence both occupy the person's diary. A refused or cancelled request is
 * a record of something that did not happen and must never block anything.
 */
export const BLOCKING_STATUSES: readonly AbsenceStatus[] = ["pending", "approved"] as const;

/** One absence request. Dates are inclusive London calendar days, `YYYY-MM-DD`. */
export interface Absence {
  id: string;
  clientId: string;
  /** The staff member's home site, or null when they float across sites. */
  siteId: string | null;
  staffId: string;
  kind: AbsenceKind;
  /** Inclusive first day away, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive last day away, `YYYY-MM-DD`. Never before `startDate`. */
  endDate: string;
  status: AbsenceStatus;
  note: string | null;
  /** app_user id of whoever raised the request; null when auth is not enforced. */
  requestedBy: string | null;
  /** app_user id of whoever approved or refused it. */
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt?: string;
}

/** The fields a new request supplies. Everything else is derived server-side. */
export interface AbsenceRequestInput {
  staffId: string;
  kind: AbsenceKind;
  startDate: string;
  endDate: string;
  note?: string | null;
}

/** The decision a manager records against a pending request. */
export type AbsenceDecision = "approved" | "refused";

/**
 * An absence plus everything the UI needs to render it, all COMPUTED in `rules.ts`.
 * The components take these rows and render them; they contain no conditions of
 * their own.
 */
export interface AbsenceRow extends Absence {
  /** Whether the current actor may approve or refuse this row right now. */
  canDecide: boolean;
  /** Whether the current actor may cancel this row right now. */
  canCancel: boolean;
  /** Ids of the same person's other pending/approved absences that overlap this one. */
  overlapIds: string[];
  /** Inclusive calendar days the absence spans (not working days). */
  days: number;
  /** True when the last day is already behind us. */
  past: boolean;
  /** True when the absence covers the London day of `now`. */
  current: boolean;
}

/** The headline figures above the list. Computed by `summariseAbsences`. */
export interface AbsenceSummary {
  /** Requests still awaiting a decision. */
  pending: number;
  /** Approved absences that have not finished yet. */
  upcoming: number;
  /** People whose approved absence covers today. */
  awayToday: number;
  /** Every row in the loaded window, whatever its status. */
  total: number;
}
