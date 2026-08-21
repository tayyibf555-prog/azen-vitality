import type { Role } from "@/lib/types";
import type { Tier } from "@/lib/practice-brain/types";

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
 * - `full`    — the owner surface, byte-for-byte what it was: every tool, tier-4
 *               knowledge, unprojected results.
 * - `manager` — the practice manager: the operational read tools only.
 * - `none`    — no co-pilot at all. The route answers 403 before a turn starts.
 */
export type CopilotAccess = "full" | "manager" | "none";

/**
 * Role -> access. A `satisfies Record<Role, ...>` map rather than a switch, so a
 * sixth role fails tsc HERE, before it can inherit anything by default. That is
 * the lesson `client_staff` taught this codebase: the nav is allow-by-default and
 * a new role added the obvious way inherits the practice.
 */
const ACCESS_BY_ROLE = {
  agency_admin: "full",
  client_owner: "full",
  // THE POINT OF THIS LANE. The practice manager tier.
  client_coordinator: "manager",
  // Deliberately none, and not an oversight. A clinician has the diary and the
  // patient database in their own screens; a co-pilot that reads across the
  // practice is a different thing, and neither role has ever had it. Widening
  // either is a written decision, made here, with its own tests.
  client_clinician: "none",
  client_staff: "none",
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
 */
export const MANAGER_COPILOT_TOOLS: readonly string[] = [
  "appointments",
  "search_patients",
  "patient_record",
  "search_knowledge",
  "list_recent_assessment_leads",
  "list_speed_to_lead",
] as const;

const MANAGER_TOOL_SET: ReadonlySet<string> = new Set(MANAGER_COPILOT_TOOLS);

/**
 * May this access level run this tool? The single predicate both the schema
 * filter and the dispatch gate consult, so the list the model is SHOWN and the
 * list the server will RUN cannot drift apart.
 *
 * `full` returns true for any name — that is exactly today's behaviour (an
 * unrecognised name falls to the dispatch's `default:` and answers "unknown
 * tool"), so the owner's path through this function is a no-op by construction.
 */
export function copilotToolAllowed(access: CopilotAccess, name: string): boolean {
  if (access === "full") return true;
  if (access === "manager") return MANAGER_TOOL_SET.has(name);
  return false;
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
 * role. Retyping them here rather than importing keeps this module free of the
 * practice-brain's own dependency graph; the test is what stops the two drifting.
 */
const TIER_BY_ACCESS: Record<CopilotAccess, Tier> = {
  full: 4,
  manager: 2,
  none: 1,
};

export function copilotKnowledgeTier(access: CopilotAccess): Tier {
  return TIER_BY_ACCESS[access];
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
export function copilotToolRefusal(): string {
  return JSON.stringify({
    denied: true,
    error: "out_of_scope",
    message:
      "That is not available on this login. Financial figures, business reports and marketing performance, the system controls, and sending anything to a patient are the practice owner's view. Tell the manager plainly that you cannot see it and that the owner can, and do not try another way to get at it.",
  });
}
