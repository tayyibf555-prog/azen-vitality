import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asBackgroundRefresh } from "./read";
import { currentDentallyPriority } from "./budget";
import { DASHBOARD_TTL_MS } from "@/lib/dashboard/read";

// ---------------------------------------------------------------------------
// THE 60-SECOND TREADMILL.
//
// The display cache serves an expired row stale and fires a refresh behind the
// response. Two properties of that refresh were quietly dangerous:
//
//   1. It re-stamped the row with the READER's ttl, which for the dashboard was
//      SIXTY SECONDS. The pre-warm's longer stamp was the only thing holding the
//      row still; the moment a cron tick was skipped, the shared row expired every
//      minute and every instance being read re-paged the practice's whole book to
//      re-stamp another minute. Sixty full assemblies an hour against a 3,600/hour
//      ceiling IS the ceiling.
//
//   2. `refreshing` in display-cache.ts dedupes a refresh PER INSTANCE, and Fluid
//      Compute runs many. So a stale key can fan one full re-page out per cold
//      instance that happens to be asked for it.
//
// Both are bounded by classifying the refresh as BACKGROUND work — which it is, by
// definition: the reader already has the stale value and is not waiting — and by
// making the freshness contract one constant instead of two that drifted apart.
// ---------------------------------------------------------------------------

describe("a stale-while-revalidate refresh", () => {
  it("runs its Dentally reads in the background class", async () => {
    // Nobody is waiting on it. If it ran interactive it would keep spending to 90%
    // of the hour and blank the very screen it was refreshing.
    let seen: string | null = null;
    await asBackgroundRefresh(async () => {
      seen = currentDentallyPriority();
    })();
    expect(seen).toBe("background");
  });

  it("does not leave the scope applied to the caller", async () => {
    await asBackgroundRefresh(async () => {})();
    expect(currentDentallyPriority()).toBe("interactive");
  });

  it("is what the scheduler actually uses", () => {
    // The wrapper only helps if the real scheduler goes through it, and the real
    // scheduler cannot be driven here (next/after needs a request scope).
    const source = readFileSync(join(process.cwd(), "src/lib/dentally/read.ts"), "utf8");
    const start = source.indexOf("function afterScheduler(");
    const scheduler = source.slice(start, source.indexOf("\n}", start));
    expect(scheduler).toContain("asBackgroundRefresh(task)");
  });
});

describe("the dashboard freshness contract", () => {
  it("is fifteen minutes, not sixty seconds", () => {
    // At sixty seconds a dashboard being read costs sixty full assemblies an hour.
    // At fifteen it costs four, which is what the budget affords — and it is not a
    // freshness regression: with the pre-warm running every fifteen minutes, what a
    // reader saw was already up to fifteen minutes old.
    expect(DASHBOARD_TTL_MS).toBe(15 * 60_000);
  });

  it("is the SAME constant the pre-warm stamps, so the two cannot drift", () => {
    // They used to be two numbers kept in step by a comment, and the comment is what
    // drifted: twenty minutes on the cron, sixty seconds on the reader.
    const source = readFileSync(
      join(process.cwd(), "src/app/api/dentally/prewarm/route.ts"),
      "utf8",
    );
    expect(source).toContain("const PREWARM_TTL_MS = DASHBOARD_TTL_MS;");
  });
});
