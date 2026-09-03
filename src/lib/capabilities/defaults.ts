import type { Role } from "@/lib/types";
import { CAPABILITIES, type Capability } from "./keys";

// ===========================================================================
// WHAT EACH ROLE CAN DO BEFORE ANYBODY TOUCHES A SWITCH.
//
// NOTHING HERE WAS INVENTED. Every row is DERIVED from the guard that already
// enforces that act today:
//
//   requireOwnerRole              -> agency_admin + client_owner
//   requireApproverRole           -> those two + client_coordinator
//   requirePatientAdmin           -> PATIENT_ADMIN_ROLES
//   requireClinicalWriteRole      -> CLINICAL_WRITE_ROLES
//   requireModuleApiAccess(slug)  -> every role canRoleAccessModule allows
//
// `DEFAULT_PROVENANCE` records WHICH of those each key came from, and
// `non-widening.test.ts` re-derives every row from the real constants and the
// real `canRoleAccessModule`. So this file cannot quietly disagree with the
// guards it claims to describe: if `APPROVER_ROLES` gains a role, or
// `STAFF_SLUGS` gains a module, the affected rows fail there rather than
// silently meaning something new.
//
// THE DELIBERATE DEPARTURES ARE NAMED, NOT SMUGGLED. Two of them, both in that
// test as a named delta rather than folded into the numbers here:
//
//   TIGHTENED  the four clinical writes move from "every role that reaches the
//              patient record" to CLINICAL_WRITE_ROLES. The coordinator (the
//              receptionist) loses the ability to author a BPE, a perio chart,
//              a medical history, or to retract one. This is a real loss for a
//              real person and it is signed off, not incidental.
//
//   WIDENED    client_clinician gains `people.absence.request`. No effective
//              access changes today: POST /api/absence still calls
//              requireApproverRole and still refuses them. The capability is
//              granted so that the self-request fix — a separate, deliberate
//              change — is not silently blocked afterwards by a permission
//              nobody knew to set.
//
// THIS FILE IS PURE. No `import "server-only"`, no nav import, no env, no DB.
// The nav derivation lives in the TEST, which is what keeps module access
// (may you see this area) and capability (may you do this thing) orthogonal:
// the capability layer reads nothing from the nav at runtime.
// ===========================================================================

/** Every role the platform has. A sixth fails tsc in the maps below first. */
export const ALL_ROLES: readonly Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
] as const;

/**
 * Where a key's default holders come from. Machine-checkable provenance, so the
 * derivation is asserted rather than described.
 *
 * `plus` may only ever name a role that did NOT exist at the baseline commit —
 * i.e. `client_staff`. A role with a baseline cannot be widened here without
 * appearing in the named WIDENED delta in the test.
 */
export type CapabilityProvenance =
  | { base: "owner"; plus?: readonly Role[] }
  | { base: "approver"; plus?: readonly Role[] }
  | { base: "patient-admin"; plus?: readonly Role[] }
  | { base: "clinical-write"; plus?: readonly Role[] }
  | { base: "pay-access"; plus?: readonly Role[] }
  | { base: "module"; slug: string; agreesWith?: readonly string[]; plus?: readonly Role[] }
  | { base: "all"; why: string };

const OWNER: readonly Role[] = ["agency_admin", "client_owner"];
const APPROVER: readonly Role[] = ["agency_admin", "client_owner", "client_coordinator"];
const PATIENT_ADMIN: readonly Role[] = ["agency_admin", "client_owner", "client_coordinator"];
const CLINICAL_WRITE: readonly Role[] = ["agency_admin", "client_owner", "client_clinician"];
/**
 * The pay tier. THE SAME TWO ROLES as OWNER today, and deliberately its own base
 * rather than `{ base: "owner" }`.
 *
 * They answer different questions and are meant to diverge: the whole point of
 * `hr.view-pay` is that a named practice manager can be granted it without being
 * made an owner. Writing it as "owner" would record the wrong reason, and the
 * first per-person grant would make the comment a lie. The test re-derives this
 * from `PAY_ACCESS_ROLES` in src/lib/hr/access.ts, so the two cannot drift.
 */
const PAY_ACCESS: readonly Role[] = ["agency_admin", "client_owner"];

/**
 * The roles that may ASK the co-pilot. THE SAME THREE as APPROVER today, and
 * deliberately its own list rather than a reuse of it, for the reason PAY_ACCESS
 * states: they answer different questions and are meant to diverge.
 *
 * The practice manager joined in the manager-co-pilot lane (agent expansion,
 * Wave 3 #5) because asking the co-pilot stopped being the same act as reading
 * the owner's data: `copilotAccessForRole` (src/lib/copilot/scope.ts) hands her
 * session a six-tool operational schema, caps her practice-brain clearance at her
 * own tier and projects the money out of the patient record, all server-side.
 * Writing it as "approver" would record the wrong reason — approving holiday has
 * nothing to do with it — and the first time the two lists diverge the comment
 * would be a lie.
 */
const COPILOT_ACCESS: readonly Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  // WIDENED (Dental OS, W1-E, on the coordinator's written ruling of 3 Sep 2026).
  //
  // The reason PAY_ACCESS gives for being its own list is exactly why this one
  // could move without dragging anything with it: holding `system.copilot.ask`
  // means "may ASK the co-pilot", and it has never meant "may read what the owner
  // reads". `copilotAccessForRole` (src/lib/copilot/scope.ts) hands each of these
  // two a catalog of its own — the clinician six read tools at practice-brain tier
  // 1 with no act domain, the staff member ONE tool about themselves — and the
  // dispatch re-derives that from the session on every call.
  //
  // So this is a widening of WHO MAY ASK, and deliberately not of what any answer
  // contains. Named in non-widening.test.ts with this reason.
  "client_clinician",
  "client_staff",
];

/** The roles that reach a module today, spelled out per slug this file depends on. */
const MODULE_HOLDERS: Record<string, readonly Role[]> = {
  // The co-pilot: owner, agency and the practice manager (scoped — see above).
  "co-pilot": COPILOT_ACCESS,
  // Front-desk modules: the three original roles, and neither new role.
  "no-show-defence": APPROVER,
  onboarding: APPROVER,
  conversations: APPROVER,
  fp17: APPROVER,
  recall: APPROVER,
  reactivation: APPROVER,
  "treatment-coordinator": APPROVER,
  // The patient record: the four record roles. NOT client_staff.
  patients: ["agency_admin", "client_owner", "client_coordinator", "client_clinician"],
  // Clocking: owner, agency, the practice manager, and the clinician (allow-listed).
  "staff-check-in": ["agency_admin", "client_owner", "client_coordinator", "client_clinician"],
};

/**
 * The provenance of every key. Exhaustive over `Capability` — a new key with no
 * entry is a tsc error here, which is the point: nobody ships a capability
 * without stating where its default came from.
 */
export const DEFAULT_PROVENANCE: Record<Capability, CapabilityProvenance> = {
  // diary
  "diary.appointment.move": { base: "patient-admin" },
  "diary.appointment.cancel": { base: "module", slug: "no-show-defence" },
  "diary.entry.write": { base: "patient-admin" },

  // patient
  "patient.profile.edit": { base: "patient-admin" },
  "patient.status.change": { base: "patient-admin" },
  "patient.create": { base: "module", slug: "onboarding" },
  // DELIBERATELY the whole record tier, clinician and receptionist alike: a note
  // reading "patient rang about their bill" is exactly what this is for.
  "patient.note.write": { base: "module", slug: "patients" },

  // clinical — the TIGHTENED four
  "clinical.chart.write": { base: "clinical-write" },
  "clinical.perio.write": { base: "clinical-write" },
  "clinical.medical-history.write": { base: "clinical-write" },
  "clinical.record.retract": { base: "clinical-write" },
  "clinical.fp17.view": { base: "module", slug: "fp17" },

  // messaging
  "messaging.patient.reply": { base: "module", slug: "conversations" },
  "messaging.lifecycle.send": {
    base: "module",
    slug: "recall",
    // The three lifecycle send routes carry three different module slugs, and all
    // three admit the same roles. Asserted in the test rather than assumed.
    agreesWith: ["reactivation", "treatment-coordinator"],
  },
  "messaging.campaign.launch": { base: "owner" },

  // people
  "people.absence.request": {
    base: "all",
    why: "everybody who works here may ask for time off. The ROUTE still refuses a non-approver today; this key exists so the self-service fix is not blocked by a permission nobody set.",
  },
  "people.absence.approve": { base: "approver" },
  // Clocking yourself is not an approver act. The fifth role is added on top
  // because a nurse clocking herself in is the whole reason it exists.
  "people.clock.self": { base: "module", slug: "staff-check-in", plus: ["client_staff"] },
  "people.clock.record-for-other": { base: "approver" },

  // people — the HR lane. Every row is the guard that is STILL on the route
  // beside the capability, so today the key can narrow a person and cannot widen
  // one. Derived, not chosen: see the header of each route.
  //
  // THE ROTA ROW IS THE ONE THAT MOVED. At the baseline the rota was
  // requireOwnerRole and the practice manager could not open her own rota; the
  // campaign widened it to approver by decision, and these three keys record
  // that widening rather than inherit it silently.
  "rota.view": { base: "approver" },
  "rota.edit": { base: "approver" },
  "rota.publish": { base: "approver" },
  "hours.view": { base: "approver" },
  // OFF FOR THE COORDINATOR BY DEFAULT. The practice manager runs the month and
  // does not see the rates in it. This is the only HR key narrower than its module.
  "hr.view-pay": { base: "pay-access" },
  "hr.view-documents": { base: "approver" },
  "hr.manage-documents": { base: "approver" },
  // Publishing a policy asks every member of staff to affirm it, and the version
  // can never be edited afterwards. Owner + agency.
  "esign.manage-policies": { base: "owner" },

  // reports
  "reports.run": { base: "owner" },
  "reports.nhs.view": { base: "owner" },
  "reports.allocation.view": { base: "owner" },

  // system
  "system.toggle": { base: "owner" },
  "system.copilot.ask": { base: "module", slug: "co-pilot" },

  // security — LOCKED, so this is the ONLY way to hold it
  "security.capability.manage": { base: "owner" },
};

function baseHolders(p: CapabilityProvenance): readonly Role[] {
  switch (p.base) {
    case "owner":
      return OWNER;
    case "approver":
      return APPROVER;
    case "patient-admin":
      return PATIENT_ADMIN;
    case "clinical-write":
      return CLINICAL_WRITE;
    case "pay-access":
      return PAY_ACCESS;
    case "all":
      return ALL_ROLES;
    case "module": {
      const holders = MODULE_HOLDERS[p.slug];
      if (!holders) {
        // Loud, not silent: an unmapped slug would otherwise default to nobody,
        // which reads in the grid as "this role never had it" — a lie.
        throw new Error(`capability provenance names module "${p.slug}" with no holders mapped`);
      }
      return holders;
    }
  }
}

/** The roles that hold a capability by default, derived from its provenance. */
export function defaultHoldersOf(key: Capability): readonly Role[] {
  const p = DEFAULT_PROVENANCE[key];
  const base = baseHolders(p);
  const plus = "plus" in p ? (p.plus ?? []) : [];
  return ALL_ROLES.filter((r) => base.includes(r) || plus.includes(r));
}

function buildRoleDefaults(): Record<Role, ReadonlySet<Capability>> {
  const out = {} as Record<Role, Set<Capability>>;
  for (const role of ALL_ROLES) out[role] = new Set<Capability>();
  for (const def of CAPABILITIES) {
    const key = def.key as Capability;
    for (const role of defaultHoldersOf(key)) out[role].add(key);
  }
  return out as unknown as Record<Role, ReadonlySet<Capability>>;
}

/**
 * The role's capability set before any per-person override.
 *
 * Frozen at module load, and `resolveCapabilities` always copies before mutating,
 * so no caller can reach in and edit the platform's defaults for every request in
 * the process. (`cache()` memoises per request; the defaults do not.)
 */
export const ROLE_DEFAULTS: Record<Role, ReadonlySet<Capability>> = buildRoleDefaults();

/**
 * The role's defaults MINUS every destructive key.
 *
 * Used when the override overlay cannot be read. An unreadable overlay is not
 * proof of a grant: it is proof that we do not know. Reads keep working, writes
 * stop, and the failure is logged loudly — which is a bad afternoon rather than
 * an unattributable clinical record.
 */
export function safeDefaults(role: Role): ReadonlySet<Capability> {
  const out = new Set<Capability>();
  for (const def of CAPABILITIES) {
    if (def.destructive) continue;
    const key = def.key as Capability;
    if (ROLE_DEFAULTS[role].has(key)) out.add(key);
  }
  return out;
}
