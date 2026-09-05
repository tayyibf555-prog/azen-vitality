import type { Role } from "@/lib/types";
import type { Tier } from "@/lib/practice-brain/types";

// ===========================================================================
// THE CLEARANCE MODEL: ONE EXHAUSTIVE TABLE OF WHO MAY ASK THE CO-PILOT WHAT.
//
// scope.ts was the first half of this — an allow-list of six tool NAMES for the
// practice manager, hand-written and hand-maintained. It is a good list and it
// held, but it does not scale to five roles: five hand-written name lists is
// twenty-one decisions per role restated five times, and the failure mode is
// silent (a tool added to one list and not another reads as a deliberate denial).
//
// So this file states the model ONCE, in two tables that the compiler forces to
// stay total:
//
//   TOOL_DOMAIN     every tool -> the ONE thing it reaches (money, the diary,
//                   a patient's record, a send to a patient, ...).
//                   `Record<CopilotToolName, Domain>` — a new tool that is not
//                   placed here does not compile.
//   ACCESS_DOMAINS  every access level -> the domains it holds.
//                   `Record<CopilotAccess, ...>` — a new access level that is
//                   not placed here does not compile.
//
// and the tool catalog per role is DERIVED from them. Nothing about who may run
// what is written twice, which is the only way "the manager cannot reach money"
// stays true after the twenty-second tool is written by somebody thinking about
// the owner.
//
// The third totality check lives next door in scope.ts: `ACCESS_BY_ROLE` is
// `satisfies Record<Role, CopilotAccess>`, so a SIXTH ROLE does not compile
// either. Between the three, a new role, a new access level and a new tool are
// each a tsc error until a person places them on purpose.
//
// ---------------------------------------------------------------------------
// WHY DOMAINS AND NOT JUST LONGER NAME LISTS.
// ---------------------------------------------------------------------------
// Because the question the practice actually asks is about SUBJECTS, not tools:
// "can the receptionist see the takings", "can a dentist read a patient's
// notes", "can the manager text a patient". A domain map answers those directly
// and survives a tool being renamed, split in two, or replaced. A name list
// answers none of them and has to be re-audited every time the toolbox changes.
//
// It also makes the ABSENCES enumerable, which is the half that matters. The
// domains a role does NOT hold are listed on its row, so "the manager cannot
// reach money, reports, marketing performance, the system controls or any way of
// sending to a patient" is a property of the table rather than a claim in a
// comment, and clearance.test.ts proves it by enumeration.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS NOT.
// ---------------------------------------------------------------------------
// It is not the only lock, and it must never be treated as one. Three other
// layers sit around it and all of them still apply:
//
//   * THE CAPABILITY LAYER (src/lib/capabilities/*). A per-person grant or
//     revoke overlays the role: `system.copilot.ask` is checked by the route
//     before a turn starts, so an owner can take the co-pilot away from a named
//     login without editing anything here. This table decides what a session
//     that IS allowed to ask may reach; it never decides that a session may ask.
//   * THE MODULE LOCK (src/lib/nav.ts + requireModuleApiAccess). "co-pilot" is
//     not in CLINICIAN_SLUGS or STAFF_SLUGS today, so a clinician or staff
//     session is refused at the route whatever this table says. Their rows below
//     are therefore DECLARED AND PROVEN BUT NOT YET REACHABLE — see the note on
//     each row. Making them reachable is a deliberate widening of the nav and of
//     `COPILOT_ACCESS` in capabilities/defaults.ts, and is an owner decision,
//     not a side effect of this file.
//   * THE KILL SWITCH (src/lib/systems/*). Every tool that DOES something —
//     nudge_lead, launch_outreach_campaign, publish_meta_campaign — consults
//     `isSystemEnabled` inside tools.ts and refuses when its system is off. A
//     domain grant here is permission to try, never permission to bypass.
//
// PURE. No `server-only`, no DB, no env, no Anthropic import. Everything is a
// total function of its arguments, which is what lets clearance.test.ts
// enumerate every role against every tool rather than sample a few.
// ===========================================================================

/**
 * How much of the co-pilot a session may reach.
 *
 * - `full`      the owner surface, byte-for-byte what it was: every tool,
 *               tier-4 knowledge, unprojected results.
 * - `manager`   the practice manager: operational reads only.
 * - `clinician` a dentist or hygienist: their clinical reads plus second-opinion
 *               decision support. NOT REACHABLE YET (module lock, see above).
 * - `staff`     a nurse, receptionist or administrator: their OWN work and
 *               nothing else. NOT REACHABLE YET (module lock, see above).
 * - `none`      no co-pilot at all. The route answers 403 before a turn starts.
 */
export type CopilotAccess = "full" | "manager" | "clinician" | "staff" | "none";

/** Every access level, for enumeration in tests and in the admin table. */
export const COPILOT_ACCESS_LEVELS = ["full", "manager", "clinician", "staff", "none"] as const;

// ---------------------------------------------------------------------------
// THE TOOL NAMES.
//
// Declared HERE rather than read off COPILOT_TOOLS, because a type has to come
// from somewhere the type checker can see at compile time and `COPILOT_TOOLS` is
// an `Anthropic.Tool[]` whose `name` is a plain `string`. tools.ts then types its
// array as `(Anthropic.Tool & { name: CopilotToolName })[]`, so the arrow points
// BOTH ways: a tool added to tools.ts with a name that is not in this list fails
// tsc there, and a name added here with no tool behind it fails the wiring test
// in clearance.test.ts (which compares this list against the real array).
// ---------------------------------------------------------------------------
export const COPILOT_TOOL_NAMES = [
  // reads
  "patient_record",
  "search_patients",
  "appointments",
  "outstanding_balances",
  "practice_overview",
  "search_knowledge",
  "list_recent_assessment_leads",
  "list_speed_to_lead",
  "assessment_dropoff_summary",
  "second_opinion",
  "my_work",
  // reads added by WAVE 2, lane A — the co-pilot reaching the wave-1 modules.
  // Each one is filed in TOOL_DOMAIN below, and two of them brought a NEW domain
  // with them (equipment, it-desk) because neither fitted an existing subject.
  "agent_status",
  "sync_status",
  "previsit_summary",
  "interest_lists",
  "equipment_lookup",
  "it_desk",
  // acts
  "send_sms",
  "send_email",
  "create_outreach_campaign",
  "launch_outreach_campaign",
  "create_landing_page",
  "launch_landing_page",
  "create_meta_campaign",
  "publish_meta_campaign",
  "create_patient",
  "nudge_lead",
  // The act added by WAVE 2, lane A. Owner-only, two-step, and every confirmed
  // attempt goes through the W1-A write gate.
  "diary_write",
] as const;

export type CopilotToolName = (typeof COPILOT_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// THE DOMAINS.
//
// READ domains are subjects the co-pilot may look at. ACT domains are things it
// may DO, all of which reach a real person or a real record.
//
// Some domains have NO TOOL BEHIND THEM YET and that is deliberate: the model has
// to be able to say "a manager may not reach the system controls" before there is
// a controls tool, otherwise the day that tool is written the honest answer is
// decided by whoever writes it.
//
// THAT MECHANISM HAS NOW BEEN USED IN ANGER, which is the only evidence worth
// having that it works. W1-E declared five read domains and two act domains with
// nothing behind them and pinned all seven as owner-only. Wave 2 lane A wrote
// tools for three of them — agent-status, controls and diary-write — and every
// one of those tools landed owner-only WITHOUT a judgement call, because the
// judgement had already been made and written down. The remaining four (reports,
// hr, compliance, task-create) stay declared and toolless, and the test in
// clearance.test.ts names exactly those four.
// ---------------------------------------------------------------------------

export type ReadDomain =
  /** Patient records: profile, status, recall, consent, clinical notes, plans. */
  | "patients"
  /** The appointment book. */
  | "diary"
  /** Anything denominated in money: balances, takings, plan values, spend. */
  | "money"
  /** Business reports, ROI, NHS/UDA performance, allocation. EXTENSION POINT. */
  | "reports"
  /** Marketing and funnel PERFORMANCE: conversion, drop-off, campaign results. */
  | "marketing"
  /** The acquisition pipeline: assessment submissions and the leads worklist. */
  | "leads"
  /** The practice brain: scripts, policies, protocols, prices, at the role's tier. */
  | "knowledge"
  /** Whether the automated agents are switched on and what each needs first. */
  | "agent-status"
  /** People data: rota, hours, pay, HR documents, for OTHER people. EXTENSION POINT. */
  | "hr"
  /** CQC/GDC readiness, audits, training matrix, policies. EXTENSION POINT. */
  | "compliance"
  /** The system on/off switches, the Dentally write-back state and integration configuration. */
  | "controls"
  /**
   * The practice's equipment register and the manuals uploaded against it.
   *
   * A DOMAIN OF ITS OWN rather than a corner of "controls" or "compliance", and
   * the reason is the safety boundary: the equipment desk is the one subject in
   * this platform where reading a fact out is fine and answering the obvious
   * follow-up ("so can we keep using it?") is refused by rule (W1-D/2). A
   * subject with its own refusal contract needs its own domain, or the day
   * somebody widens `compliance` to a role they also widen that.
   */
  | "equipment"
  /**
   * The practice's IT troubleshooting playbooks and its named IT contact.
   *
   * Separate from `equipment` for the same reason they are two modules: the
   * deny class is different (credentials and security, not physical safety) and
   * a practice that switches one on has not switched the other on.
   */
  | "it-desk"
  /** The caller's OWN work: their rota, their holiday, their documents. */
  | "self"
  /** Clinical decision SUPPORT on a named patient. Never an instruction to treat. */
  | "clinical-support";

export type ActDomain =
  /** Anything that puts words in front of a patient: SMS, email, a lead nudge. */
  | "patient-send"
  /** Building and launching a segment outreach campaign. */
  | "campaign"
  /** Publishing public marketing: landing pages, Meta campaigns. */
  | "marketing-publish"
  /** Writing a new person into Dentally. */
  | "patient-create"
  /** Booking, moving or cancelling an appointment, through the W1-A write gate. */
  | "diary-write"
  /** Raising a task on the practice's worklist. EXTENSION POINT. */
  | "task-create";

export type Domain =
  | { kind: "read"; domain: ReadDomain }
  | { kind: "act"; domain: ActDomain };

const read = (domain: ReadDomain): Domain => ({ kind: "read", domain });
const act = (domain: ActDomain): Domain => ({ kind: "act", domain });

/** Every read domain, for enumeration. Order is the order they are reasoned about. */
export const READ_DOMAINS: readonly ReadDomain[] = [
  "patients",
  "diary",
  "money",
  "reports",
  "marketing",
  "leads",
  "knowledge",
  "agent-status",
  "hr",
  "compliance",
  "controls",
  "equipment",
  "it-desk",
  "self",
  "clinical-support",
] as const;

/** Every act domain, for enumeration. */
export const ACT_DOMAINS: readonly ActDomain[] = [
  "patient-send",
  "campaign",
  "marketing-publish",
  "patient-create",
  "diary-write",
  "task-create",
] as const;

/**
 * WHICH DOMAIN EACH TOOL REACHES. Exhaustive over `CopilotToolName`: a tool with
 * no entry does not compile, which is the point of the whole file.
 *
 * ONE domain per tool, never a list. A tool that genuinely spans two subjects is
 * a tool that should be split, because a role grant can only ever be as precise
 * as the tool it is granted on — and `practice_overview` is the worked example.
 */
export const TOOL_DOMAIN: Record<CopilotToolName, Domain> = {
  patient_record: read("patients"),
  search_patients: read("patients"),
  appointments: read("diary"),
  outstanding_balances: read("money"),
  // MONEY, and this is the classification a reasonable person gets wrong. It reads
  // as "just a summary" — patient counts, today's diary, agent activity — but it
  // also carries total outstanding, the reactivation recoverable value and the
  // treatment recovery value. A permitted tool that AGGREGATES money is exactly the
  // shape the hold axis exists to catch, so it is filed under money and the
  // operational half of it is simply not available to a role without money.
  practice_overview: read("money"),
  search_knowledge: read("knowledge"),
  list_recent_assessment_leads: read("leads"),
  list_speed_to_lead: read("leads"),
  // Funnel conversion analytics is marketing PERFORMANCE, which sits with ROI and
  // reports, not with the leads worklist.
  assessment_dropoff_summary: read("marketing"),
  second_opinion: read("clinical-support"),
  my_work: read("self"),

  // ---------------------------------------------------------------------
  // WAVE 2, LANE A. The wave-1 modules, filed.
  // ---------------------------------------------------------------------
  // Whether the automated agents are switched on and what each one needs
  // before it can work. The domain was declared owner-only by W1-E and the
  // programme's decisions log; landing the tool does not move it.
  agent_status: read("agent-status"),
  // The Dentally write-back state: what is mirrored, what waits on the key,
  // what Dentally has no way to accept, and the recent write intents. It is
  // the CONTROLS subject — it reports the state of the master switch and of
  // the deployment's arming — and not "reports", which is business
  // performance. A manager who cannot see System controls cannot see this.
  sync_status: read("controls"),
  // The patient's own pre-visit answers. PATIENTS, because that is what they
  // are: one patient's record. The symptom half is projected inside the tool
  // by the triage module's OWN list of who may read a patient's words
  // (CLINICAL_SUMMARY_ROLES, ruling W1-C/2), which is a narrower rule than
  // this domain and is applied on top of it, never instead of it.
  previsit_summary: read("patients"),
  // Who said yes to which treatment. The acquisition pipeline, and so the same
  // subject as the leads worklist — which is what files it under `leads`.
  //
  // WHAT IT IS NOT: a campaign source. No campaign tool in this catalog can see
  // `treatment_interest` — `create_outreach_campaign` selects on Dentally's own
  // patient base and has no interest predicate, and the Meta tools take free
  // prose. Ruling W3/10 made the lists targetable by a different route: an
  // owner/manager CSV export and "copy as audience", per treatment, on the
  // pre-visit screen itself (src/app/api/previsit/interest/export). This tool
  // reads them; nothing here sends to them, and its own prompt says so.
  interest_lists: read("leads"),
  equipment_lookup: read("equipment"),
  it_desk: read("it-desk"),

  send_sms: act("patient-send"),
  send_email: act("patient-send"),
  // A nudge writes no new words, but it PUTS A MESSAGE IN FRONT OF A PERSON. It is
  // a send, and filing it anywhere else would be a way of giving a send to a role
  // that must not have one.
  nudge_lead: act("patient-send"),
  create_outreach_campaign: act("campaign"),
  launch_outreach_campaign: act("campaign"),
  create_landing_page: act("marketing-publish"),
  launch_landing_page: act("marketing-publish"),
  create_meta_campaign: act("marketing-publish"),
  publish_meta_campaign: act("marketing-publish"),
  create_patient: act("patient-create"),
  // Booking, moving and cancelling an appointment, THROUGH the W1-A write gate.
  // The riskiest thing the co-pilot can do — it changes a real diary — so it is
  // the one act domain that landed in this wave and it landed owner-only, which
  // is where W1-E declared it.
  diary_write: act("diary-write"),
};

/** What one access level holds. */
export interface AccessClearance {
  /** Subjects this level may look at. */
  reads: readonly ReadDomain[];
  /** Things this level may do. */
  acts: readonly ActDomain[];
  /** The practice-brain clearance tier this level reads at. */
  maxTier: Tier;
  /** One line for the admin table and the report. */
  summary: string;
}

// ---------------------------------------------------------------------------
// THE TABLE ITSELF.
//
// Read the ABSENCES on each row as carefully as the grants: the domains missing
// from a row are the promise the platform makes about that login, and
// clearance.test.ts asserts every one of them by enumeration rather than by
// sampling.
// ---------------------------------------------------------------------------
export const ACCESS_DOMAINS: Record<CopilotAccess, AccessClearance> = {
  /**
   * THE OWNER AND THE AGENCY. Everything, unchanged, and deliberately written out
   * in full rather than as a "*": the day a domain is added, the owner's row is
   * the one place it must be considered on purpose like every other row.
   */
  full: {
    reads: [...READ_DOMAINS],
    acts: [...ACT_DOMAINS],
    maxTier: 4,
    summary: "Everything: the practice's data, its money, its marketing and every action the platform can take.",
  },

  /**
   * THE PRACTICE MANAGER (client_coordinator). The operational reads and NOTHING
   * ELSE — no money, no reports, no marketing performance, no controls, and no
   * way of sending anything to a patient.
   *
   * Every one of those absences is load-bearing and each has its own test:
   *   money              takings and balances are the owner's view.
   *   reports/marketing  business performance is the owner's view.
   *   controls           the on/off switches are the owner's view.
   *   patient-send       she sends from Conversations and nudges from the Leads
   *                      worklist, under those modules' own guards and kill
   *                      switches. A co-pilot send would route round both.
   *   self               deliberately absent, and the one that looks like an
   *                      oversight. She has the whole rota module; a `my_work`
   *                      tool would add nothing she cannot already see and would
   *                      widen the six-tool set that the non-widening snapshot
   *                      pins. Narrow beats tidy.
   *   agent-status       the automated systems and their switches are System
   *                      controls, which her nav does not give her. Declared
   *                      owner-only by W1-E and by the programme's decisions log,
   *                      and landing a tool in it does not move it.
   *
   * WAVE 2, LANE A ADDED TWO READ DOMAINS TO THIS ROW, and both by the same test
   * this row has always applied — does she already do this job, on this data, in a
   * screen she already has:
   *   equipment          the register is the practice manager's document in every
   *                      practice that has one. The nav entry for "equipment"
   *                      names owner + agency + coordinator for exactly that
   *                      reason (src/lib/nav.ts), and the charter's W1-D line is
   *                      "both: owner/manager access". A co-pilot that refused her
   *                      the register would be narrower than the page she is
   *                      looking at while she asks.
   *   it-desk            the same: front-desk IT lands on her, the nav entry names
   *                      her, and the charter says owner/manager. NOT widened to
   *                      the clinician or to staff, however universal an IT
   *                      question feels: the charter settles the module at
   *                      owner/manager, neither role's nav allow-list contains the
   *                      slug, and a co-pilot that answered for a login the module
   *                      itself refuses would be the widening, not the module.
   *
   * Both of those tools call the module's OWN gate before they answer, so the
   * owner's kill switch and the module's safety refusals apply to a question
   * asked here exactly as they apply to a question asked on the page.
   */
  manager: {
    reads: ["patients", "diary", "leads", "knowledge", "equipment", "it-desk"],
    acts: [],
    maxTier: 2,
    summary: "The running of the practice: the diary, patients, new enquiries, the equipment register, the IT playbooks and how the practice does things. No money, no reports, no marketing performance, no controls, no sending.",
  },

  /**
   * THE CLINICIAN (client_clinician). NOT REACHABLE YET — "co-pilot" is not in
   * CLINICIAN_SLUGS, so the route refuses this role before a turn starts. The row
   * is declared and proven so that switching it on is a nav edit and an owner
   * decision rather than a design exercise under time pressure.
   *
   * What it is FOR: the dentist chairside with a patient in front of them, asking
   * about that patient's record and, in second-opinion mode, for decision SUPPORT
   * on what the record shows. It adds no data a clinician does not already have on
   * the Patients and Calendar screens their nav already grants.
   *
   * ABSENT, and each for its own reason:
   *   money            a clinician does not need it and the record projection
   *                    already strips it.
   *   leads            the acquisition pipeline is the front desk's job, and it
   *                    is what carries the treatment-interest lists.
   *   marketing/reports/controls/hr/compliance   not their surface at all.
   *
   * EQUIPMENT AND IT-DESK ARE HELD, on the coordinator's ruling W2-A/1 of
   * 3 Sep 2026. Both were first placed at owner/manager to match the modules'
   * own nav entries, and the ruling widened them: neither desk holds patient
   * data, both gates refuse credentials and safety bypasses before a model is
   * called, and a dentist mid-list asking what the handpiece manual says is the
   * question these desks exist for. The MODULE PAGES widen with them (W2-B), so
   * the co-pilot is never wider than the module it answers for.
   *
   * STILL ABSENT, and each for its own reason:
   *   EVERY act        including patient-send. Whether a dentist may text their
   *                    own patient from here is an owner decision that the
   *                    programme charter does not settle, so the answer is no
   *                    until somebody says otherwise in writing. Widening an act
   *                    later is one line on this row; unsending a message is not.
   */
  clinician: {
    reads: ["patients", "diary", "knowledge", "equipment", "it-desk", "self", "clinical-support"],
    acts: [],
    maxTier: 1,
    summary: "Their patients, their diary, the practice's general knowledge, the equipment register, the IT playbooks, their own work, and second-opinion decision support on a named patient. No money, no leads, no marketing, no actions.",
  },

  /**
   * STAFF (client_staff) — a nurse, a receptionist, an administrator. THEIR OWN
   * WORK, plus the two desks that hold no patient data (ruling W2-A/1, below).
   *
   * THIS ROLE MUST NOT HAVE THE LIVE DIARY OR THE 51,000-PATIENT DATABASE, so it
   * does not get `patients` or `diary` here either. What the row began as is the same question
   * My work answers on screen — my shifts, my holiday, my documents — asked in
   * words instead of clicked, and answered through the SAME self-service seam
   * (`resolveSelfStaff`, which takes the session and no staff id at all).
   *
   * `knowledge` is absent too, and that is a real decision rather than an
   * omission: their practice-brain tier is 1 anyway, and a tool that returns
   * nothing useful is a tool that invites the model to fill the gap.
   */
  staff: {
    // EQUIPMENT AND IT-DESK ARE HELD, on the coordinator's ruling W2-A/1 of
    // 3 Sep 2026, and THIS row is the reason the ruling was asked for. A dental
    // nurse in this platform IS a `client_staff` login, and "the autoclave is
    // beeping" and "I am locked out of the computer" are her two most common
    // questions of the whole day. Three things make it safe rather than merely
    // kind:
    //   - NEITHER DESK HOLDS PATIENT DATA. The equipment tools read a register
    //     and a manual; the IT tools read shipped playbooks and one contact
    //     record. There is no patient, no diary and no figure in either.
    //   - THE REFUSALS ARE IDENTICAL FOR EVERY ROLE. Both gates run before a
    //     model is called and neither takes a role at all: a safety bypass, a
    //     credential, a request to weaken a protection and the "can we keep
    //     using it" judgement are refused for a nurse exactly as for the owner.
    //   - THE MODULE PAGES WIDEN IN STEP (W2-B), so the co-pilot never answers
    //     for a login the module itself would turn away. Editing the register
    //     stays owner/manager and setting the IT contact stays owner-only; this
    //     is a READ of what the practice has already written down.
    // `patients`, `diary` and `knowledge` stay absent, and none of that moved.
    reads: ["self", "equipment", "it-desk"],
    acts: [],
    maxTier: 1,
    summary: "Their own work — their rota, their holiday and their documents — plus the practice's equipment register and manuals and its IT troubleshooting playbooks. Nothing about patients, the diary, money or the practice's performance.",
  },

  /** No co-pilot at all. Holds nothing, and the route refuses before a turn starts. */
  none: {
    reads: [],
    acts: [],
    maxTier: 1,
    summary: "No co-pilot on this login.",
  },
};

// ---------------------------------------------------------------------------
// DERIVED: THE TOOL CATALOG.
// ---------------------------------------------------------------------------

/**
 * Build a `Record<CopilotAccess, T>` by asking for every level exactly once.
 *
 * `Object.fromEntries` would be shorter and it types its result as
 * `{[k: string]: T}` — which is to say it forgets the very thing this file is
 * for. This builder keeps the key type, so a level added to `CopilotAccess` and
 * not to `COPILOT_ACCESS_LEVELS` fails tsc rather than producing a map with a
 * missing row that reads, at every call site, as "denied".
 */
function byAccess<T>(make: (level: CopilotAccess) => T): Record<CopilotAccess, T> {
  const out = {} as Record<CopilotAccess, T>;
  for (const level of COPILOT_ACCESS_LEVELS) out[level] = make(level);
  return out;
}

/** The domains one access level holds, as sets, built once at module load. */
const HELD = byAccess((level) => ({
  reads: new Set(ACCESS_DOMAINS[level].reads) as ReadonlySet<ReadDomain>,
  acts: new Set(ACCESS_DOMAINS[level].acts) as ReadonlySet<ActDomain>,
}));

/** Does this access level hold the domain this tool reaches? */
export function accessHoldsToolDomain(access: CopilotAccess, name: CopilotToolName): boolean {
  const domain = TOOL_DOMAIN[name];
  return domain.kind === "read"
    ? HELD[access].reads.has(domain.domain)
    : HELD[access].acts.has(domain.domain);
}

/**
 * THE CATALOG: the exact tool names each access level may run, derived from the
 * two tables above and frozen at module load.
 *
 * A Map rather than a plain object for the same prototype-chain reason scope.ts
 * gives: `CATALOG["constructor"]` on an object literal answers with `Object`, and
 * a fail-closed default that can be skipped is not a default.
 */
export const TOOL_CATALOG: Record<CopilotAccess, readonly CopilotToolName[]> = byAccess((level) =>
  COPILOT_TOOL_NAMES.filter((name) => accessHoldsToolDomain(level, name)),
);

const CATALOG_SETS = new Map<string, ReadonlySet<string>>(
  COPILOT_ACCESS_LEVELS.map((level) => [level, new Set<string>(TOOL_CATALOG[level])]),
);

/**
 * May this access level run this tool NAME?
 *
 * `full` answers true for ANY name, including one nobody has written. That is
 * today's behaviour and it is kept on purpose: an unrecognised name falls through
 * to the dispatch's own `default:` and answers "unknown tool", so the owner's path
 * through this function is a no-op by construction rather than by inspection. The
 * owner holds every domain anyway, so the catalog and this shortcut agree on every
 * name that exists — pinned in clearance.test.ts so the shortcut can never become
 * a widening.
 *
 * Every other level is a strict ALLOW-list over the catalog, so a tool written
 * next year is denied on the day it is written and stays denied until somebody
 * edits TOOL_DOMAIN and a row of ACCESS_DOMAINS on purpose.
 */
export function catalogAllows(access: CopilotAccess, name: string): boolean {
  if (access === "full") return true;
  return CATALOG_SETS.get(access)?.has(name) ?? false;
}

/** The practice-brain clearance tier this access level reads at. */
export function accessMaxTier(access: CopilotAccess): Tier {
  return ACCESS_DOMAINS[access].maxTier;
}

// ---------------------------------------------------------------------------
// THE ROLE VIEW.
//
// The tables above are keyed by ACCESS because that is the currency the dispatch,
// the prompt builder and the projection already speak. The PRACTICE thinks in
// roles, so this is the same model presented the other way round: one row per
// login type, which is the table in the report and the thing clearance.test.ts
// enumerates.
// ---------------------------------------------------------------------------

export interface RoleClearance extends AccessClearance {
  role: Role;
  access: CopilotAccess;
  tools: readonly CopilotToolName[];
  /** Read domains this role does NOT hold. The promise, stated. */
  deniedReads: readonly ReadDomain[];
  /** Act domains this role does NOT hold. */
  deniedActs: readonly ActDomain[];
  /**
   * Can a session of this role reach the co-pilot AT ALL today? False means the
   * nav module lock (or the capability default) refuses it before a turn starts,
   * whatever this table grants. Declared, proven, not yet switched on.
   */
  reachableToday: boolean;
}

/**
 * Build the role view for one role. Takes the role -> access map as an argument
 * rather than importing it, so this module stays free of scope.ts and the two
 * cannot form a cycle; scope.ts is the one that composes them.
 */
export function clearanceForRole(role: Role, access: CopilotAccess, reachableToday: boolean): RoleClearance {
  const base = ACCESS_DOMAINS[access];
  const heldReads = new Set(base.reads);
  const heldActs = new Set(base.acts);
  return {
    ...base,
    role,
    access,
    tools: TOOL_CATALOG[access],
    deniedReads: READ_DOMAINS.filter((d) => !heldReads.has(d)),
    deniedActs: ACT_DOMAINS.filter((d) => !heldActs.has(d)),
    reachableToday,
  };
}
