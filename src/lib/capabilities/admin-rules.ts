import type { Role } from "@/lib/types";
import { isCapability, isLocked, type Capability } from "./keys";

// ===========================================================================
// WHO MAY EDIT WHOSE ROW.
//
// Pure and framework-free, so the API route and the grid that greys the cells
// read the SAME rules. The route is the enforcement; the greying is courtesy.
//
// V1 IS OWNER-ONLY, and that is a decision, not a shortcut. From the client call:
// "these are decisions me and Dr S make". Dr S is the client_owner. The decision
// is joint; the ACCOUNT is the owner's. And the moment a coordinator can write
// this table, three escalation vectors open that owner-only closes for free.
//
// The three rules are implemented anyway, and tested, because they are what the
// coordinator path needs the day it is asked for — and because two of them
// (no self-edit, no privilege amplification) are worth having even for an owner:
//
//   1. NO SELF-EDIT. Nobody edits their own row. Mirrors `absence/rules.ts`
//      (nobody approves their own holiday) — same reasoning, same shape.
//   2. NO PRIVILEGE AMPLIFICATION. An actor may not grant a capability they do
//      not themselves hold. A no-op for an owner; the whole point for anyone else.
//   3. NO EDITING UPWARD OR SIDEWAYS. Nobody may edit an owner's or an
//      agency_admin's row. (agency_admin is additionally blocked by the SCHEMA:
//      `app_user.client_id` is null for them and a null cannot satisfy the
//      composite tenant FK in migration 0072, so no override row can exist.)
//
// And on top of all three: `security.capability.manage` is LOCKED, so it can
// never travel through this surface at all.
// ===========================================================================

/** Roles that may open the permissions screen and write to it. */
export const CAPABILITY_ADMIN_ROLES: readonly Role[] = ["agency_admin", "client_owner"];

/**
 * Roles whose permission rows nobody may edit here.
 *
 * EXPORTED so the grid and the guard are the same list. The permissions route
 * used to answer `protectedRoles: ["agency_admin", "client_owner"]` — the same
 * two roles, retyped, with nothing pinning the two copies together. It failed
 * safe (the server refuses regardless of what the grid draws), but the failure
 * mode of a third protected role would be an editable-looking cell that 403s on
 * click, which reads as a broken screen rather than as a rule.
 */
export const PROTECTED_SUBJECT_ROLES: readonly Role[] = ["agency_admin", "client_owner"];

export interface AdminActor {
  id: string;
  role: Role;
  /** What the actor themselves holds, resolved. Used for rule 2. */
  capabilities: ReadonlySet<Capability>;
}

export interface AdminSubject {
  id: string;
  role: Role;
}

export type AdminRefusal =
  | "not-an-administrator"
  | "no-self-edit"
  | "subject-is-protected"
  | "unknown-capability"
  | "capability-is-locked"
  | "actor-lacks-capability";

export interface AdminDecision {
  ok: boolean;
  /** Present only when ok is false. A stable code, not a sentence. */
  refusal?: AdminRefusal;
}

const ALLOW: AdminDecision = { ok: true };
const refuse = (refusal: AdminRefusal): AdminDecision => ({ ok: false, refusal });

/** True when this role may open the permissions screen at all. */
export function canAdministerCapabilities(role: Role): boolean {
  return CAPABILITY_ADMIN_ROLES.includes(role);
}

/** True when this person's row may be edited by anybody (rule 3, subject side). */
export function isProtectedSubject(role: Role): boolean {
  return PROTECTED_SUBJECT_ROLES.includes(role);
}

/**
 * May `actor` set `capability` to `granted` on `subject`?
 *
 * Every refusal is a code, so the route can answer 403 with a message the owner
 * can act on rather than a bare "forbidden".
 */
export function canEditCapability(
  actor: AdminActor,
  subject: AdminSubject,
  capability: string,
  granted: boolean,
): AdminDecision {
  if (!canAdministerCapabilities(actor.role)) return refuse("not-an-administrator");
  // Rule 1, checked on identity not on role: an owner editing "the owner row" is
  // usually editing themselves, and even when it is not, see rule 3.
  if (actor.id === subject.id) return refuse("no-self-edit");
  if (isProtectedSubject(subject.role)) return refuse("subject-is-protected");
  if (!isCapability(capability)) return refuse("unknown-capability");
  if (isLocked(capability)) return refuse("capability-is-locked");
  // Rule 2 applies to GRANTS only. Taking something away that you do not hold
  // yourself is not an escalation, and refusing it would stop an owner revoking a
  // clinical write they personally never use.
  if (granted && !actor.capabilities.has(capability)) return refuse("actor-lacks-capability");
  return ALLOW;
}

/** May `actor` reset `subject`'s row for `capability` back to the role default? */
export function canResetCapability(
  actor: AdminActor,
  subject: AdminSubject,
  capability: string,
): AdminDecision {
  if (!canAdministerCapabilities(actor.role)) return refuse("not-an-administrator");
  if (actor.id === subject.id) return refuse("no-self-edit");
  if (isProtectedSubject(subject.role)) return refuse("subject-is-protected");
  if (!isCapability(capability)) return refuse("unknown-capability");
  // A locked key never had an effective override, so a reset is a no-op — but it
  // is refused rather than silently accepted, so the UI never shows a control
  // that appears to do something and does not.
  if (isLocked(capability)) return refuse("capability-is-locked");
  return ALLOW;
}

/** English for a refusal code, for the API envelope and the grid. */
export const REFUSAL_MESSAGE: Record<AdminRefusal, string> = {
  "not-an-administrator": "Only the practice owner can change permissions.",
  "no-self-edit": "You cannot change your own permissions. Ask the other owner.",
  "subject-is-protected": "An owner's permissions cannot be changed here.",
  "unknown-capability": "That is not a permission this platform has.",
  "capability-is-locked": "This permission comes with being an owner and cannot be switched on for anyone else.",
  "actor-lacks-capability": "You cannot give somebody a permission you do not have yourself.",
};
