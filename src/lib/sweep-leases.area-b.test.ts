// AREA B (cron lock lease vs maxDuration): a static repo-wide regression test.
//
// Invariant: in every route that takes a cron lock, the lease passed to
// acquireCronLock must OUTLIVE the route's exported maxDuration. A lease
// shorter than maxDuration expires while a slow run is still working, so the
// next tick acquires the lock and double-sends the rows the slow run had not
// yet reached (and the slow run's finally-release then drops the new holder's
// lease too). The drain was fixed first; this test locks the invariant in for
// every current and future sweep, so a copy-paste of the old "lease just under
// maxDuration" pattern fails CI instead of shipping.
//
// The test scans src/app for route files that call acquireCronLock, extracts
// each lease literal and the file's exported maxDuration literal, and asserts
// lease > maxDuration for all of them.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..", "app");

function routeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFilesUnder(full));
    else if (entry.isFile() && /^route\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

type LockingRoute = { file: string; source: string };

const lockingRoutes: LockingRoute[] = routeFilesUnder(APP_DIR)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  .filter(({ source }) => source.includes("acquireCronLock("));

describe("cron lock leases outlive maxDuration (repo-wide)", () => {
  it("finds the cron-locked routes (guards against the scan going stale)", () => {
    // If this ever drops to zero the scan is broken (moved dir, renamed helper)
    // and the invariant below would pass vacuously.
    expect(lockingRoutes.length).toBeGreaterThan(0);
  });

  for (const { file, source } of lockingRoutes) {
    const rel = file.slice(file.indexOf("src/app"));

    it(`${rel}: every acquireCronLock lease > exported maxDuration`, () => {
      const durationMatch = source.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
      // A cron-locked route without a numeric maxDuration has no platform kill
      // bound to size the lease against; require it explicitly.
      expect(
        durationMatch,
        `${rel} calls acquireCronLock but has no numeric "export const maxDuration"`,
      ).not.toBeNull();
      const maxDuration = Number(durationMatch![1]);

      const leaseMatches = [...source.matchAll(/acquireCronLock\(\s*["'`][^"'`]+["'`]\s*,\s*(\d+)\s*\)/g)];
      const callCount = (source.match(/acquireCronLock\(/g) ?? []).length;
      // Every call must pass a numeric literal lease so this static check can
      // see it (no variables/expressions that hide a too-short lease).
      expect(
        leaseMatches.length,
        `${rel}: ${callCount} acquireCronLock call(s) but only ${leaseMatches.length} with a numeric literal lease`,
      ).toBe(callCount);

      for (const m of leaseMatches) {
        const lease = Number(m[1]);
        expect(
          lease,
          `${rel}: lease ${lease}s must be strictly greater than maxDuration ${maxDuration}s (use maxDuration + 10)`,
        ).toBeGreaterThan(maxDuration);
      }
    });
  }
});
