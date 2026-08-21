import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CLIENT_NAV,
  CLINICIAN_SLUGS,
  STAFF_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  canRoleAccessModule,
} from "@/lib/nav";
import { PATIENT_ADMIN_ROLES, CLINICAL_WRITE_ROLES } from "@/lib/patient/roles";
import type { Role } from "@/lib/types";

// ===========================================================================
// THE API LAYER NEEDS ITS OWN MODULE LOCK, AND IT HAS TO BE PROVEN PER ROUTE.
//
// `client-module-guard-coverage.test.ts` (under src/app/c/[client]) proves the PAGE
// half: every module page calls `requireModuleAccess("<slug>")`. That test says
// nothing at all about the API, and the API had no counterpart. The three guards
// that do exist there are not substitutes:
//
//   requireUser         proves somebody is signed in. Every role passes.
//   requireClientAccess proves the caller belongs to this practice. Every role of
//                       that practice passes.
//   requireSiteAccess   proves the caller holds the named site — and a clinician's
//                       `siteIds` are every site of their own practice, so this is
//                       a TENANCY control, never a role one.
//
// So a `client_clinician` session, denied Conversations / Recall / Reactivation /
// the task queue / after-hours at the page layer, could call those modules' routes
// directly: read the whole patient inbox, or POST /api/inbox/reply and text any
// patient in the practice. `requireModuleApiAccess` closes that, and this file is
// what stops the next route shipping without it.
//
// DERIVED FROM THE FILESYSTEM, not from a list anybody maintains: every route.ts
// under src/app/api is swept, and each one must either carry a guard or appear in
// EXEMPT below WITH A REASON. A new unguarded route fails immediately, and it
// cannot be quietly excluded either — each exemption category is corroborated by a
// structural check, so an entry whose stated reason stops being true also fails.
// ===========================================================================

const API_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every route.ts under src/app/api, as a POSIX-ish path relative to that dir. */
function findRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRoutes(full));
    else if (entry.name === "route.ts") out.push(relative(API_DIR, join(full, "..")).split(sep).join("/"));
  }
  return out.sort();
}

const ROUTES = findRoutes(API_DIR);

function routeSource(route: string): string {
  return readFileSync(join(API_DIR, route, "route.ts"), "utf8");
}

// ---------------------------------------------------------------------------
// THE EXEMPTIONS. Every entry is a decision on the record, not a silent gap.
//
//   kind "public"       no session exists here at all — a patient or a visitor is
//                       the caller, so there is no role to check.
//   kind "webhook"      called by Twilio, authenticated by the provider signature.
//   kind "cron"         called by the scheduler, gated on CRON_SECRET.
//   kind "mock"         stands in for the upstream Dentally API in local dev; it is
//                       an external-API impersonation, never one of our modules.
//   kind "clinician"    the module IS one the clinician legitimately uses, so a
//                       BLANKET module guard would lock out its intended user.
//                       `slug` names it and `roles` names EXACTLY which roles may
//                       reach the route; both are corroborated below, so this
//                       category cannot be used to smuggle a module in.
//   kind "shell"        cross-cutting authed plumbing mounted in the app shell for
//                       every signed-in role; not a module and holds no module data.
//   kind "dev"          dev-only harness that hard-404s in production.
//   kind "self-service" the caller is asking about THEMSELVES. A module gate here
//                       would be either a lock on the wrong door (naming a slug the
//                       staff role does not hold refuses the feature's own users) or
//                       no lock at all (naming "my-work", which both new roles DO
//                       hold — "a guard naming a slug the caller may have compiles,
//                       reads as a lock, and does nothing"). The lock is instead
//                       that the route resolves the staff record from the SESSION
//                       and reads no staff id from the body or the query, which is
//                       corroborated structurally below. `selfBranch` says HOW the
//                       branch is entered, and each form has its own proof.
//
// ===========================================================================
// THE `clinician` CATEGORY WAS THE HOLE THE FIFTH ROLE WOULD HAVE FALLEN THROUGH.
//
// Until campaign 6 this category asserted ONE thing: that the named slug is in
// CLINICIAN_SLUGS. That says the clinician is allowed — and says nothing whatsoever
// about any other role. Thirteen routes rested on it, and between them they are the
// entire live diary and the entire 51,000-patient database. `requireDiaryRead`
// explicitly admits any signed-in user holding the site, and `requireClientAccess` /
// `requireSiteAccess` admit every role attached to the practice, so the moment a
// fifth role existed a receptionist login would have had all thirteen — and this
// file would have stayed green while it happened.
//
// So each entry now names `roles`: exactly the roles that may reach it. The
// structural check below no longer takes that on trust — it computes, from the
// guards actually present in the route's source, which roles are PROVABLY refused,
// and fails unless that covers every role the entry does not name. An entry cannot
// claim a lock the code does not implement, and code cannot quietly widen past what
// the entry claims.
// ---------------------------------------------------------------------------

/** Every role the platform has. Adding a sixth fails tsc here first. */
const ALL_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
];

/**
 * The four roles that may reach the patient record and the diary AT ALL.
 *
 * Not hand-maintained as a permission: it is what `canRoleAccessModule` already
 * answers for "calendar" and "patients", and the `moduleGate` proof below derives
 * the denial set from that predicate rather than from this constant. It is spelled
 * out here only so the `roles` entries read as English.
 */
const RECORD_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
];

/**
 * Role guards whose admitted set is a PURE, TESTED constant, keyed by the exact
 * token that must appear in a route's source for the guard to count as present.
 *
 * The value is imported, never retyped: if `PATIENT_ADMIN_ROLES` or
 * `CLINICAL_WRITE_ROLES` changes, every exemption resting on it is re-judged here
 * instead of silently meaning something new.
 */
const GUARD_ADMITS: Record<string, readonly string[]> = {
  "requireDiaryAdmin(": PATIENT_ADMIN_ROLES,
  "requirePatientAdmin(": PATIENT_ADMIN_ROLES,
  "requireClinicalWriteRole(": CLINICAL_WRITE_ROLES,
};

interface Exemption {
  kind: "public" | "webhook" | "cron" | "mock" | "clinician" | "shell" | "dev" | "self-service";
  reason: string;
  /** kind "clinician" only: the CLIENT_NAV slug this route serves. */
  slug?: string;
  /**
   * kind "clinician" only: EXACTLY the roles that may reach ANY method of this
   * route. Every role NOT named here must be provably refused by a guard present
   * in the route's own source — see the structural check below.
   */
  roles?: Role[];
  /**
   * kind "clinician" only: a role guard, named by its source token, that narrows
   * the route below what the module gate alone would admit. Its admitted set comes
   * from GUARD_ADMITS.
   */
  narrowedBy?: keyof typeof GUARD_ADMITS;
  /** kind "clinician" only: a still narrower set for the route's WRITE methods. */
  writeRoles?: readonly string[];
  /** The source token that enforces `writeRoles`. */
  writeGuard?: keyof typeof GUARD_ADMITS;
  /**
   * kind "self-service" only: HOW the self branch is entered. Each value has its
   * own structural proof below, because they are three genuinely different shapes
   * and a single assertion covering all of them would have to be weak enough to
   * pass for the weakest.
   *
   *   "whole-route"  every method serves only the caller's own record, so there is
   *                  no manager path and no module gate anywhere in the file.
   *   "mine"         `?mine=1` selects the self branch, taken BEFORE the manager
   *                  gates, which stay in place for everybody else. Entered only
   *                  through the shared, tested pair `selfServiceRequested` +
   *                  `resolveSelfStaff`, and the latter takes no staff id at all.
   *   "role-fork"    the route forks on `requireApproverRole(auth) === null`, so
   *                  "not an approver" IS the self branch. Older shape, kept
   *                  because it is correct and pinned by its own route tests.
   */
  selfBranch?: "whole-route" | "mine" | "role-fork";
  /**
   * kind "self-service" + selfBranch "mine": the guard tokens the MANAGER branch
   * still carries. Asserted present, so a route cannot use the self-service
   * category to quietly drop the lock on its OTHER caller.
   */
  managerGuards?: string[];
  /**
   * kind "self-service" + selfBranch "role-fork": WHERE the request's staff id is
   * allowed to be read, because the two role-fork routes answer that differently
   * and one assertion covering both would have to be weak enough to pass for the
   * weaker. Neither shape is a compromise — they are the two honest answers to
   * "somebody named a person" — but they are not the same shape, and a proof that
   * pretended they were would be a proof of nothing.
   *
   *   "manager-branch-only"  the id is read INSIDE the `canManage ?` ternary, so a
   *                          non-approver's staffId is never even parsed. It is
   *                          IGNORED (`absence`).
   *   "escalates"            the id is read unconditionally and DEFAULTS to the
   *                          session's own staff row; the moment it names anybody
   *                          else the request must clear an approver guard AND a
   *                          second capability. It is REFUSED, not ignored, which
   *                          is why the route can also serve the manager's screen
   *                          from the same method (`staff-check-in`).
   */
  staffIdRead?: "manager-branch-only" | "escalates";
}

const EXEMPT: Record<string, Exemption> = {
  // --- public / patient-facing: nobody is signed in ------------------------
  "booking/slots": { kind: "public", reason: "public online-booking: a patient reads open diary slots" },
  "booking/hold": { kind: "public", reason: "public online-booking: a patient holds a slot" },
  "booking/create": { kind: "public", reason: "public online-booking: a patient books the held slot" },
  "funnel-event": { kind: "public", reason: "public landing-page funnel beacon, budget-guarded" },
  "landing-lead": { kind: "public", reason: "public landing-page lead capture, budget-guarded" },
  "onboarding/submit": { kind: "public", reason: "public new-patient onboarding form submit" },
  "onboarding/upload": { kind: "public", reason: "public onboarding document upload" },
  "medical-history/public-submit": { kind: "public", reason: "public patient-facing medical-history questionnaire submit (token-verified)" },
  "fp17/submit": { kind: "public", reason: "public FP17/PR consent + exemption declaration submit, token-bound + budget-guarded" },
  "smile-assessment/token": { kind: "public", reason: "public quiz: mints the session token" },
  "smile-assessment/next": { kind: "public", reason: "public quiz: serves the next question" },
  "smile-assessment/submit": { kind: "public", reason: "public quiz submit, signed submit token" },
  "smile-assessment/step-event": {
    kind: "public",
    reason:
      "public quiz: anonymous, PII-free step-view beacon. No session exists (a visitor is the caller); the guards are a payload cap, three api_budget ceilings (per IP, per campaign per minute, per campaign per day) and a strict kill-switch check, and it answers the same opaque 202 for every outcome. Its READ side is a different route entirely (campaign/[slug]/drop-off), which IS module-guarded",
  },
  "speed-to-lead/intake": { kind: "public", reason: "public lead intake from website / missed call" },
  "prefs": { kind: "public", reason: "patient channel choice + opt-out behind a signed /prefs token" },

  // --- provider webhooks: authenticated by Twilio, not by a session --------
  "webhooks/twilio/inbound": { kind: "webhook", reason: "Twilio inbound SMS/WhatsApp webhook" },
  "webhooks/twilio/status": { kind: "webhook", reason: "Twilio delivery-status webhook" },
  "webhooks/twilio/voice": { kind: "webhook", reason: "Twilio voice webhook" },

  // --- scheduler: CRON_SECRET, never a browser session --------------------
  "anomaly/sweep": { kind: "cron", reason: "proactive anomaly pass (reads only; writes anomaly_alert, never a patient record or an outbox)" },
  "closer/sweep": { kind: "cron", reason: "treatment-plan closer sweep (drafts only, never queues)" },
  "coordinator/sweep": { kind: "cron", reason: "treatment-coordinator sweep" },
  "noshow/sweep": { kind: "cron", reason: "no-show defence sweep" },
  "outreach/sweep": { kind: "cron", reason: "segment outreach sweep" },
  "postop/sweep": { kind: "cron", reason: "post-op check-in sweep (flags + drafts only, never queues)" },
  "collection/sweep": { kind: "cron", reason: "outstanding-balance sweep (verifies + drafts only, never queues)" },
  "reactivation/sweep": { kind: "cron", reason: "reactivation sweep" },
  "recall/sweep": { kind: "cron", reason: "recall sweep" },
  "reviews/sweep": { kind: "cron", reason: "review-request sweep" },
  "rota/sweep": { kind: "cron", reason: "rota generation + staff SMS sweep" },
  "speed-to-lead/sweep": { kind: "cron", reason: "speed-to-lead follow-up sweep" },
  "landing-pages/promote-sweep": { kind: "cron", reason: "A/B winner promotion sweep" },
  "messaging/drain": { kind: "cron", reason: "the shared outbox drain" },
  "meta-ads/insights": { kind: "cron", reason: "hourly Meta insights pull" },
  "dentally/prewarm": { kind: "cron", reason: "Dentally display-cache pre-warm" },
  "sync/coordinator": { kind: "cron", reason: "Dentally -> treatment-coordinator sync" },
  "sync/dentally": { kind: "cron", reason: "Dentally patient sync" },
  "sync/noshow": { kind: "cron", reason: "Dentally -> no-show defence sync" },
  "sync/patient-count": { kind: "cron", reason: "Dentally patient-count sync" },
  "sync/reactivation": { kind: "cron", reason: "Dentally -> reactivation sync" },
  "sync/recall": { kind: "cron", reason: "Dentally -> recall sync" },

  // --- the mock Dentally API: an external PMS stand-in, not one of ours ----
  "mock-dentally/v1/appointments": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/appointments/[id]": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/appointments/availability": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/invoices": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/invoices/[id]": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/nhs_claims": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/notes": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/patients": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/patients/[id]": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/payment_plans": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/payments": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/practitioners": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/treatment_appointments": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/treatment_categories": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/treatment_plan_items": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/treatment_plans": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/treatments": { kind: "mock", reason: "mock upstream Dentally API" },

  // --- the clinician's own working surfaces --------------------------------
  // A BLANKET module guard would lock out the very role the allow-list exists to
  // serve, so these carry a module gate that names a slug the clinician HOLDS
  // ("calendar" / "patients") — which still refuses `client_staff`, because neither
  // slug is in STAFF_SLUGS — plus, where the act is narrower than the module, a
  // role guard on top. `roles` names the result; the structural check proves it.
  "calendar/day": {
    kind: "clinician",
    slug: "calendar",
    roles: RECORD_ROLES,
    reason: "their own diary, read. requireDiaryRead proves site + session only, so the module gate is what keeps a receptionist out of the live diary",
  },
  "calendar/appointment/[id]": {
    kind: "clinician",
    slug: "calendar",
    roles: [...PATIENT_ADMIN_ROLES] as Role[],
    narrowedBy: "requireDiaryAdmin(",
    reason: "diary appointment read/move. requireDiaryAdmin (PATIENT_ADMIN_ROLES) gates GET here and PATCH inside performMove, so the clinician and the staff role are both refused",
  },
  "calendar/propose": {
    kind: "clinician",
    slug: "calendar",
    roles: [...PATIENT_ADMIN_ROLES] as Role[],
    narrowedBy: "requireDiaryAdmin(",
    reason: "diary slot proposal, a write path (requireDiaryAdmin)",
  },
  "diary/entry": {
    kind: "clinician",
    slug: "calendar",
    roles: [...PATIENT_ADMIN_ROLES] as Role[],
    narrowedBy: "requireDiaryAdmin(",
    reason: "diary breaks + notes; every method is a write (requireDiaryAdmin)",
  },
  "dentally/patients": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    reason: "the patient list they treat from; the module gate is what stops a staff login searching the whole base",
  },
  "dentally/patients/[id]": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    reason: "a single patient record; requireSiteAccess is tenancy, the module gate is the role check",
  },
  "patient-notes": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    reason: "practice notes on the patient record. DELIBERATELY open to all four record roles — a receptionist writing 'patient rang about their bill' is what this is for — and closed to client_staff, whose surface is my-work",
  },
  "patient-notes/transcribe": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    reason: "voice dictation for those notes; same gate as its parent. Shipped with requireUser alone (any signed-in role, and a paid third-party call), closed as part of adding the fifth role",
  },
  "charting/draft": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    writeRoles: CLINICAL_WRITE_ROLES,
    writeGuard: "requireClinicalWriteRole(",
    reason: "the FDI chart, a tab of the patient record. Read is the record roles; WRITE is clinician + owner + agency (the coordinator lost it)",
  },
  "perio/[action]": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    writeRoles: CLINICAL_WRITE_ROLES,
    writeGuard: "requireClinicalWriteRole(",
    reason: "the perio chart, a tab of the patient record. Read is the record roles; WRITE (BPE, chart, retract) is clinician + owner + agency",
  },
  "medical-history/[action]": {
    kind: "clinician",
    slug: "patients",
    roles: RECORD_ROLES,
    writeRoles: CLINICAL_WRITE_ROLES,
    writeGuard: "requireClinicalWriteRole(",
    reason: "the medical-history tab of the patient record. Read is the record roles; WRITE (questionnaire, review, retract) is clinician + owner + agency",
  },
  "patients/[id]/profile": {
    kind: "clinician",
    slug: "patients",
    roles: [...PATIENT_ADMIN_ROLES] as Role[],
    narrowedBy: "requirePatientAdmin(",
    reason: "patient record; role-gated by requirePatientAdmin, which already refuses both the clinician and the staff role",
  },
  "patients/[id]/status": {
    kind: "clinician",
    slug: "patients",
    roles: [...PATIENT_ADMIN_ROLES] as Role[],
    narrowedBy: "requirePatientAdmin(",
    reason: "patient record; role-gated by requirePatientAdmin",
  },

  // --- self-service: the caller is asking about themselves ----------------
  "hr/policy/[id]/sign": {
    kind: "self-service",
    selfBranch: "whole-route",
    reason: "a member of staff affirms a policy for themselves from My work; the signer is resolved from the session by findStaffByAppUser and no staff id is read from the request, so there is nobody else's record to reach",
  },
  "absence": {
    kind: "self-service",
    selfBranch: "role-fork",
    staffIdRead: "manager-branch-only",
    reason: "holiday: an approver records anybody's, everybody else records their OWN. The route forks on requireApproverRole(auth) === null, and on the self branch the staff id comes from findStaffByAppUser and the body's staffId is not read — which is why the fork reads as a lock to a human and as nothing at all to a text sweep, and why it belongs here rather than being counted as role-guarded",
  },
  "staff-check-in": {
    kind: "self-service",
    selfBranch: "role-fork",
    staffIdRead: "escalates",
    reason:
      "My work's 'My clock', and the fifth tab. GET narrows a non-approver to the ONE staff row resolved from the session (findStaffByAppUser) and asks listEventsForDay about that id alone; POST defaults its target to the same row, and naming SOMEBODY ELSE escalates to requireApproverRole plus people.clock.record-for-other, so a nurse can clock herself in and nobody else. It pre-dates the shared self-service seam and resolves the caller directly rather than through resolveSelfStaff, so its structural proof is the escalation, not the mine=1 pair",
  },
  "rota/shifts": {
    kind: "self-service",
    selfBranch: "mine",
    managerGuards: ["requireApproverRole(", 'requireCapability(auth, "rota.view")'],
    reason: "My work's 'My rota': `mine=1` returns the caller's own PUBLISHED shifts, narrowed at the query on the session's staff id. The manager read keeps the approver guard and rota.view, both of which refuse client_staff — the role the tab exists for",
  },
  "hr/document": {
    kind: "self-service",
    selfBranch: "mine",
    managerGuards: ['requireModuleApiAccess(auth, "staff-hr")', "requireApproverRole("],
    reason: "My work's 'My documents': `mine=1` returns the caller's own vault. The manager read of a NAMED person's file keeps the staff-hr gate, the approver role and hr.view-documents",
  },
  "hr/document/url": {
    kind: "self-service",
    selfBranch: "mine",
    managerGuards: ['requireModuleApiAccess(auth, "staff-hr")', "requireApproverRole("],
    reason: "the signed URL for one of the caller's OWN documents; on the mine=1 branch the path must satisfy isWithinOwnDocPrefix, which is one segment stricter than the practice prefix, so a colleague's document is refused",
  },
  "hr/policy": {
    kind: "self-service",
    selfBranch: "mine",
    managerGuards: ['requireModuleApiAccess(auth, "staff-hr")', "requireApproverRole("],
    reason: "My work's 'My signatures': `mine=1` returns the practice's policies plus ONLY the caller's own signature summaries (listSignaturesForStaff on the session's staff id). Without it the sign route was reachable and unlistable",
  },

  // --- cross-cutting shell plumbing, open to every signed-in role ----------
  "telemetry": { kind: "shell", reason: "usage beacon the authed shell posts on every route change; holds no module data" },
  "feedback": { kind: "shell", reason: "the shell's 'Request a change' widget; its list/status methods are agency_admin-only inline" },

  // --- dev only ------------------------------------------------------------
  "agent-test": { kind: "dev", reason: "browser harness for the booking agent; hard 404 in production" },
};

/**
 * A route is guarded if it locks the module, or is restricted to roles the
 * clinician is not in.
 *
 * The first argument is `[\w.]+`, not `\w+`: a route whose session comes from a
 * chain helper passes it as `access.auth`, and matching only bare identifiers made
 * such a guard invisible to this sweep — i.e. present in the code and absent from
 * the proof, which is the worst of both.
 */
const MODULE_CALL = /requireModuleApiAccess\(\s*[\w.]+\s*,\s*"([^"]*)"\s*\)/g;

function moduleSlugsIn(src: string): string[] {
  return [...src.matchAll(MODULE_CALL)].map((m) => m[1]);
}
/**
 * A role guard whose result is used as a REFUSAL, not as a boolean.
 *
 * THE WEAKNESS THIS CLOSES. The old check was `src.includes("requireApproverRole(")`,
 * which counts a route as locked for merely MENTIONING the guard. `/api/absence`
 * writes `const canManage = requireApproverRole(auth) === null` — a branch
 * condition, correct by design, that locks precisely nothing — and the sweep
 * recorded it as locked. Nothing was open because of it, but the precedent was:
 * any new route could satisfy this file's headline assertion with a boolean it
 * never acted on, which is the compiling, plausible, empty lock this whole file
 * exists to refuse.
 *
 * So a guard counts only when the call is NOT immediately compared to null. Two
 * routes (`absence/[id]`, `staff-check-in`) use BOTH shapes — a fork for the read
 * and a real returning guard for the write — and are still counted, correctly, on
 * the strength of the returning one.
 */
const ROLE_GUARD_CALL = /require(?:Owner|Approver)Role\(\s*[\w.]+\s*\)(?!\s*[=!]==?\s*null)/;
function hasRoleGuard(src: string): boolean {
  // The clinician is in neither role list, so either already excludes it.
  return ROLE_GUARD_CALL.test(src);
}

/**
 * One exported handler's body, from its declaration to the next top-level export.
 *
 * Needed because "what runs first" is a property of the HANDLER, not of the file:
 * two of the self-service routes keep their manager gates in a helper declared
 * ABOVE the handler, so a whole-file index comparison would say the manager gate
 * comes first when in fact the handler never reaches it.
 */
function methodBody(src: string, method: "GET" | "POST" | "PATCH" | "DELETE"): string {
  const start = src.indexOf(`export async function ${method}(`);
  if (start === -1) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const NAV_SLUGS = new Set(CLIENT_NAV.flatMap((g) => g.items).map((i) => i.slug));

describe("every signed-in-reachable API route locks its module against the clinician", () => {
  it("sweeps a plausible number of routes (a broken glob must not pass vacuously)", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(120);
    expect(ROUTES).toContain("inbox/reply");
    expect(ROUTES).toContain("recall/[action]");
  });

  it.each(ROUTES)("/api/%s is either guarded or a documented exemption", (route) => {
    if (route in EXEMPT) return; // its own category assertions run below
    const src = routeSource(route);
    const slugs = moduleSlugsIn(src);
    // The message matters: when this fails it is usually a brand-new route, and the
    // author needs to know both options rather than reverse-engineer them.
    expect(
      slugs.length > 0 || hasRoleGuard(src),
      `/api/${route} has no module lock. Add requireModuleApiAccess(auth, "<slug>") after ` +
        `requireClientAccess/requireSiteAccess, or requireOwnerRole/requireApproverRole if the ` +
        `module is owner/approver-only — or add it to EXEMPT with a reason.`,
    ).toBe(true);
  });

  it("no exemption is stale: every exempted path still exists on disk", () => {
    expect(Object.keys(EXEMPT).filter((r) => !ROUTES.includes(r))).toEqual([]);
  });

  it("guards a substantial share of the surface (the exemption list cannot swallow it)", () => {
    const guarded = ROUTES.filter((r) => !(r in EXEMPT) && moduleSlugsIn(routeSource(r)).length > 0);
    expect(guarded.length).toBeGreaterThanOrEqual(25);
  });
});

/**
 * Routes whose module guard names a slug the CLINICIAN HOLDS.
 *
 * A named, closed list, because it is an exception to the rule below and has to
 * read as one. Before the fifth role, "guards a slug the clinician may have" was
 * indistinguishable from "does nothing", so the rule was simply that every guarded
 * slug is clinician-denied. With `client_staff` that is no longer true: a gate on
 * "calendar" or "patients" refuses the staff role and nobody else, which is exactly
 * the lock these thirteen routes needed and could not previously express.
 *
 * Every entry here is a `kind:"clinician"` exemption whose `roles` field states who
 * is left, and the structural check further down proves it. Anything NOT in this
 * list still has to name a slug the clinician is denied.
 */
const RECORD_TIER_GUARDS = new Set<string>([
  "calendar/day",
  "dentally/patients",
  "dentally/patients/[id]",
  "patient-notes",
  "patient-notes/transcribe",
  "charting/draft",
  "perio/[action]",
  "medical-history/[action]",
]);

/**
 * Helpers that resolve a session and hand it on, so a `requireModuleApiAccess`
 * whose first argument came from one of these is NOT inert. Each is corroborated
 * below by reading the helper itself.
 */
const SESSION_RESOLVERS: Record<string, string> = {
  requireUser: "lib/auth/guard.ts",
  requireDiaryRead: "lib/calendar/access.ts",
  requireDiaryAdmin: "lib/calendar/access.ts",
  requirePatientAdmin: "lib/patient/access.ts",
};

/** Read a repo file by its path relative to src/ (API_DIR is src/app/api). */
function srcFile(relPath: string): string {
  return readFileSync(join(API_DIR, "..", "..", relPath), "utf8");
}

describe("a module guard that names the wrong slug is worse than none", () => {
  const guardedSlugs = [
    ...new Set(ROUTES.flatMap((r) => moduleSlugsIn(routeSource(r)).map((s) => `${r}::${s}`))),
  ];

  it.each(guardedSlugs)("%s names a real module that some role is denied", (pair) => {
    const [route, slug] = pair.split("::");
    // A real slug, so a typo ("conversation") cannot pass as a lock — an unknown slug
    // is allow-by-default for the three open roles and would read as protected.
    expect(NAV_SLUGS.has(slug) || EXTRA_OWNER_ONLY_SLUGS.has(slug)).toBe(true);
    // NOT INERT. A guard naming a slug EVERY role may have compiles, reads as a lock
    // and does nothing, which is the failure mode this assertion exists for.
    const denied = ALL_ROLES.filter((role) => !canRoleAccessModule(role, slug));
    expect(denied.length, `${route} guards "${slug}", which no role is denied`).toBeGreaterThan(0);
    // The original, stronger claim still holds everywhere except the named
    // record-tier list: the guard denies the clinician.
    if (!RECORD_TIER_GUARDS.has(route)) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    } else {
      // ...and where it does not, it is because the guard exists to deny the FIFTH
      // role instead. Asserted, not assumed.
      expect(canRoleAccessModule("client_staff", slug)).toBe(false);
    }
  });

  it("every record-tier guard is a documented clinician-kind exemption (no stale entries)", () => {
    for (const route of RECORD_TIER_GUARDS) {
      expect(ROUTES).toContain(route);
      expect(EXEMPT[route]?.kind).toBe("clinician");
      // It really does carry a module gate, or its presence in this list is a lie.
      expect(moduleSlugsIn(routeSource(route)).length).toBeGreaterThan(0);
    }
  });

  it("every module-guarded route also resolves a session for it to inspect", () => {
    // requireModuleApiAccess(null, ...) is a deliberate no-op, so a call whose first
    // argument never came from a resolved session would be permanently inert.
    const resolvers = Object.keys(SESSION_RESOLVERS);
    const missing = ROUTES.filter((r) => {
      const src = routeSource(r);
      return moduleSlugsIn(src).length > 0 && !resolvers.some((fn) => src.includes(`${fn}(`));
    });
    expect(missing).toEqual([]);
  });

  it("each accepted session resolver really does resolve a session", () => {
    // The list above is only as good as this: a helper that stopped calling
    // requireUser would keep satisfying the sweep while proving nothing.
    for (const [fn, file] of Object.entries(SESSION_RESOLVERS)) {
      const src = srcFile(file);
      expect(src, `${file} should export ${fn}`).toContain(`export async function ${fn}`);
      if (fn !== "requireUser") {
        expect(src, `${file} must call requireUser to resolve a session`).toContain("await requireUser()");
      }
    }
  });

  it("pins the exact slug on the routes that were the actual exposure", () => {
    // Spot-checks, not a maintained map: these are the concrete reachable paths a
    // clinician session had into modules it must never see.
    const pinned: Record<string, string> = {
      "inbox/reply": "conversations", // could have texted any patient in the practice
      "inbox/threads": "conversations", // could have read every patient conversation
      "task-queue/list": "task-queue",
      "task-queue/action": "task-queue",
      "recall/[action]": "recall",
      "reactivation/[action]": "reactivation",
      "noshow/[action]": "no-show-defence",
      "after-hours/[action]": "after-hours",
    };
    for (const [route, slug] of Object.entries(pinned)) {
      expect(routeSource(route)).toContain(`requireModuleApiAccess(auth, "${slug}")`);
    }
  });
});

describe("each exemption category still means what it says", () => {
  const of = (kind: Exemption["kind"]) => Object.entries(EXEMPT).filter(([, e]) => e.kind === kind);

  it.each(of("public").map(([r]) => r))("%s really is unauthenticated", (route) => {
    // The reason for exempting these is that no session exists. Add one and the
    // reasoning is void: the route now has a role to check and must be re-judged.
    expect(routeSource(route)).not.toContain("requireUser");
  });

  it.each(of("cron").map(([r]) => r))("%s really is CRON_SECRET-gated", (route) => {
    const src = routeSource(route);
    expect(src.includes("CRON_SECRET") || src.includes('from "@/lib/cron"')).toBe(true);
    expect(src).not.toContain("requireUser");
  });

  it.each(of("mock").map(([r]) => r))("%s really is under the mock Dentally tree", (route) => {
    expect(route.startsWith("mock-dentally/")).toBe(true);
  });

  it.each(of("clinician").map(([r]) => r))("%s serves a module the clinician is allowed", (route) => {
    const slug = EXEMPT[route].slug;
    expect(slug, `clinician-kind exemptions must name their slug`).toBeTypeOf("string");
    // DERIVED, not asserted: if CLINICIAN_SLUGS ever loses "calendar" or "patients",
    // every route resting on that permission fails here rather than staying open.
    expect(CLINICIAN_SLUGS.has(slug!)).toBe(true);
    expect(canRoleAccessModule("client_clinician", slug!)).toBe(true);
  });

  it("the dev-only harness still hard-404s in production", () => {
    const src = routeSource("agent-test");
    expect(src).toContain('process.env.NODE_ENV === "production"');
    expect(src).toContain("404");
  });

  it.each(of("self-service").map(([r]) => r))(
    "%s really resolves the caller from the session and nobody else",
    (route) => {
      const src = routeSource(route);
      const e = EXEMPT[route];
      // (a) there IS a session — this category is not a way to ship an open route.
      expect(src, `${route} must resolve a session`).toContain("await requireUser()");
      expect(src, `${route} must prove tenancy`).toContain("requireClientAccess(");
      // (b) the surface it serves really is the self-service one, derived rather than
      //     asserted: if `my-work` ever left STAFF_SLUGS this category loses its
      //     meaning and should fail here rather than quietly persist.
      expect(STAFF_SLUGS.has("my-work")).toBe(true);
      // (c) every entry declares HOW its self branch is entered, because the proof
      //     below is different for each shape and a missing value would skip it.
      expect(e.selfBranch, `${route} must declare selfBranch`).toBeTypeOf("string");

      if (e.selfBranch === "mine") {
        // THE SHARED SEAM, and the reason a hybrid route can be trusted at all: the
        // branch is entered through one tested predicate and the caller is resolved
        // by one tested function that TAKES NO STAFF ID (proved just below).
        expect(src, `${route} must gate its self branch on selfServiceRequested`).toContain(
          "selfServiceRequested(url)",
        );
        expect(src, `${route} must resolve the caller with resolveSelfStaff`).toContain(
          "resolveSelfStaff(",
        );
        // ORDER, INSIDE THE GET ITSELF: the self branch is taken BEFORE anything
        // that authorises a manager. After them it would be dead code — every one
        // of those guards refuses `client_staff`, the branch's whole audience.
        //
        // Scoped to the method body rather than the file, because two of these
        // routes keep their manager gates in a helper declared ABOVE the handler:
        // whole-file text order says nothing about what runs first.
        const get = methodBody(src, "GET");
        expect(get, `${route} must take its self branch inside GET`).toContain(
          "selfServiceRequested(url)",
        );
        const selfAt = get.indexOf("selfServiceRequested(url)");
        for (const token of ["authorise(", "requireApproverRole(", "requireModuleApiAccess(", "requireCapability("]) {
          const at = get.indexOf(token);
          if (at === -1) continue;
          expect(
            selfAt,
            `${route}'s GET runs ${token} before its self branch, which refuses that branch's own audience`,
          ).toBeLessThan(at);
        }
        // ...and the MANAGER path keeps every lock it had. This category is not a
        // way to take a gate off the other caller.
        for (const guard of e.managerGuards ?? []) {
          expect(src, `${route} claims the manager branch keeps ${guard}`).toContain(guard);
        }
        expect((e.managerGuards ?? []).length, `${route} must name its manager guards`).toBeGreaterThan(0);
      } else {
        // (d) whole-route and role-fork: no module gate anywhere, or this entry is
        //     describing the wrong route — an inert gate naming a slug the caller
        //     holds would read as a lock and do nothing.
        expect(src, `${route} carries a module gate, so it is not a whole-route self-service exemption`)
          .not.toContain("requireModuleApiAccess(");
        // (e) the staff record comes from the session's app_user id, which is the
        //     whole substitute for a module gate. `findStaffByAppUser` takes
        //     (clientId, userId) and nothing a caller can choose.
        expect(src, `${route} must resolve its staff row from the session`).toContain(
          "findStaffByAppUser(",
        );
      }

      if (e.selfBranch === "whole-route") {
        // Nothing in the file may read a staff id from the request at all: there is
        // no manager branch here that could legitimately name somebody else.
        expect(src, `${route} must never read a staff id from the request`).not.toMatch(
          /body\.staffId|searchParams\.get\(\s*"staffId"|form\.get\(\s*"staffId"/,
        );
      }

      if (e.selfBranch === "role-fork") {
        // The fork itself, named: "not an approver" IS the self branch here.
        expect(src, `${route} must fork on the approver check`).toMatch(
          /requireApproverRole\(auth\)\s*===\s*null/,
        );
        // The body's staffId appears exactly ONCE either way. Two reads is two
        // places to get it wrong, and the proofs below each pin one site.
        const reads = src.match(/body\.staffId/g) ?? [];
        expect(reads.length, `${route} should read body.staffId exactly once`).toBe(1);
        // Which of the two honest answers this route gives, declared, because the
        // proof is different for each and a missing value would skip both.
        expect(e.staffIdRead, `${route} must declare staffIdRead`).toBeTypeOf("string");

        if (e.staffIdRead === "manager-branch-only") {
          // IGNORED: the read is inside the `canManage ?` ternary, so a future edit
          // that lifted it out of the conditional fails here.
          expect(src, `${route} must read body.staffId only on the manager branch`).toMatch(
            /canManage\s*\?\s*\(str\(body\.staffId/,
          );
        } else {
          // REFUSED: the id is parsed for everybody, so what makes it safe is the
          // DEFAULT and the ESCALATION rather than the parse site.
          //
          // (i) the default target is the session's own staff row, never the body's.
          //     `me` comes from findStaffByAppUser, asserted above.
          expect(src, `${route} must default its target to the session's own staff row`).toMatch(
            /const targetId = askedFor \?\? me\?\.id;/,
          );
          // (ii) "somebody else" is decided by comparing against that row — which is
          //      also true when the caller has NO row, so an unlinked login escalates
          //      rather than slipping through the self branch.
          expect(src, `${route} must decide 'somebody else' against the session's row`).toMatch(
            /const onBehalf = targetId !== me\?\.id;/,
          );
          // (iii) and that branch carries BOTH locks. Scoped to the branch body, not
          //       the file: a requireApproverRole anywhere in a 200-line route proves
          //       nothing about the path a spoofed staffId actually takes.
          const at = src.indexOf("if (onBehalf) {");
          expect(at, `${route} must branch on onBehalf`).toBeGreaterThan(-1);
          const elseAt = src.indexOf("} else {", at);
          const onBehalfBranch = src.slice(at, elseAt === -1 ? undefined : elseAt);
          expect(onBehalfBranch, `${route}'s on-behalf branch must carry the approver guard`)
            .toMatch(/const roleDenied = requireApproverRole\(auth\);\s*\n\s*if \(roleDenied\) return roleDenied;/);
          expect(
            onBehalfBranch,
            `${route}'s on-behalf branch must carry its own capability`,
          ).toContain('await requireCapability(auth, "people.clock.record-for-other")');
          // ...and the SELF branch carries the other key, so the two acts stay two
          // acts and an owner can withhold either alone.
          const selfBranch = elseAt === -1 ? "" : src.slice(elseAt, src.indexOf("\n  }", elseAt));
          expect(selfBranch, `${route}'s self branch must carry its own capability`).toContain(
            'await requireCapability(auth, "people.clock.self")',
          );
          // (iv) the GET half of the same fork: a non-approver's list is narrowed to
          //      the session's row, and `me?.id` on an unlinked login matches nobody.
          expect(src, `${route}'s GET must narrow a non-approver to their own row`).toMatch(
            /canManage \? toClockStaff\(allStaff\) : toClockStaff\(allStaff\.filter\(\(s\) => s\.id === me\?\.id\)\)/,
          );
        }
      }
    },
  );

  it("resolveSelfStaff cannot be asked about anybody but the session's own user", () => {
    // The single fact five self-service branches rest on, asserted once, against the
    // helper itself rather than against each route's use of it.
    const helper = srcFile("lib/self-service/read.ts");
    expect(helper).toContain("export async function resolveSelfStaff");
    // It resolves the row from the CLIENT and the SESSION's user id...
    expect(helper).toContain("findStaffByAppUser(clientId, auth.id)");
    // ...and there is no staff id in its signature, its body, or anywhere else in
    // the file. A fourth parameter would make every caller a potential IDOR at once.
    expect(helper).not.toMatch(/staffId/);
    // A caller with no session resolves to NOBODY, which is the fail-closed
    // direction for a branch that has no role guard on it.
    expect(helper).toContain("if (!auth) return unlinked()");
    // And `mine=1` is exact, so a stray `?mine` cannot drop the manager guards.
    expect(helper).toContain('url.searchParams.get("mine") === "1"');
  });

  it("the self-service category has not become a dumping ground", () => {
    // A closed list. Every addition is a route that hands somebody their own record
    // with no module gate in front of that branch, which is a decision worth making
    // one at a time. Six of the seven exist because My work's FIVE tabs each read a
    // different lane's data; the seventh is the signature that tab posts.
    //
    // `staff-check-in` is the newest entry and the oldest route: it always behaved
    // this way (it is the shape `absence` was written to copy) and simply had no
    // entry, so the fifth tab's endpoint was the one self-service surface with no
    // structural proof over it at all.
    const selfService = of("self-service").map(([r]) => r).sort();
    expect(selfService).toEqual([
      "absence",
      "hr/document",
      "hr/document/url",
      "hr/policy",
      "hr/policy/[id]/sign",
      "rota/shifts",
      "staff-check-in",
    ]);
  });

  it("the shell endpoints stay what they claim to be", () => {
    // Both are authed (so they are not accidental public holes)...
    expect(routeSource("telemetry")).toContain("requireUser");
    expect(routeSource("feedback")).toContain("requireUser");
    // ...and feedback's cross-client list/status stay agency-only, which is the only
    // reason those two methods need no module lock of their own.
    expect(routeSource("feedback")).toContain("agency_admin");
  });
});

// ===========================================================================
// THE PER-ROLE PROOF ON THE THIRTEEN.
//
// This is the block that had to exist before a fifth role could. It does not ask
// "is the clinician allowed" — that question is answered above and was never the
// exposure. It asks, for every role the platform has: is this role either NAMED on
// the exemption, or PROVABLY refused by a guard that is actually in the route's
// source? A `roles` field that claims a lock the code does not implement fails
// here, and so does code that widens past what the field claims.
// ===========================================================================
describe("the clinician exemptions name their roles, and deny every other role provably", () => {
  const clinicianRoutes = Object.entries(EXEMPT)
    .filter(([, e]) => e.kind === "clinician")
    .map(([r]) => r);

  it("there are thirteen of them and every one names its roles (the sweep is not vacuous)", () => {
    expect(clinicianRoutes).toHaveLength(13);
    for (const route of clinicianRoutes) {
      expect(EXEMPT[route].roles, `${route} must name its roles`).toBeDefined();
      expect(EXEMPT[route].roles!.length).toBeGreaterThan(0);
    }
    // Both halves of the exposure are represented, so a future edit cannot shrink
    // this to the easy cases: the diary and the patient database.
    expect(clinicianRoutes.filter((r) => EXEMPT[r].slug === "calendar").length).toBe(4);
    expect(clinicianRoutes.filter((r) => EXEMPT[r].slug === "patients").length).toBe(9);
  });

  it.each(clinicianRoutes)("%s: every role it does not name is refused by a guard in its source", (route) => {
    const e = EXEMPT[route];
    const src = routeSource(route);
    const slug = e.slug!;

    // What the guards ACTUALLY present in this file provably refuse.
    const provablyDenied = new Set<Role>();

    // (a) the module gate, if the route carries one for its own slug. The denial
    // set is DERIVED from canRoleAccessModule, so if STAFF_SLUGS ever gained
    // "patients" every route resting on it fails here instead of quietly opening.
    if (moduleSlugsIn(src).includes(slug)) {
      for (const role of ALL_ROLES) if (!canRoleAccessModule(role, slug)) provablyDenied.add(role);
    }

    // (b) a role guard that narrows further, named by the entry and looked up in
    // GUARD_ADMITS (whose values are the imported, tested constants).
    if (e.narrowedBy) {
      expect(src, `${route} claims ${e.narrowedBy} but does not call it`).toContain(e.narrowedBy);
      const admits = GUARD_ADMITS[e.narrowedBy];
      for (const role of ALL_ROLES) if (!admits.includes(role)) provablyDenied.add(role);
    }

    // THE ASSERTION. Every role the entry does not name must be in that set.
    for (const role of ALL_ROLES) {
      if (e.roles!.includes(role)) continue;
      expect(
        provablyDenied.has(role),
        `/api/${route} claims ${role} is denied, but nothing in its source refuses ${role}. ` +
          `Add requireModuleApiAccess(auth, "${slug}") or a role guard, or correct the roles field.`,
      ).toBe(true);
    }

    // And the converse: a role the entry DOES name must not be one the route's own
    // guards refuse, or the entry is describing a surface nobody can reach.
    for (const role of e.roles!) {
      expect(provablyDenied.has(role), `/api/${route} names ${role} but its guards refuse it`).toBe(false);
    }
  });

  it.each(clinicianRoutes)("%s never names the fifth role", (route) => {
    // THE HEADLINE, stated on its own so it cannot be lost inside the loop above.
    // These thirteen routes are the live diary and the whole patient database. A
    // client_staff login — a nurse, a receptionist — reaches none of them, ever.
    expect(EXEMPT[route].roles).not.toContain("client_staff");
    expect(canRoleAccessModule("client_staff", EXEMPT[route].slug!)).toBe(false);
  });

  it.each(clinicianRoutes.filter((r) => EXEMPT[r].writeRoles))(
    "%s narrows its WRITE methods below its read set, with the guard to match",
    (route) => {
      const e = EXEMPT[route];
      expect(e.writeGuard, `${route} declares writeRoles so it must name writeGuard`).toBeTypeOf("string");
      expect(routeSource(route), `${route} claims ${e.writeGuard} but does not call it`).toContain(
        e.writeGuard!,
      );
      // The claimed set IS the guard's set, imported not retyped.
      expect([...e.writeRoles!].sort()).toEqual([...GUARD_ADMITS[e.writeGuard!]].sort());
      // Strictly narrower than what may read, or it is not a narrowing at all.
      expect(e.writeRoles!.length).toBeLessThan(e.roles!.length);
      for (const role of e.writeRoles!) expect(e.roles).toContain(role);
      // THE NAMED TIGHTENING: the coordinator may still read the clinical record and
      // may no longer author one. Before this change every one of these accepted a
      // coordinator write.
      expect(e.roles).toContain("client_coordinator");
      expect(e.writeRoles).not.toContain("client_coordinator");
      // ...while the clinician, the role these surfaces exist for, keeps both.
      expect(e.writeRoles).toContain("client_clinician");
    },
  );

  it("the three clinical-write routes are exactly the ones that declare writeRoles", () => {
    // A closed list, so a fourth clinical writer cannot appear without a decision.
    expect(clinicianRoutes.filter((r) => EXEMPT[r].writeRoles).sort()).toEqual([
      "charting/draft",
      "medical-history/[action]",
      "perio/[action]",
    ]);
  });

  it("the appointment PATCH is guarded inside performMove, not only in the route", () => {
    // calendar/appointment/[id] delegates its whole PATCH to performMove, so the
    // requireDiaryAdmin token in the route file covers GET alone. The write half of
    // the claim lives in move-service.ts and is asserted there rather than assumed.
    const moveService = srcFile("lib/calendar/move-service.ts"); // src/lib/...
    expect(moveService).toContain("isPatientAdminRole(");
    expect(routeSource("calendar/appointment/[id]")).toContain("performMove(");
  });

  it("STAFF_SLUGS holds neither the diary nor the patient database, which is why all this holds", () => {
    // The single fact the whole block rests on, asserted once, loudly. If a future
    // edit adds "patients" or "calendar" to STAFF_SLUGS, the derived denial sets
    // above collapse and every one of the thirteen fails — which is the intent.
    expect(STAFF_SLUGS.has("patients")).toBe(false);
    expect(STAFF_SLUGS.has("calendar")).toBe(false);
    expect([...STAFF_SLUGS].sort()).toEqual(["", "my-work"]);
  });
});

describe("the API guard and the page guard are the same lock in two places", () => {
  it("the clinician is denied Conversations, and the inbox routes now ask", () => {
    expect(canRoleAccessModule("client_clinician", "conversations")).toBe(false);
    expect(routeSource("inbox/reply")).toContain('requireModuleApiAccess(auth, "conversations")');
    expect(routeSource("inbox/threads")).toContain('requireModuleApiAccess(auth, "conversations")');
  });

  it("the other three roles keep Conversations, so nothing was taken away", () => {
    for (const role of ["agency_admin", "client_owner", "client_coordinator"] as const) {
      expect(canRoleAccessModule(role, "conversations")).toBe(true);
    }
  });
});

describe("the flagship reports routes stay OWNER-ONLY at the API layer", () => {
  // Reports is owner-only (its page calls requireModuleAccess("reports"); the nav
  // OWNER_ROLES lists it). The page guard never runs on these data routes, so each
  // must repeat requireOwnerRole or a coordinator/clinician could pull the
  // per-clinician breakdowns the screen denies them. nhs-clinical is Report C, the
  // completed-vs-pending sibling of nhs-activity; the same lock must hold on it.
  const reportRoutes = ["reports/nhs-activity", "reports/nhs-clinical", "reports/payment-allocation"];

  it.each(reportRoutes)("%s exists and calls requireOwnerRole after requireUser", (route) => {
    expect(ROUTES).toContain(route);
    const src = routeSource(route);
    expect(src).toContain("requireUser");
    expect(src).toContain("requireClientAccess");
    expect(src).toContain("requireOwnerRole(");
  });
});
