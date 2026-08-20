import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// WHERE THE CLASS IS DECIDED, AND WHY IT HAS TO BE PINNED HERE.
//
// The Dentally budget guard reads its priority from the ambient AsyncLocalStorage
// scope, and the DEFAULT outside any scope is "interactive". That default is the
// right one — an unclassified read is far more likely to be a page someone is
// waiting on than a bulk sweep — but it means a cron route that FORGETS to declare
// itself gets first call on the practice's quota. That is precisely the mistake
// that took the practice offline on 2026-08-20: an unclassified cache warmer
// outcompeted the people it was warming the cache for.
//
// So the declaration is not left to memory. Two rules, enforced over the source:
//
//   1. Any route that takes a cron lease is BACKGROUND. A cron lease is the
//      platform's own marker for "this is a scheduled job, nobody is waiting" —
//      which is the definition of background work — so the rule needs no list to
//      maintain and covers a route added next month for free.
//   2. The named patient-facing paths are CRITICAL.
// ---------------------------------------------------------------------------

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
      continue;
    }
    if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(API_ROOT).map((file) => ({
  path: relative(process.cwd(), file),
  source: readFileSync(file, "utf8"),
}));

/**
 * The patient-facing and agent paths. A patient part-way through booking, and the
 * 24/7 agent answering one, outrank every dashboard and every sweep: they are the
 * last thing the practice can afford to have fail, so they are served to 95% of the
 * hour rather than 90%.
 */
const CRITICAL_ROUTES = [
  "src/app/api/booking/slots/route.ts",
  "src/app/api/booking/create/route.ts",
  "src/app/api/webhooks/twilio/inbound/route.ts",
  "src/app/api/webhooks/twilio/voice/route.ts",
];

describe("Dentally budget priority coverage", () => {
  it("declares every cron-leased route as background work", () => {
    const cronRoutes = ROUTES.filter((r) => r.source.includes("acquireCronLock("));
    // If this ever finds nothing, the rule has stopped matching reality (renamed
    // helper, moved routes) and is silently passing.
    expect(cronRoutes.length).toBeGreaterThan(10);

    const undeclared = cronRoutes
      .filter((r) => !r.source.includes('runWithDentallyPriority("background"'))
      .map((r) => r.path);
    expect(
      undeclared,
      "these scheduled jobs would take the practice's Dentally quota at INTERACTIVE " +
        "priority, ahead of the staff and patients they serve. Wrap the handler in " +
        'runWithDentallyPriority("background", ...).',
    ).toEqual([]);
  });

  it("declares the patient-facing and agent routes as critical", () => {
    for (const path of CRITICAL_ROUTES) {
      const route = ROUTES.find((r) => r.path === path);
      expect(route, `${path} is listed as critical but does not exist`).toBeTruthy();
      expect(
        route!.source.includes('runWithDentallyPriority("critical"'),
        `${path} must declare itself critical: a patient mid-booking must outlast ` +
          "every dashboard and every sweep.",
      ).toBe(true);
    }
  });

  it("routes the pre-warm — the job that caused the incident — through background", () => {
    const prewarm = ROUTES.find((r) => r.path === "src/app/api/dentally/prewarm/route.ts");
    expect(prewarm).toBeTruthy();
    expect(prewarm!.source).toContain('runWithDentallyPriority("background"');
  });

  it("keeps the guard on the client's single read choke point", () => {
    // Every read in the platform goes through DentallyClient.get(). If the guard
    // moves out of it, a read path added later is unguarded by default rather than
    // guarded by default, and this whole file guards nothing.
    const client = readFileSync(join(process.cwd(), "src/lib/dentally/client.ts"), "utf8");
    const getBody = client.slice(client.indexOf("private async get<T>("));
    expect(getBody.slice(0, 600)).toContain("consumeDentallyBudget(");
  });
});
