import type { Role } from "@/lib/types";
import type { Tier } from "@/lib/practice-brain/types";
import {
  TOOL_CATALOG,
  accessMaxTier,
  catalogAllows,
  clearanceForRole,
  type CopilotAccess,
  type CopilotToolName,
  type RoleClearance,
} from "./clearance";

// ===========================================================================
// WHO MAY ASK THE CO-PILOT, AND WHAT IT MAY REACH FOR THEM.
//
// The co-pilot was owner-only: `/api/copilot` answered every other role with a
// flat 403. That is safe and useless — the practice manager (Blerta, a
// `client_coordinator`) runs the diary, the leads and the front desk all day and
// had no way to ask about any of it.
//
// This module is the whole of the widening. It is SCOPE, NOT CAPABILITY: not one
// new tool, not one new send, not one new read. The manager gets a SUBSET of the
// tools the owner already had, and the subset is decided here, from the session's
// role, on the server.
//
// ---------------------------------------------------------------------------
// WHY AN ALLOW-LIST AND NOT A DENY-LIST.
// ---------------------------------------------------------------------------
// COPILOT_TOOLS grows. It went from six tools to nineteen in three months, and
// every one of those additions was written by somebody thinking about the owner.
// A deny-list ("the manager may not have outstanding_balances") silently hands
// the manager tool number twenty on the day it is written, and nobody finds out
// until the tool that reads the takings ships. An allow-list hands her nothing
// she was not named for, and a new tool is invisible to her until somebody edits
// THIS file on purpose. That asymmetry is the entire safety argument, and it is
// the same one CLINICIAN_SLUGS makes about the nav (src/lib/nav.ts).
//
// ---------------------------------------------------------------------------
// WHY THE PROMPT IS NOT THE ENFORCEMENT.
// ---------------------------------------------------------------------------
// The system prompt tells the manager's co-pilot what it may not discuss, and
// that is worth having — a model that knows the rule answers gracefully instead
// of emitting a call that gets refused. But a prompt is a request. The tool
// schema handed to the model is filtered by `copilotToolsFor`, and every dispatch
// is checked again by `copilotToolAllowed` before it runs, so a model that
// hallucinates a tool name, or is talked into trying one by a patient note, gets
// a refusal string and not the data. Two mechanisms, both server-side, neither
// of them the model's good behaviour.
//
// ---------------------------------------------------------------------------
// PURE. No `server-only`, no DB, no env, no `Anthropic` import. Role in, names
// out. Everything here is a total function of its arguments, which is what lets
// the leak battery in scope.test.ts enumerate every role against every tool
// rather than sample a few.
// ===========================================================================

/**
 * How much of the co-pilot a session may reach.
 *
 * THE LEVELS AND THE DOMAINS THEY HOLD NOW LIVE IN clearance.ts, which is the
 * single exhaustive table; this module is what COMPOSES that table with the
 * session (role in, names out) and with the shapes the dispatch needs. The type
 * is re-exported here because a dozen callers already import `CopilotAccess`
 * from "./scope" and the location of a type is not worth a churn commit.
 */
export type { CopilotAccess, CopilotToolName, RoleClearance };

/**
 * Role -> access. A `satisfies Record<Role, ...>` map rather than a switch, so a
 * sixth role fails tsc HERE, before it can inherit anything by default. That is
 * the lesson `client_staff` taught this codebase: the nav is allow-by-default and
 * a new role added the obvious way inherits the practice.
 */
const ACCESS_BY_ROLE = {
  agency_admin: "full",
  client_owner: "full",
  // THE POINT OF THE MANAGER LANE. The practice manager tier.
  client_coordinator: "manager",
  // THE TWO NEW ROWS, AND WHAT THEY DO AND DO NOT MEAN.
  //
  // Both used to be "none": a clinician and a staff member had no co-pilot at
  // all, and widening either was called out as "a written decision, made here,
  // with its own tests". The Dental OS charter is that written decision (section
  // 2, W1-E: "a role -> tool-catalog map for owner / practice manager /
  // clinician / staff", and second-opinion mode is FOR the clinician), so the
  // rows are now named levels with their own catalogs and their own tests.
  //
  // WHAT THIS DOES NOT DO IS LET THEM IN. Reaching /api/copilot needs THREE
  // things and this is only the third:
  //   1. the nav module lock — "co-pilot" is in neither CLINICIAN_SLUGS nor
  //      STAFF_SLUGS, so `requireModuleApiAccess(auth, "co-pilot")` refuses both
  //      roles at the route today;
  //   2. the capability `system.copilot.ask`, whose default holders are owner,
  //      agency and the coordinator (capabilities/defaults.ts COPILOT_ACCESS);
  //   3. this map, which decides what a session that got through 1 and 2 reaches.
  // So both rows are DECLARED, TESTED AND INERT until an owner decision widens
  // (1) and (2). That ordering is on purpose: the safe thing to have written in
  // advance is the narrow catalog, not the open door.
  client_clinician: "clinician",
  client_staff: "staff",
} as const satisfies Record<Role, CopilotAccess>;

/**
 * The same table as a Map, and that is not tidiness.
 *
 * The obvious lookup — `(ACCESS_BY_ROLE as Record<string, ...>)[role] ?? "none"` —
 * WALKS THE PROTOTYPE CHAIN, so `copilotAccessForRole("constructor")` answered
 * with `Object` rather than "none". Nothing leaked (a function is not "full", so
 * every downstream check still refused) but the fail-closed default had a hole in
 * it, and a guard whose default can be skipped is not a default. A Map has no
 * prototype keys, so `Object.prototype` is simply not in the lookup space.
 * Enumerated in scope.test.ts, which is what found this.
 */
const ACCESS_LOOKUP = new Map<string, CopilotAccess>(Object.entries(ACCESS_BY_ROLE));

/**
 * The access this role gets. Unknown / missing role denies.
 *
 * FAIL-CLOSED ON PURPOSE: the argument is typed `Role`, so an unrecognised string
 * cannot arrive through a type-checked path, and the fallback is for the paths
 * that are not type-checked — a role column read from the database, a session
 * shape that drifts. "I do not recognise you" must never mean "have everything".
 */
export function copilotAccessForRole(role: Role | null | undefined): CopilotAccess {
  if (!role) return "none";
  return ACCESS_LOOKUP.get(role) ?? "none";
}

/**
 * THE MANAGER ALLOW-LIST. Six tools. Nothing else. Ever, without an edit here.
 *
 * HOW EACH ONE WAS DERIVED — the test is "does the practice manager already do
 * this job on this data, in a screen she already has":
 *
 *   appointments                  the diary. Her screen (Calendar) already shows it.
 *   search_patients               finding a patient. Her screen (Patients) already does.
 *   patient_record                one patient's operational record — and MONEY-PROJECTED
 *                                 before it leaves the tool (see projectPatientRecord).
 *   search_knowledge              the practice's own scripts, policies and prices, capped
 *                                 at HER clearance tier, not the owner's (see below).
 *   list_recent_assessment_leads  new enquiries. Her screen (Smile Assessment) has them.
 *   list_speed_to_lead            the Leads worklist. Her screen, her daily job.
 *
 * AND WHAT IS DELIBERATELY ABSENT, because the absences are the feature:
 *
 *   outstanding_balances   money, and money is the owner's view.
 *   practice_overview      an aggregate that CONTAINS money (total outstanding,
 *                          reactivation recoverable value, treatment recovery
 *                          value). This is the one a reasonable person would have
 *                          waved through as "just a summary" — it is the exact
 *                          shape the hold axis warns about: a permitted tool that
 *                          aggregates money.
 *   assessment_dropoff_summary   funnel conversion analytics. Marketing performance
 *                          is in the same bucket as ROI and reports.
 *   send_sms, send_email, nudge_lead, create_outreach_campaign,
 *   launch_outreach_campaign, create_landing_page, launch_landing_page,
 *   create_meta_campaign, publish_meta_campaign, create_patient
 *                          every WRITE. The brief is "operational questions
 *                          only", and a read-only allow-list is a claim that can
 *                          be checked in one line (see scope.test.ts) rather than
 *                          argued tool by tool. The manager keeps every one of
 *                          these actions in the module screens that own them,
 *                          behind those modules' own guards and kill switches.
 *
 * NO LONGER HAND-WRITTEN. The six names are DERIVED from clearance.ts — the
 * manager holds the read domains {patients, diary, leads, knowledge} and no act
 * domain at all, and these are exactly the tools that fall out of that. The list
 * is still exported, still asserted name-by-name in scope.test.ts, and still the
 * thing the non-widening snapshot pins; what changed is that a tool written next
 * year lands on it only if somebody files it under a domain she holds, rather
 * than by being added to a second list somebody forgot.
 */
export const MANAGER_COPILOT_TOOLS: readonly string[] = TOOL_CATALOG.manager;

/**
 * May this access level run this tool? The single predicate both the schema
 * filter and the dispatch gate consult, so the list the model is SHOWN and the
 * list the server will RUN cannot drift apart.
 *
 * `full` returns true for any name — that is exactly today's behaviour (an
 * unrecognised name falls to the dispatch's `default:` and answers "unknown
 * tool"), so the owner's path through this function is a no-op by construction.
 * Every other level is a strict allow-list over the derived catalog.
 */
export function copilotToolAllowed(access: CopilotAccess, name: string): boolean {
  return catalogAllows(access, name);
}

/**
 * The tool schemas this access level may be SHOWN. Generic over `{ name }` so
 * this module never has to import `Anthropic.Tool` (and therefore never has to
 * import tools.ts, which pulls in half the server).
 */
export function copilotToolsFor<T extends { name: string }>(
  access: CopilotAccess,
  tools: readonly T[],
): T[] {
  return tools.filter((t) => copilotToolAllowed(access, t.name));
}

/**
 * The practice-brain clearance tier a co-pilot session may read.
 *
 * The knowledge tree is tiered 1 General / 2 Operational / 3 Management /
 * 4 Confidential, and retrieval — not the model — is the security boundary
 * (`searchKnowledge` drops above-tier nodes before ranking). The owner co-pilot
 * has always asked for tier 4 with a `// employee scoping is handled later`
 * comment next to it. This is later.
 *
 * These values are not invented: `maxTierForRole` in
 * src/lib/practice-brain/clearance.ts already decides what each role may see
 * everywhere else in the platform, and scope.test.ts asserts that the tier this
 * function hands the co-pilot NEVER EXCEEDS the tier that function hands the same
 * role. Stated in clearance.ts alongside the domains rather than in a second map
 * here, so a level's tier and a level's tools are read and edited together; the
 * test is what stops it drifting from `maxTierForRole`.
 */
export function copilotKnowledgeTier(access: CopilotAccess): Tier {
  return accessMaxTier(access);
}

/**
 * THE WHOLE CLEARANCE MODEL, ONE ROW PER LOGIN — the table a person reads when
 * they ask "what can the receptionist see".
 *
 * `reachableToday` is the honest half: a row can be fully specified, fully
 * tested and still refused at the door, because reaching the co-pilot at all
 * needs the nav module lock and the `system.copilot.ask` capability as well as
 * this map. Derived from `CLINICIAN_SLUGS` / `STAFF_SLUGS` semantics rather than
 * imported, because importing nav.ts here would drag lucide-react and a
 * server-only transitive into a module whose entire value is that it is pure;
 * clearance.test.ts imports both and asserts they agree.
 */
const REACHABLE_TODAY = new Set<Role>([
  "agency_admin",
  "client_owner",
  "client_coordinator",
  // SWITCHED ON by the coordinator's ruling of 3 Sep 2026: "co-pilot" is now in
  // CLINICIAN_SLUGS and STAFF_SLUGS and both roles hold `system.copilot.ask`.
  // Every row of the clearance model is now live, which is what makes
  // clearance.test.ts's agreement check between this set and the REAL
  // `canRoleAccessModule` worth having rather than decorative.
  "client_clinician",
  "client_staff",
]);

export function copilotClearanceForRole(role: Role): RoleClearance {
  const access = copilotAccessForRole(role);
  return clearanceForRole(role, access, REACHABLE_TODAY.has(role));
}

// ---------------------------------------------------------------------------
// THE PATIENT RECORD PROJECTION
// ---------------------------------------------------------------------------
//
// `patient_record` is the one allowed tool that carries money: a patient's
// `lifetimeSpend`, and every treatment plan's `planned` and `outstanding`. Left
// alone it is a money tool with a patient's name on it, and "look up my twenty
// biggest patients and add up their lifetime spend" is a takings report.
//
// Denying the tool outright was the other option and it is worse: the patient
// record is the manager's core screen — who they are, when they were last in,
// what recall is due, what they consented to, what the clinician wrote, what is
// in the diary for them. All of that is operational and none of it is money.
//
// SO THE FIELDS ARE ALLOW-LISTED, NOT THE MONEY DENY-LISTED, for the same reason
// the tools are. A deny-list breaks the day `getPatientDetail` grows a field —
// and it already holds two the dispatch does not currently return (`outstanding`
// and `credit`), so that day is not hypothetical.
// ---------------------------------------------------------------------------

/** Top-level keys of a `patient_record` result a manager may keep. */
export const MANAGER_PATIENT_RECORD_FIELDS: readonly string[] = [
  "found",
  "patient",
  "notes",
  "treatmentPlans",
  "appointmentHistoryCount",
  "appointmentHistory",
  "reads",
] as const;

/**
 * Keys of one treatment plan a manager may keep: WHAT was planned and WHETHER it
 * was accepted. `planned` and `outstanding` are the plan's money and are dropped.
 */
export const MANAGER_PLAN_FIELDS: readonly string[] = ["name", "acceptedAt"] as const;

/** The sentence the model relays when a manager asks what a plan is worth. */
export const MANAGER_MONEY_NOTE =
  "Financial figures are not part of this login: lifetime spend and treatment plan values are the practice owner's view. Report what is here and say plainly that the money is not visible to you.";

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

/**
 * Project a built `patient_record` payload for this access level.
 *
 * `full` returns the payload untouched — the same object, so the owner's result
 * is not merely equal to what it was, it is the thing it was.
 *
 * Anything else gets the allow-listed projection. `none` takes the same branch as
 * `manager` rather than a third one: it is unreachable (the dispatch gate refuses
 * the tool before this is called) and an unreachable branch is exactly where a
 * permissive default hides, so it fails to the narrower answer.
 */
export function projectPatientRecord(
  payload: Record<string, unknown>,
  access: CopilotAccess,
): Record<string, unknown> {
  if (access === "full") return payload;

  const projected = pick(payload, MANAGER_PATIENT_RECORD_FIELDS);

  const plans = projected.treatmentPlans;
  if (Array.isArray(plans)) {
    projected.treatmentPlans = plans.map((plan) =>
      plan && typeof plan === "object" ? pick(plan as Record<string, unknown>, MANAGER_PLAN_FIELDS) : plan,
    );
  }

  projected.moneyNote = MANAGER_MONEY_NOTE;
  return projected;
}

/**
 * The refusal a denied tool answers with.
 *
 * Written for the MODEL to relay to a person, not for a log: it says what is out
 * of reach, whose view it is, and where the answer lives, so the manager gets a
 * straight sentence instead of "an error occurred". It never names the tool that
 * was refused — a refusal that enumerates the owner's toolbox is a smaller leak
 * of the same kind.
 */
const MANAGER_REFUSAL =
  "That is not available on this login. Financial figures, business reports and marketing performance, the system controls, and sending anything to a patient are the practice owner's view. Tell the manager plainly that you cannot see it and that the owner can, and do not try another way to get at it.";

/**
 * PER-LEVEL REFUSAL WORDING, and it is not decoration.
 *
 * A refusal is copy a person reads, and the manager's sentence is wrong for the
 * other two: telling a nurse that "business reports and marketing performance
 * are the owner's view" answers a question she did not ask and describes a
 * toolbox she should not be thinking about at all. Each sentence names only the
 * door that was closed and where the answer actually lives for THAT person.
 *
 * The default (no argument) is the manager's, byte-for-byte, so every existing
 * caller and every existing test keeps the string it had.
 */
const REFUSAL_BY_ACCESS: Record<CopilotAccess, string> = {
  full: MANAGER_REFUSAL,
  manager: MANAGER_REFUSAL,
  clinician:
    "That is not part of this login. This co-pilot answers about your patients, your diary and how the practice does things, and it takes no actions. The practice's money, its reports and its marketing sit with the practice owner, and anything that has to be sent to a patient is sent from Conversations by the front desk. Say so plainly and do not look for another way to it.",
  staff:
    "That is not part of this login. This co-pilot answers about your own work only: your shifts, your holiday and your documents. Anything about patients, the diary or the practice is not something you can see here, and the practice manager can help with it. Say so plainly and do not look for another way to it.",
  none: MANAGER_REFUSAL,
};

export function copilotToolRefusal(access?: CopilotAccess): string {
  return JSON.stringify({
    denied: true,
    error: "out_of_scope",
    message: access ? REFUSAL_BY_ACCESS[access] : MANAGER_REFUSAL,
  });
}
