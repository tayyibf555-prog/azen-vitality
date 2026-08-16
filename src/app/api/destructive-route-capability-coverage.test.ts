import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CAPABILITIES, CAPABILITY_KEYS } from "@/lib/capabilities/keys";

// ===========================================================================
// A CAPABILITY THAT GUARDS NOTHING IS WORSE THAN NO CAPABILITY.
//
// The owner ticks it and believes it. So this file checks the catalog against
// the filesystem in BOTH directions:
//
//   forwards   every route/file a CapabilityDef names in `enforcedAt` /
//              `enforcedIn` really calls requireCapability with that exact key;
//   backwards  every file that calls requireCapability is named by some key, so
//              enforcement cannot exist outside the catalog either.
//
// and then sweeps every write route in the platform, requiring each to carry
// SOME proven authorisation — a capability, a role/module guard, or a documented
// exemption whose stated reason is itself checked.
//
// ---------------------------------------------------------------------------
// WHY THE SWEEP ACCEPTS A ROLE GUARD AND NOT ONLY A CAPABILITY.
// ---------------------------------------------------------------------------
// The v1 catalog deliberately contains ONLY keys that are enforced (see keys.ts).
// Several lanes — the rota, hours and pay, the HR file — are enforced today by
// `requireApproverRole` / `requireOwnerRole` and swap to `requireCapability` when
// their keys join the catalog. Demanding a capability on every write route today
// would force either a fake key per route or a hundred-entry exemption list, and
// both destroy the honesty this file exists to protect. So the INTERIM tier is
// named, counted, and shrinking: the assertion is that no write route has NO
// authorisation at all, plus a hard floor on how many are on the capability tier.
// ===========================================================================

const API_DIR = fileURLToPath(new URL(".", import.meta.url));
/** src/ — API_DIR is src/app/api. */
const SRC_DIR = join(API_DIR, "..", "..");

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

/** A route that exports at least one state-changing method. */
const WRITE_METHOD = /export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\b/;

function isWriteRoute(route: string): boolean {
  return WRITE_METHOD.test(routeSource(route));
}

const WRITE_ROUTES = ROUTES.filter(isWriteRoute);

// ---------------------------------------------------------------------------
// The authorisation tokens this sweep recognises, each with what it proves.
// ---------------------------------------------------------------------------

/** The per-person gate. */
const CAPABILITY_TOKEN = "requireCapability(";

/**
 * The INTERIM tier: role- or module-level guards. Real locks, coarser than a
 * capability. Every one of these is a candidate for a capability key later.
 */
const ROLE_TOKENS = [
  "requireOwnerRole(",
  "requireApproverRole(",
  "requireModuleApiAccess(",
  "requirePatientAdmin(",
  "requireDiaryAdmin(",
  "requireClinicalWriteRole(",
];

/**
 * The awaited result must be RETURNED, not merely computed.
 *
 * `src.includes("requireCapability(")` was the whole test, and a guard whose
 * answer is thrown away compiles, reads as a lock, and does nothing:
 *
 *     const capDenied = await requireCapability(auth, "rota.edit");   // ...and no
 *     // if (capDenied) return capDenied;                                 return
 *
 * The sibling sweep already learned this for role guards (ROLE_GUARD_CALL in
 * client-api-module-guard-coverage.test.ts excludes the `=== null` shape for
 * exactly the same reason). Every call site in the codebase uses the assign-then-
 * return form, so requiring it costs nothing and closes the class.
 */
const CAPABILITY_ASSIGNMENT = /(?:const|let)\s+(\w+)\s*=\s*await\s+requireCapability\(/g;

function hasCapabilityCall(src: string): boolean {
  if (!src.includes(CAPABILITY_TOKEN)) return false;
  const names = [...src.matchAll(CAPABILITY_ASSIGNMENT)].map((m) => m[1]);
  if (names.length === 0) return false;
  return names.every((n) =>
    new RegExp(`\\bif\\s*\\(\\s*${n}\\s*\\)\\s*return\\s+${n}\\s*;`).test(src) ||
    new RegExp(`\\breturn\\s+${n}\\s*;`).test(src),
  );
}
function hasRoleGuard(src: string): boolean {
  return ROLE_TOKENS.some((t) => src.includes(t));
}

// ---------------------------------------------------------------------------
// THE EXEMPTIONS. Write routes that carry no authorisation because there is no
// session to authorise. Every entry is corroborated structurally below, so a
// reason that stops being true fails here rather than sitting in a comment.
// ---------------------------------------------------------------------------

interface DestructiveExemption {
  kind: "public" | "webhook" | "cron" | "mock" | "dev" | "shell" | "self-service";
  reason: string;
}

const DESTRUCTIVE_EXEMPT: Record<string, DestructiveExemption> = {
  // --- no session exists: a patient or a visitor is the caller ---------------
  "booking/hold": { kind: "public", reason: "public online booking: a patient holds a slot" },
  "booking/create": { kind: "public", reason: "public online booking: a patient books the held slot" },
  "funnel-event": { kind: "public", reason: "public landing-page funnel beacon, budget-guarded" },
  "landing-lead": { kind: "public", reason: "public landing-page lead capture, budget-guarded" },
  "onboarding/submit": { kind: "public", reason: "public new-patient onboarding form submit" },
  "onboarding/upload": { kind: "public", reason: "public onboarding document upload" },
  "medical-history/public-submit": { kind: "public", reason: "patient-facing medical-history submit, token-verified" },
  "fp17/submit": { kind: "public", reason: "public FP17/PR declaration submit, token-bound + budget-guarded" },
  "smile-assessment/next": { kind: "public", reason: "public quiz: serves the next question" },
  "smile-assessment/submit": { kind: "public", reason: "public quiz submit, signed submit token" },
  "smile-assessment/step-event": {
    kind: "public",
    reason:
      "public quiz: anonymous, PII-free step-view beacon. It writes scalar rows to one telemetry table and nothing else — no message, no lead, no Dentally call — so the authorisation question ('who may do this to whom') has no subject: the caller is a visitor and the row is about a screen, not a person. What bounds it instead is cost and volume: a payload cap, three api_budget ceilings (per IP, per campaign per minute, per campaign per day) and a strict kill-switch check",
  },
  "speed-to-lead/intake": { kind: "public", reason: "public lead intake from website / missed call" },
  prefs: { kind: "public", reason: "patient channel choice + opt-out behind a signed /prefs token" },

  // --- provider webhooks: authenticated by Twilio's signature ----------------
  "webhooks/twilio/inbound": { kind: "webhook", reason: "Twilio inbound SMS/WhatsApp webhook" },
  "webhooks/twilio/status": { kind: "webhook", reason: "Twilio delivery-status webhook" },
  "webhooks/twilio/voice": { kind: "webhook", reason: "Twilio voice webhook" },

  // --- the scheduler: CRON_SECRET, never a browser session ------------------
  "coordinator/sweep": { kind: "cron", reason: "treatment-coordinator sweep" },
  "noshow/sweep": { kind: "cron", reason: "the no-show defence sweep, run by the scheduler" },
  "outreach/sweep": { kind: "cron", reason: "the segment-outreach sweep, run by the scheduler" },
  "reactivation/sweep": { kind: "cron", reason: "the reactivation sweep, run by the scheduler" },
  "recall/sweep": { kind: "cron", reason: "the recall concierge sweep, run by the scheduler" },
  "reviews/sweep": { kind: "cron", reason: "the review-request sweep, run by the scheduler" },
  "rota/sweep": { kind: "cron", reason: "rota generation + staff SMS sweep" },
  "speed-to-lead/sweep": { kind: "cron", reason: "speed-to-lead follow-up sweep" },
  "landing-pages/promote-sweep": { kind: "cron", reason: "A/B winner promotion sweep" },
  "messaging/drain": { kind: "cron", reason: "the shared outbox drain" },
  "meta-ads/insights": { kind: "cron", reason: "hourly Meta insights pull" },
  "sync/coordinator": { kind: "cron", reason: "Dentally -> treatment-coordinator sync" },
  "sync/dentally": { kind: "cron", reason: "the Dentally patient sync, run by the scheduler" },
  "sync/noshow": { kind: "cron", reason: "Dentally -> no-show defence sync" },
  "sync/patient-count": { kind: "cron", reason: "Dentally patient-count sync" },
  "sync/reactivation": { kind: "cron", reason: "Dentally -> reactivation sync" },
  "sync/recall": { kind: "cron", reason: "Dentally -> recall sync" },

  // --- the mock Dentally API: an external PMS stand-in, not one of ours ------
  "mock-dentally/v1/appointments": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/appointments/[id]": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/patients": { kind: "mock", reason: "mock upstream Dentally API" },
  "mock-dentally/v1/patients/[id]": { kind: "mock", reason: "mock upstream Dentally API" },

  // --- cross-cutting shell plumbing, open to every signed-in role ------------
  telemetry: { kind: "shell", reason: "usage beacon the authed shell posts on every route change; holds no module data" },
  feedback: { kind: "shell", reason: "the shell's 'Request a change' widget; its cross-client methods are agency_admin-only inline" },

  // --- self-service: the write is the caller's own record --------------------
  // The person is recording something about THEMSELVES, resolved from the session.
  // There is no role guard because every role guard in the platform refuses at
  // least one of the two roles the surface exists for, and no capability because
  // the act is "affirm a policy I have been asked to affirm" — a permission to do
  // that is a permission nobody would ever revoke and everybody must hold.
  //
  // What makes it safe is asserted, not asserted-to-be-safe: the identity comes
  // from the session, tenancy is proven, and the route FAILS CLOSED when sign-in is
  // not configured, because a signature with no login behind it would look like
  // evidence and be none. All three are checked in section 4.
  "hr/policy/[id]/sign": {
    kind: "self-service",
    reason: "a member of staff affirms a policy for themselves; the signer is resolved from the session and never from the request",
  },

  // --- dev only -------------------------------------------------------------
  "agent-test": { kind: "dev", reason: "browser harness for the booking agent; hard 404 in production" },
};

// ===========================================================================
// 1. THE SWEEP.
// ===========================================================================

describe("1. every write route carries an authorisation of some kind", () => {
  it("finds a plausible number of routes and of write routes", () => {
    // Without these the whole file passes vacuously on a broken glob.
    expect(ROUTES.length).toBeGreaterThanOrEqual(125);
    expect(WRITE_ROUTES.length).toBeGreaterThanOrEqual(85);
    expect(ROUTES).toContain("permissions");
    expect(WRITE_ROUTES).toContain("systems");
  });

  it.each(WRITE_ROUTES)("/api/%s is guarded, or a documented exemption", (route) => {
    if (route in DESTRUCTIVE_EXEMPT) return; // corroborated in section 3
    const src = routeSource(route);
    expect(
      hasCapabilityCall(src) || hasRoleGuard(src),
      `/api/${route} exports a write method with no authorisation at all. Add ` +
        `await requireCapability(auth, "<key>") (and the key to src/lib/capabilities/keys.ts), ` +
        `or a role/module guard, or an entry in DESTRUCTIVE_EXEMPT with a reason.`,
    ).toBe(true);
  });

  it("no exemption is stale: every exempted path still exists and still writes", () => {
    expect(Object.keys(DESTRUCTIVE_EXEMPT).filter((r) => !ROUTES.includes(r))).toEqual([]);
    expect(Object.keys(DESTRUCTIVE_EXEMPT).filter((r) => !WRITE_ROUTES.includes(r))).toEqual([]);
  });

  it("the capability tier is real and not a rounding error", () => {
    const onCapability = WRITE_ROUTES.filter((r) => hasCapabilityCall(routeSource(r)));
    // The write routes carrying a per-person gate. Was 14 before the HR lane swapped
    // its interim helpers (requirePayAccess and the approver guards on rota, hours,
    // the document vault and the policy library) to real catalog keys; 28 after.
    // Raise this as more swap over; never lower it.
    expect(onCapability.length).toBeGreaterThanOrEqual(26);
  });

  it("the interim tier is named, so its size is visible rather than assumed", () => {
    const interim = WRITE_ROUTES.filter((r) => {
      if (r in DESTRUCTIVE_EXEMPT) return false;
      const src = routeSource(r);
      return !hasCapabilityCall(src) && hasRoleGuard(src);
    });
    // Not a target, a fact: these are the write routes still on a role/module
    // guard alone. Every one is a candidate for a capability key.
    expect(interim.length).toBeGreaterThan(0);
    expect(interim.length).toBeLessThanOrEqual(WRITE_ROUTES.length);
  });
});

// ===========================================================================
// 2. THE BIDIRECTIONAL PIN.
// ===========================================================================

describe("2. the catalog and the filesystem agree, in both directions", () => {
  it("every capability names at least one place it is enforced", () => {
    for (const def of CAPABILITIES) {
      const places = def.enforcedAt.length + (def.enforcedIn?.length ?? 0);
      expect(places, `${def.key} names no enforcement point`).toBeGreaterThan(0);
    }
  });

  it.each(CAPABILITIES.flatMap((d) => d.enforcedAt.map((r) => `${d.key}::${r}`)))(
    "%s — the route exists and really calls the guard with that key",
    (pair) => {
      const [key, route] = pair.split("::");
      expect(ROUTES, `${key} names /api/${route}, which does not exist`).toContain(route);
      const src = routeSource(route);
      // Both halves: the guard is called in THIS file, and the key literal appears
      // in it. (The key is not always the second argument — three routes pass it
      // through their own `authorise(..., { capability })` helper — so pinning the
      // exact call form would force those routes to duplicate the check.)
      expect(src, `/api/${route} does not call requireCapability`).toContain(CAPABILITY_TOKEN);
      expect(src, `/api/${route} never mentions "${key}"`).toContain(`"${key}"`);
    },
  );

  it.each(
    CAPABILITIES.flatMap((d) => (d.enforcedIn ?? []).map((f) => `${d.key}::${f}`)),
  )("%s — the service file exists and really calls the guard with that key", (pair) => {
    const [key, file] = pair.split("::");
    const path = join(SRC_DIR, file);
    expect(existsSync(path), `${key} names ${file}, which does not exist`).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src, `${file} does not call requireCapability`).toContain(CAPABILITY_TOKEN);
    expect(src, `${file} never mentions "${key}"`).toContain(`"${key}"`);
  });

  it("BACKWARDS: no route enforces a capability the catalog does not name", () => {
    // The failure this catches: a route guards `patient.merge` (say) and the grid
    // never shows it, so the practice cannot see or change a rule that is running.
    const named = new Set(CAPABILITIES.flatMap((d) => d.enforcedAt));
    const enforcing = ROUTES.filter((r) => hasCapabilityCall(routeSource(r)));
    const orphans = enforcing.filter((r) => !named.has(r));
    expect(orphans, "these routes call requireCapability but no CapabilityDef names them").toEqual([]);
  });

  it("BACKWARDS: every key literal a route passes is a real catalog key", () => {
    const keys = new Set<string>(CAPABILITY_KEYS);
    const bad: string[] = [];
    for (const route of ROUTES) {
      const src = routeSource(route);
      if (!hasCapabilityCall(src)) continue;
      // Every string literal shaped like a capability key that appears in a file
      // which calls the guard.
      for (const m of src.matchAll(/"([a-z0-9-]+\.[a-z0-9.-]+)"/g)) {
        const literal = m[1];
        // Only judge literals that look like OUR namespace, so import paths and
        // content-types are not dragged in. The second half of the list is the HR
        // lane: its keys are grouped under "people" in the grid but keyed by their
        // own prefixes, and leaving those prefixes out here would have exempted the
        // eight newest keys from the one check that catches a typo'd key literal.
        if (
          !/^(diary|patient|clinical|messaging|people|reports|system|security|hr|hours|rota|esign)\./.test(
            literal,
          )
        ) {
          continue;
        }
        if (!keys.has(literal)) bad.push(`/api/${route}: "${literal}"`);
      }
    }
    expect(bad, "capability-shaped strings that are not in the catalog").toEqual([]);
  });
});

// ===========================================================================
// 3. THE await, AND THE EXEMPTION CATEGORIES.
// ===========================================================================

describe("3. every call is awaited", () => {
  /**
   * THE SHAPE HAZARD. Every other require* in this codebase is SYNCHRONOUS, so
   * `const denied = requireCapability(auth, key)` compiles, is always truthy
   * (a Promise), and the route returns the Promise as its Response. Loud, but
   * confusing, and only at runtime. Pinned here the way the page-guard sweep pins
   * `await requireModuleAccess`.
   */
  const callers = [
    ...ROUTES.filter((r) => hasCapabilityCall(routeSource(r))).map((r) => `api::${r}`),
    ...CAPABILITIES.flatMap((d) => (d.enforcedIn ?? []).map((f) => `src::${f}`)),
  ];

  it("there are callers to check", () => {
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });

  /**
   * THE OTHER SHAPE HAZARD, and the one a presence check cannot see: a route that
   * calls the guard and does not RETURN its answer.
   *
   *     const capDenied = await requireCapability(auth, "rota.edit");
   *     // if (capDenied) return capDenied;      <- deleted
   *
   * `hasCapabilityCall` demands the returning form, so such a route stops counting
   * as guarded — but it would then simply DROP OUT of the `callers` list above and
   * out of `onCapability`, and every remaining assertion would still pass. This
   * makes the drop-out loud: any route mentioning the token at all must satisfy
   * the strict form.
   */
  it.each(ROUTES.filter((r) => routeSource(r).includes(CAPABILITY_TOKEN)))(
    "/api/%s returns the capability refusal rather than computing it",
    (route) => {
      expect(
        hasCapabilityCall(routeSource(route)),
        `/api/${route} calls requireCapability but never returns its Response. ` +
          `A guard whose answer is discarded compiles, reads as a lock and does nothing.`,
      ).toBe(true);
    },
  );

  it.each([...new Set(callers)])("%s awaits every requireCapability call", (id) => {
    const [kind, path] = id.split("::");
    const src = kind === "api" ? routeSource(path) : readFileSync(join(SRC_DIR, path), "utf8");
    // Every occurrence must be preceded by `await ` — allowing for the import line
    // and the type-only mention, which are matched and skipped explicitly.
    const lines = src.split("\n");
    const offenders = lines.filter((line) => {
      if (!line.includes(CAPABILITY_TOKEN)) return false;
      if (line.trimStart().startsWith("import ")) return false;
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return false;
      return !line.includes(`await ${CAPABILITY_TOKEN}`);
    });
    expect(offenders, `${path} calls requireCapability without awaiting it`).toEqual([]);
  });
});

describe("4. each exemption category still means what it says", () => {
  const of = (kind: DestructiveExemption["kind"]) =>
    Object.entries(DESTRUCTIVE_EXEMPT).filter(([, e]) => e.kind === kind);

  it.each(of("public").map(([r]) => r))("%s really is unauthenticated", (route) => {
    // The reason for exempting these is that no session exists. Add one and the
    // reasoning is void: there is now a person to authorise.
    expect(routeSource(route)).not.toContain("requireUser");
  });

  it.each(of("webhook").map(([r]) => r))("%s really is a provider webhook", (route) => {
    expect(route.startsWith("webhooks/")).toBe(true);
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

  it.each(of("shell").map(([r]) => r))("%s really is authed shell plumbing", (route) => {
    // Authed (so not an accidental public hole) and holding no module data.
    expect(routeSource(route)).toContain("requireUser");
  });

  it("the dev-only harness still hard-404s in production", () => {
    const src = routeSource("agent-test");
    expect(src).toContain('process.env.NODE_ENV === "production"');
    expect(src).toContain("404");
  });

  it.each(of("self-service").map(([r]) => r))(
    "%s writes only the caller's own record, and refuses without a login",
    (route) => {
      const src = routeSource(route);
      // Authed and tenanted — the exemption is from the ROLE layer, not from auth.
      expect(src, `${route} must resolve a session`).toContain("await requireUser()");
      expect(src, `${route} must prove tenancy`).toContain("requireClientAccess(");
      // The identity is the session's, so there is no other person's record to write.
      expect(src, `${route} must resolve its subject from the session`).toContain(
        "findStaffByAppUser(",
      );
      // FAIL CLOSED. This is the reason a self-service write can go unguarded by a
      // role at all: with no sign-in configured it records nothing rather than
      // recording an act with no identity behind it.
      expect(src, `${route} must fail closed when sign-in is not configured`).toContain(
        "authEnforced()",
      );
    },
  );

  it("every exemption states a reason worth reading", () => {
    for (const [route, e] of Object.entries(DESTRUCTIVE_EXEMPT)) {
      expect(e.reason.length, `${route}'s reason is too thin`).toBeGreaterThan(15);
    }
  });
});

// ===========================================================================
// 5. THE ROUTES THAT WERE THE ACTUAL EXPOSURE.
// ===========================================================================

describe("5. spot-pins on the acts a practice asked to control", () => {
  const pinned: Record<string, string> = {
    // Four clinical writes that accepted EVERY role of the practice before this
    // campaign: the receptionist could chart a tooth and retract an exam.
    "charting/draft": "clinical.chart.write",
    "perio/[action]": "clinical.perio.write",
    "medical-history/[action]": "clinical.medical-history.write",
    // Cancelling an appointment, which only ever asked "may you see this module".
    "noshow/[action]": "diary.appointment.cancel",
    // Texting a patient in the practice's name.
    "inbox/reply": "messaging.patient.reply",
    // The kill switch, and the screen that governs this whole layer.
    systems: "system.toggle",
    permissions: "security.capability.manage",
  };

  it.each(Object.entries(pinned))("/api/%s pins %s", (route, key) => {
    const src = routeSource(route);
    expect(src).toContain(CAPABILITY_TOKEN);
    expect(src).toContain(`"${key}"`);
  });

  it("retraction is its own key, on both routes that can do it", () => {
    // Withdrawing an entry from the clinical record is the act an inspector asks
    // about by name; it must not be folded into "may write".
    for (const route of ["perio/[action]", "medical-history/[action]"]) {
      expect(routeSource(route)).toContain('"clinical.record.retract"');
    }
  });

  it("pay is OMITTED server-side by the same key that refuses the pay write", () => {
    // These two routes do not appear in `hr.view-pay`'s enforcedAt, and should not:
    // they never REFUSE a caller without the key, they build a response with no pay
    // in it. That distinction is exactly where a leak would hide, so the omission is
    // pinned here rather than trusted — a route that fetched rates and then filtered
    // them in the response has already put them on the wire.
    //
    // THE CALL FORM IS PINNED, NOT JUST THE KEY NAME. A mutation check on the sibling
    // rota pin found that deleting the real guard left the sweep green, because a
    // COMMENT in the same file still quoted the key. Matching the whole awaited call
    // is what makes these assertions bite.
    for (const route of ["hr/profile", "hours/month"]) {
      const src = routeSource(route);
      expect(src, `/api/${route} should key the pay omission on hr.view-pay`).toContain(
        'await hasCapability(auth, "hr.view-pay")',
      );
      // The interim role helper is gone from both: a second authority on the same
      // question is how a per-person grant stops taking effect on one screen.
      expect(src, `/api/${route} still calls the interim canSeePay helper`).not.toContain(
        "canSeePay(",
      );
    }
  });

  it("the rota's three keys are on the three routes, and publish is not on the preview", () => {
    // The publish PREVIEW is a read and carries rota.view; the POST that texts the
    // team carries rota.publish. Getting that backwards would either blank the
    // screen she reads before deciding, or let a revoked publisher press the button.
    const publish = routeSource("rota/publish");
    expect(publish).toContain('await requireCapability(auth, "rota.publish")');
    expect(publish).toContain('await requireCapability(auth, "rota.view")');
    expect(routeSource("rota/shifts")).toContain('await requireCapability(auth, "rota.edit")');
    expect(routeSource("rota/shift/[id]")).toContain('await requireCapability(auth, "rota.edit")');
  });

  it("the permissions API keeps its owner role guard as well as the capability", () => {
    // Belt and braces, and the reason the API coverage sweep is satisfied by this
    // route without an exemption entry.
    const src = routeSource("permissions");
    expect(src).toContain("requireOwnerRole(");
    expect(src).toContain("requireClientAccess(");
  });
});
