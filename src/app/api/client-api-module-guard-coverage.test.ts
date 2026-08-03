import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { CLIENT_NAV, CLINICIAN_SLUGS, EXTRA_OWNER_ONLY_SLUGS, canRoleAccessModule } from "@/lib/nav";

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
//                       module guard would lock out its intended user. `slug` names
//                       it and is checked against CLINICIAN_SLUGS below, so this
//                       category cannot be used to smuggle a module in.
//   kind "shell"        cross-cutting authed plumbing mounted in the app shell for
//                       every signed-in role; not a module and holds no module data.
//   kind "dev"          dev-only harness that hard-404s in production.
// ---------------------------------------------------------------------------
interface Exemption {
  kind: "public" | "webhook" | "cron" | "mock" | "clinician" | "shell" | "dev";
  reason: string;
  /** kind "clinician" only: the CLIENT_NAV slug this route serves. */
  slug?: string;
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
  "smile-assessment/token": { kind: "public", reason: "public quiz: mints the session token" },
  "smile-assessment/next": { kind: "public", reason: "public quiz: serves the next question" },
  "smile-assessment/submit": { kind: "public", reason: "public quiz submit, signed submit token" },
  "speed-to-lead/intake": { kind: "public", reason: "public lead intake from website / missed call" },
  "prefs": { kind: "public", reason: "patient channel choice + opt-out behind a signed /prefs token" },

  // --- provider webhooks: authenticated by Twilio, not by a session --------
  "webhooks/twilio/inbound": { kind: "webhook", reason: "Twilio inbound SMS/WhatsApp webhook" },
  "webhooks/twilio/status": { kind: "webhook", reason: "Twilio delivery-status webhook" },
  "webhooks/twilio/voice": { kind: "webhook", reason: "Twilio voice webhook" },

  // --- scheduler: CRON_SECRET, never a browser session --------------------
  "coordinator/sweep": { kind: "cron", reason: "treatment-coordinator sweep" },
  "noshow/sweep": { kind: "cron", reason: "no-show defence sweep" },
  "outreach/sweep": { kind: "cron", reason: "segment outreach sweep" },
  "reactivation/sweep": { kind: "cron", reason: "reactivation sweep" },
  "recall/sweep": { kind: "cron", reason: "recall sweep" },
  "reviews/sweep": { kind: "cron", reason: "review-request sweep" },
  "rota/sweep": { kind: "cron", reason: "rota generation + staff SMS sweep" },
  "speed-to-lead/sweep": { kind: "cron", reason: "speed-to-lead follow-up sweep" },
  "landing-pages/promote-sweep": { kind: "cron", reason: "A/B winner promotion sweep" },
  "messaging/drain": { kind: "cron", reason: "the shared outbox drain" },
  "meta-ads/insights": { kind: "cron", reason: "hourly Meta insights pull" },
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
  // Guarding these would lock out the very role the allow-list exists to serve.
  // The `slug` is asserted against CLINICIAN_SLUGS below, so nothing else can hide here.
  "calendar/day": { kind: "clinician", slug: "calendar", reason: "their own diary, read" },
  "calendar/appointment/[id]": { kind: "clinician", slug: "calendar", reason: "diary appointment read/move (requireDiaryAdmin)" },
  "calendar/propose": { kind: "clinician", slug: "calendar", reason: "diary slot proposal (requireDiaryAdmin)" },
  "diary/entry": { kind: "clinician", slug: "calendar", reason: "diary breaks + notes (requireDiaryAdmin)" },
  "dentally/patients": { kind: "clinician", slug: "patients", reason: "the patient list they treat from" },
  "dentally/patients/[id]": { kind: "clinician", slug: "patients", reason: "a single patient record" },
  "patient-notes": { kind: "clinician", slug: "patients", reason: "practice notes on the patient record" },
  "patient-notes/transcribe": { kind: "clinician", slug: "patients", reason: "voice dictation for those notes" },
  "charting/draft": { kind: "clinician", slug: "patients", reason: "the FDI chart, a tab of the patient record" },
  "perio/[action]": { kind: "clinician", slug: "patients", reason: "the perio chart, a tab of the patient record" },
  "patients/[id]/profile": { kind: "clinician", slug: "patients", reason: "patient record; already role-gated by requirePatientAdmin" },
  "patients/[id]/status": { kind: "clinician", slug: "patients", reason: "patient record; already role-gated by requirePatientAdmin" },

  // --- cross-cutting shell plumbing, open to every signed-in role ----------
  "telemetry": { kind: "shell", reason: "usage beacon the authed shell posts on every route change; holds no module data" },
  "feedback": { kind: "shell", reason: "the shell's 'Request a change' widget; its list/status methods are agency_admin-only inline" },

  // --- dev only ------------------------------------------------------------
  "agent-test": { kind: "dev", reason: "browser harness for the booking agent; hard 404 in production" },
};

/** A route is guarded if it locks the module, or is restricted to roles the clinician is not in. */
const MODULE_CALL = /requireModuleApiAccess\(\s*\w+\s*,\s*"([^"]*)"\s*\)/g;

function moduleSlugsIn(src: string): string[] {
  return [...src.matchAll(MODULE_CALL)].map((m) => m[1]);
}
function hasRoleGuard(src: string): boolean {
  // The clinician is in neither role list, so either already excludes it.
  return src.includes("requireOwnerRole(") || src.includes("requireApproverRole(");
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

describe("a module guard that names the wrong slug is worse than none", () => {
  const guardedSlugs = [
    ...new Set(ROUTES.flatMap((r) => moduleSlugsIn(routeSource(r)).map((s) => `${r}::${s}`))),
  ];

  it.each(guardedSlugs)("%s names a real module the clinician is denied", (pair) => {
    const slug = pair.split("::")[1];
    // A real slug, so a typo ("conversation") cannot pass as a lock — an unknown slug
    // is allow-by-default for the other three roles and would read as protected.
    expect(NAV_SLUGS.has(slug) || EXTRA_OWNER_ONLY_SLUGS.has(slug)).toBe(true);
    // And one the clinician is actually denied. Guarding with a slug the clinician
    // MAY have (e.g. "patients") compiles, reads as a lock, and does nothing.
    expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
  });

  it("every module-guarded route also resolves a session for it to inspect", () => {
    // requireModuleApiAccess(null, ...) is a deliberate no-op, so a call whose first
    // argument never came from requireUser would be permanently inert.
    const missing = ROUTES.filter(
      (r) => moduleSlugsIn(routeSource(r)).length > 0 && !routeSource(r).includes("requireUser"),
    );
    expect(missing).toEqual([]);
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

  it("the shell endpoints stay what they claim to be", () => {
    // Both are authed (so they are not accidental public holes)...
    expect(routeSource("telemetry")).toContain("requireUser");
    expect(routeSource("feedback")).toContain("requireUser");
    // ...and feedback's cross-client list/status stay agency-only, which is the only
    // reason those two methods need no module lock of their own.
    expect(routeSource("feedback")).toContain("agency_admin");
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
