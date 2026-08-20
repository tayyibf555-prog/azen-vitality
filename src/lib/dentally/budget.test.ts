import { describe, it, expect, afterEach } from "vitest";
import {
  DENTALLY_CEILINGS,
  DENTALLY_HARD_RESERVE,
  DENTALLY_HOURLY_LIMIT,
  __setDentallyBudgetForTests,
  consumeDentallyBudget,
  currentDentallyPriority,
  dentallyBudgetKey,
  dentallyCeiling,
  runWithDentallyPriority,
  type BudgetConsumer,
  type DentallyPriority,
} from "./budget";

// ---------------------------------------------------------------------------
// The guard exists because a cache warmer emptied a working practice's Dentally
// quota for a day. Everything below is a rule that had to hold for that to be
// impossible, tested so that deleting the rule fails here rather than in a
// surgery on a Monday morning.
// ---------------------------------------------------------------------------

/** An in-memory stand-in for api_budget + consume_rate_budget: one counter per key. */
function counterConsumer(): BudgetConsumer & { used(key: string): number } {
  const counts = new Map<string, number>();
  const fn = (async (_priority, limit, key) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next <= limit;
  }) as BudgetConsumer & { used(key: string): number };
  fn.used = (key: string) => counts.get(key) ?? 0;
  return fn;
}

afterEach(() => {
  __setDentallyBudgetForTests(null);
});

describe("the ceilings", () => {
  it("starves background first, then interactive, and never spends the hard reserve", () => {
    // The ORDER is the whole design: a bulk sweep must run out of budget long
    // before a person looking at a screen does, and both before a patient trying
    // to book. If these ever tie or invert, the guard stops being a priority
    // system and becomes a plain rate limiter.
    expect(dentallyCeiling("background")).toBeLessThan(dentallyCeiling("interactive"));
    expect(dentallyCeiling("interactive")).toBeLessThan(dentallyCeiling("critical"));

    expect(dentallyCeiling("background")).toBe(2160); // 60% of 3,600
    expect(dentallyCeiling("interactive")).toBe(3240); // 90%
    expect(dentallyCeiling("critical")).toBe(3420); // 95%

    // The reserve is what the platform NEVER spends: requests the guard cannot see
    // (in-flight when a refusal lands, retries inside fetch, a path added without a
    // guard) and room for the practice's own Dentally logins.
    expect(DENTALLY_HARD_RESERVE).toBe(180);
    expect(dentallyCeiling("critical") + DENTALLY_HARD_RESERVE).toBe(DENTALLY_HOURLY_LIMIT);
    expect(DENTALLY_CEILINGS.critical).toBeLessThan(1);
  });

  it("is measured against Dentally's own published hourly limit", () => {
    // 3,600/hour is x-ratelimit-limit as observed on live (client.ts getInvoice).
    // A ceiling computed from a different number is a ceiling against nothing.
    expect(DENTALLY_HOURLY_LIMIT).toBe(3600);
  });
});

describe("the counting window", () => {
  it("is keyed to the UTC clock hour, so it is phase-locked to Dentally's", () => {
    // Dentally's limit is a FIXED window that recovers on the hour. A key with a
    // floating window (one anchored at the first call after a reset) lets the tail
    // of our window and the head of the next both land in ONE of Dentally's hours —
    // up to twice the ceiling in the hour that actually matters. Keying on the hour
    // removes the drift entirely.
    const a = dentallyBudgetKey(new Date("2026-08-20T13:00:00.000Z"));
    const b = dentallyBudgetKey(new Date("2026-08-20T13:59:59.999Z"));
    const c = dentallyBudgetKey(new Date("2026-08-20T14:00:00.000Z"));
    expect(a).toBe("dentally:reads:2026-08-20T13");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("shares ONE counter across all three classes", async () => {
    // Nested, not partitioned. Background spending must bring interactive closer to
    // its own ceiling, or "starve background first" would just mean "give background
    // its own private 60%", which is the opposite of the intent.
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const now = new Date("2026-08-20T13:30:00.000Z");
    await consumeDentallyBudget("background", now);
    await consumeDentallyBudget("interactive", now);
    await consumeDentallyBudget("critical", now);
    expect(consumer.used(dentallyBudgetKey(now))).toBe(3);
  });
});

describe("the priority split", () => {
  it("refuses background at 60% while interactive and critical are still served", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const now = new Date("2026-08-20T13:00:00.000Z");

    // Spend the hour up to the background ceiling exactly.
    let last = await consumeDentallyBudget("background", now);
    for (let i = 1; i < dentallyCeiling("background"); i += 1) {
      last = await consumeDentallyBudget("background", now);
    }
    expect(last.allowed).toBe(true); // the 2,160th background request is still within

    const refused = await consumeDentallyBudget("background", now);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe("over");

    // THE POINT OF THE WHOLE EXERCISE: the practice can still be read.
    const interactive = await consumeDentallyBudget("interactive", now);
    expect(interactive.allowed).toBe(true);
    const critical = await consumeDentallyBudget("critical", now);
    expect(critical.allowed).toBe(true);
  });

  it("refuses interactive at 90% while the booking calendar and agent are still served", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const now = new Date("2026-08-20T13:00:00.000Z");
    for (let i = 0; i < dentallyCeiling("interactive"); i += 1) {
      await consumeDentallyBudget("interactive", now);
    }
    expect((await consumeDentallyBudget("interactive", now)).allowed).toBe(false);
    // A patient mid-booking outranks a dashboard. That is the last thing to die.
    expect((await consumeDentallyBudget("critical", now)).allowed).toBe(true);
  });

  it("starts a fresh budget in the next clock hour", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const hour1 = new Date("2026-08-20T13:00:00.000Z");
    for (let i = 0; i <= dentallyCeiling("background"); i += 1) {
      await consumeDentallyBudget("background", hour1);
    }
    expect((await consumeDentallyBudget("background", hour1)).allowed).toBe(false);
    // Dentally's window recovers on the hour, so ours must too — otherwise a sweep
    // refused at 13:59 would still be refused at 14:01 for no reason.
    const hour2 = new Date("2026-08-20T14:00:00.000Z");
    expect((await consumeDentallyBudget("background", hour2)).allowed).toBe(true);
  });
});

describe("the fail-safe asymmetry", () => {
  const exploding: BudgetConsumer = async () => {
    throw new Error("supabase unavailable");
  };

  it("FAILS OPEN for interactive and critical when the budget store is down", async () => {
    __setDentallyBudgetForTests(exploding);
    for (const priority of ["interactive", "critical"] as const) {
      const d = await consumeDentallyBudget(priority);
      expect(d.allowed, `${priority} must not be blocked by our own bookkeeping`).toBe(true);
      expect(d.reason).toBe("store-unavailable");
    }
  });

  it("FAILS CLOSED for background when the budget store is down", async () => {
    // A bulk scan that cannot see the budget is exactly the thing that empties it,
    // and it loses nothing by waiting: every sweep here is idempotent and re-runs on
    // the next tick. Running blind is how the quota disappears.
    __setDentallyBudgetForTests(exploding);
    const d = await consumeDentallyBudget("background");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("store-unavailable");
  });

  it("never throws, whatever the store does", async () => {
    // The call site's only job is to obey a decision. A guard that throws its own
    // errors would be caught by the read paths' try/catch and read as "Dentally is
    // down", which is a different and less true statement.
    __setDentallyBudgetForTests(exploding);
    await expect(consumeDentallyBudget("background")).resolves.toBeTruthy();
  });
});

describe("the ambient priority scope", () => {
  it("defaults to interactive outside any scope", () => {
    // An unclassified read is far more likely to be a page someone is waiting on
    // than a bulk sweep, and the failure modes are not equal: mis-classing a sweep
    // costs headroom, mis-classing a dashboard blanks it at 60%.
    expect(currentDentallyPriority()).toBe("interactive");
  });

  it("carries the class through awaits and concurrent fan-outs", async () => {
    // The sweeps do not build their own client for most reads — they call helpers
    // that build one from the environment, concurrently, several layers down. If the
    // class did not survive Promise.all it would not classify the reads that matter.
    const seen: DentallyPriority[] = [];
    await runWithDentallyPriority("background", async () => {
      await Promise.all(
        [0, 1, 2].map(async () => {
          await new Promise((r) => setTimeout(r, 1));
          seen.push(currentDentallyPriority());
        }),
      );
    });
    expect(seen).toEqual(["background", "background", "background"]);
    expect(currentDentallyPriority()).toBe("interactive"); // and it does not leak out
  });

  it("nests, so a critical read inside a background job is still critical", async () => {
    let inner: DentallyPriority = "interactive";
    await runWithDentallyPriority("background", async () => {
      await runWithDentallyPriority("critical", async () => {
        inner = currentDentallyPriority();
      });
    });
    expect(inner).toBe("critical");
  });
});

describe("the guard's own installation", () => {
  it("is disabled under VITEST unless a test installs one", async () => {
    // Mirrors the display cache. The suite drives the reads with fake fetches and no
    // database; a guard that fails closed for background work would otherwise turn
    // every sweep test into a refusal.
    expect(process.env.VITEST).toBeTruthy();
    __setDentallyBudgetForTests(null);
    const d = await consumeDentallyBudget("background");
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("disabled");
  });
});
