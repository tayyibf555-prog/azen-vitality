/**
 * AREA 4 — Cron endpoint auth + sweep safety.
 *
 * Part 1: behavioural tests for the shared cronUnauthorized() guard
 * (fail-closed in production when CRON_SECRET is unset, 401 on bad/missing
 * header, never throws on hostile header values).
 *
 * Part 2: a static contract test over EVERY cron/sweep/sync/drain route file:
 * each must (a) run an auth check as the first thing in the handler, before
 * any work or cron-lock acquisition, (b) export GET = POST (pg_cron's
 * trigger_app_cron fires net.http_get, Vercel Cron also uses GET), and
 * (c) set maxDuration for the long-running work.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cronUnauthorized } from "@/lib/cron";

function req(auth?: string): Request {
  return new Request("http://localhost/api/test", {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cronUnauthorized (shared guard)", () => {
  it("fails CLOSED in production when CRON_SECRET is unset (503, no bypass)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    delete process.env.CRON_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    const res = cronUnauthorized(req("Bearer anything"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    await expect(res!.json()).resolves.toEqual({ error: "CRON_SECRET not configured" });
  });

  it("allows unset secret ONLY outside production (documented dev convenience)", () => {
    vi.stubEnv("CRON_SECRET", "");
    delete process.env.CRON_SECRET;
    vi.stubEnv("NODE_ENV", "development");
    expect(cronUnauthorized(req())).toBeNull();
  });

  it("rejects a missing Authorization header with 401", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = cronUnauthorized(req());
    expect(res!.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(cronUnauthorized(req("Bearer wrong"))!.status).toBe(401);
  });

  it("rejects a correct token with the wrong scheme casing (strict compare)", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(cronUnauthorized(req("bearer s3cret"))!.status).toBe(401);
  });

  it("rejects the bare secret without the Bearer prefix", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(cronUnauthorized(req("s3cret"))!.status).toBe(401);
  });

  it("accepts the exact Bearer token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(cronUnauthorized(req("Bearer s3cret"))).toBeNull();
  });

  it("never throws on hostile or odd header values (plain === compare, no timingSafeEqual length trap)", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const hostile = [
      "Bearer " + "x".repeat(100_000),
      "Bearer s3cret extra",
      "Basic czNjcmV0",
      "",
    ];
    for (const h of hostile) {
      expect(() => cronUnauthorized(req(h))).not.toThrow();
      expect(cronUnauthorized(req(h))!.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: static contract over every cron-callable route file.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../..");

/** Routes guarded by the shared cronUnauthorized() helper. */
const SHARED_GUARD_ROUTES = [
  "src/app/api/coordinator/sweep/route.ts",
  "src/app/api/noshow/sweep/route.ts",
  "src/app/api/reviews/sweep/route.ts",
  "src/app/api/rota/sweep/route.ts",
  "src/app/api/speed-to-lead/sweep/route.ts",
  "src/app/api/sync/coordinator/route.ts",
  "src/app/api/sync/dentally/route.ts",
  "src/app/api/sync/noshow/route.ts",
  "src/app/api/sync/reactivation/route.ts",
  "src/app/api/sync/recall/route.ts",
];

/** Routes with a local authorized() copy of the same fail-closed pattern. */
const INLINE_GUARD_ROUTES = [
  "src/app/api/messaging/drain/route.ts",
  "src/app/api/reactivation/sweep/route.ts",
  "src/app/api/recall/sweep/route.ts",
];

const ALL_CRON_ROUTES = [...SHARED_GUARD_ROUTES, ...INLINE_GUARD_ROUTES];

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("cron route static contract (all 13 cron-callable routes)", () => {
  it.each(SHARED_GUARD_ROUTES)("%s uses cronUnauthorized and short-circuits", (rel) => {
    const code = src(rel);
    expect(code).toMatch(/const unauth = cronUnauthorized\(request\);\s*\n\s*if \(unauth\) return unauth;/);
  });

  it.each(INLINE_GUARD_ROUTES)("%s inline authorized() fails closed in production", (rel) => {
    const code = src(rel);
    // The exact fail-closed line: unset secret is only OK outside production.
    expect(code).toMatch(/if \(!secret\) return process\.env\.NODE_ENV !== "production";/);
    // And the handler rejects before doing anything else.
    expect(code).toMatch(/if \(!authorized\(request\)\) return Response\.json\(\{ error: "unauthorized" \}, \{ status: 401 \}\);/);
  });

  it.each(ALL_CRON_ROUTES)("%s exports GET = POST (pg_cron trigger_app_cron uses http_get)", (rel) => {
    expect(src(rel)).toMatch(/export const GET = POST;/);
  });

  it.each(ALL_CRON_ROUTES)("%s sets maxDuration = 300 for the long-running run", (rel) => {
    expect(src(rel)).toMatch(/export const maxDuration = 300;/);
  });

  it.each(ALL_CRON_ROUTES)("%s checks auth BEFORE acquiring the cron lock / doing work", (rel) => {
    const code = src(rel);
    const authIdx = (() => {
      const shared = code.indexOf("cronUnauthorized(request)");
      // For inline routes, find the CALL inside the handler, not the definition.
      const inline = code.indexOf("if (!authorized(request))");
      return Math.max(shared, inline);
    })();
    expect(authIdx).toBeGreaterThan(-1);
    const lockIdx = code.indexOf("acquireCronLock(");
    if (lockIdx !== -1) {
      expect(authIdx).toBeLessThan(lockIdx);
    }
  });
});
