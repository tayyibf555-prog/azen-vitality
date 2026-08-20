import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DentallyBudgetExceededError, DentallyClient } from "./client";
import {
  DENTALLY_HOURLY_LIMIT,
  DENTALLY_HARD_RESERVE,
  __setDentallyBudgetForTests,
  consumeDentallyBudget,
  dentallyCeiling,
  dentallyScopeRefused,
  runWithDentallyPriority,
  type BudgetConsumer,
} from "./budget";

// ---------------------------------------------------------------------------
// RE-VERIFICATION, ROUND 2 — an INDEPENDENT re-run of the deciding experiment.
//
// This file does not share a helper, a constant or a fixture with
// budget-sticky-refusal.test.ts. It rebuilds the worst swallowing sweep in the
// platform — /api/sync/noshow, whose consent map walks MAX_PATIENT_PAGES=800 pages
// per site in PATIENT_PAGE_BATCH=8 concurrent waves, across THREE sites inside ONE
// background scope — from the constants read out of the route source at test time,
// so it cannot drift from the thing it claims to model.
//
// The counter stand-in below is modelled on the REAL SQL, migration
// 0023_api_budget.sql:
//
//     insert ... on conflict do update set count = api_budget.count + 1
//     returning count into v_count;
//     return v_count <= p_limit;
//
// It increments UNCONDITIONALLY and only then compares. So one call to it is one
// increment of the practice's shared hourly counter, whether the answer is yes or
// no — which is the entire mechanism the prior HOLD was about.
// ---------------------------------------------------------------------------

/** The real route's constants, read from source so this file cannot drift. */
function noshowConstants(): {
  maxPatientPages: number;
  pageBatch: number;
  historyConcurrency: number;
  maxAppointmentsPerRun: number;
} {
  const src = readFileSync(
    join(process.cwd(), "src/app/api/sync/noshow/route.ts"),
    "utf8",
  );
  const num = (name: string): number => {
    const m = src.match(new RegExp(`const ${name} = (\\d+)`));
    if (!m) throw new Error(`${name} not found in the no-show route`);
    return Number(m[1]);
  };
  return {
    maxPatientPages: num("MAX_PATIENT_PAGES"),
    pageBatch: num("PATIENT_PAGE_BATCH"),
    historyConcurrency: num("HISTORY_CONCURRENCY"),
    maxAppointmentsPerRun: num("MAX_APPOINTMENTS_PER_RUN"),
  };
}

/** api_budget + consume_rate_budget, faithful to 0023: increment, THEN compare. */
function sqlFaithfulCounter(): BudgetConsumer & { count(): number } {
  let count = 0;
  const fn = (async (_p: unknown, limit: number) => {
    count += 1; // the increment happens on the refused call too — this is the point
    return count <= limit;
  }) as unknown as BudgetConsumer & { count(): number };
  fn.count = () => count;
  return fn;
}

/** A store that is DOWN: every call throws, as the RPC does on a Supabase outage. */
function deadStore(): BudgetConsumer & { count(): number } {
  let count = 0;
  const fn = (async () => {
    count += 1;
    throw new Error("consume_rate_budget failed: store unreachable");
  }) as unknown as BudgetConsumer & { count(): number };
  fn.count = () => count;
  return fn;
}

/** A client whose upstream always succeeds, so ONLY the budget can stop a read. */
function client(onUpstream: () => void): DentallyClient {
  return new DentallyClient({
    apiKey: "k",
    baseUrl: "https://example.invalid",
    readOnly: true,
    fetchImpl: (async () => {
      onUpstream();
      return new Response(
        JSON.stringify({ patients: [{ id: "1" }], appointments: [{ id: "1" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
}

/** The bounded pool shape the route uses for the history fan-out. */
async function pool<T>(items: readonly T[], limit: number, fn: (i: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next;
        next += 1;
        await fn(items[idx]);
      }
    }),
  );
}

afterEach(() => {
  __setDentallyBudgetForTests(null);
});

// ---------------------------------------------------------------------------
// 1. THE DECIDING EXPERIMENT, RE-RUN
// ---------------------------------------------------------------------------

describe("RE-VERIFY 1: the worst swallowing sweep (no-show, 800 pages x 3 sites)", () => {
  const K = noshowConstants();

  /**
   * /api/sync/noshow reproduced at its real shape and its real scale, with EVERY
   * catch swallowing exactly as the shipped route's catches do.
   *
   * `callersStop` toggles the per-loop `dentallyScopeRefused()` guards the fixer
   * added. FALSE is the honest worst case: it is what the platform degrades to the
   * moment anyone adds a new swallowing loop without remembering the guard, so the
   * safety property has to hold with it off.
   */
  async function noshowRun(
    c: DentallyClient,
    opts: { callersStop: boolean },
  ): Promise<{ pageReads: number; historyReads: number }> {
    let pageReads = 0;
    let historyReads = 0;

    for (let site = 0; site < 3; site += 1) {
      if (opts.callersStop && dentallyScopeRefused()) break; // the site-boundary stop

      // Phase 1 — the consent map: 800 pages in concurrent waves of 8.
      pages: for (let pp = 1; pp <= K.maxPatientPages; pp += K.pageBatch) {
        if (opts.callersStop && dentallyScopeRefused()) break pages;
        const batch: number[] = [];
        for (let k = 0; k < K.pageBatch && pp + k <= K.maxPatientPages; k += 1) {
          batch.push(pp + k);
        }
        await Promise.all(
          batch.map(async (page) => {
            pageReads += 1;
            try {
              await c.listPatients({ siteId: `site${site}`, page, perPage: 100 });
            } catch {
              // THE SWALLOW: "this page is a hole, carry on" — right for a 500,
              // catastrophic for a budget refusal before the fix.
            }
          }),
        );
      }

      // Phase 2 — the appointment window, then the per-patient history fan-out at
      // concurrency 10, each read inside its own swallowing catch.
      const ids = Array.from(
        { length: K.maxAppointmentsPerRun },
        (_, i) => `s${site}p${i}`,
      );
      await pool(ids, K.historyConcurrency, async (id) => {
        if (opts.callersStop && dentallyScopeRefused()) return;
        historyReads += 1;
        try {
          await c.getPatientAppointments(id, 1, 100, true);
        } catch {
          // the second swallow: cache null, move to the next patient
        }
      });
    }
    return { pageReads, historyReads };
  }

  /** Every item the run walks if nothing stops it early. The size of the old lie. */
  const WALKED = 3 * (K.maxPatientPages + K.maxAppointmentsPerRun);

  it("STICKINESS ALONE: the counter tracks reality, and the booking calendar survives", async () => {
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);

    let upstream = 0;
    const c = client(() => {
      upstream += 1;
    });

    // Callers left exactly as they were before this fix round: still swallowing,
    // still walking every one of the 3,300 items. This isolates what budget.ts
    // achieves on its own.
    const walked = await runWithDentallyPriority("background", () =>
      noshowRun(c, { callersStop: false }),
    );
    expect(walked.pageReads + walked.historyReads).toBe(WALKED);
    expect(WALKED).toBeGreaterThan(3_000); // 3,300: the sweep really does walk this far

    const bg = dentallyCeiling("background");

    // (a) REAL DENTALLY CONSUMPTION. The guard stopped sending dead on the ceiling.
    expect(upstream).toBe(bg);

    // (b) THE COUNTER. Before the fix this reached WALKED (3,300) — every swallowed
    //     item a phantom increment — while real consumption sat at 2,160. It must
    //     now equal the real spend plus, at most, the ONE concurrent wave that was
    //     already past the sticky check when the first refusal landed.
    const wave = Math.max(K.pageBatch, K.historyConcurrency);
    expect(counter.count()).toBeGreaterThanOrEqual(bg);
    expect(counter.count()).toBeLessThanOrEqual(bg + wave);
    expect(counter.count()).toBeLessThan(WALKED); // the lie is gone

    // (c) IT NEVER REACHES THE CLASSES ABOVE IT. This is the property the whole
    //     priority split rests on, and the property the phantom increments broke.
    expect(counter.count()).toBeLessThan(dentallyCeiling("interactive"));
    expect(counter.count()).toBeLessThan(dentallyCeiling("critical"));

    // (d) THE PATIENT. /api/booking/slots, its own critical scope, after the sweep.
    const slots = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(
      slots.allowed,
      "a patient mid-booking was refused by our own guard with real Dentally headroom unspent",
    ).toBe(true);
    expect(slots.reason).toBe("within");

    // (e) AND THE HEADROOM IS REAL: over a thousand requests the practice can still
    //     make this hour, on top of everything the sweep spent.
    expect(DENTALLY_HOURLY_LIMIT - counter.count()).toBeGreaterThan(1_400);
  });

  it("WITH THE CALLER STOPS: the same counter, and thousands of no-op items not walked", async () => {
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);

    let upstream = 0;
    const c = client(() => {
      upstream += 1;
    });
    const walked = await runWithDentallyPriority("background", () =>
      noshowRun(c, { callersStop: true }),
    );

    const bg = dentallyCeiling("background");
    const wave = Math.max(K.pageBatch, K.historyConcurrency);
    expect(upstream).toBe(bg);
    expect(counter.count()).toBeLessThanOrEqual(bg + wave);

    // The counter was already safe without this. What the caller stops add is that
    // the run stops PRODUCING NOTHING: it walks materially fewer items than the
    // 3,300 it would otherwise grind through, and stops at a site boundary.
    expect(walked.pageReads + walked.historyReads).toBeLessThan(WALKED);

    const slots = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(slots.allowed).toBe(true);
  });

  it("SIX CONSECUTIVE SWEEPS in one hour still leave the booking calendar served", async () => {
    // Each cron tick is a FRESH scope, so each pays one real refusal plus its own
    // in-flight wave. Six ticks is the hour's whole background queue. If that
    // residual compounded, this is where it would show.
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    const c = client(() => {});

    for (let tick = 0; tick < 6; tick += 1) {
      await runWithDentallyPriority("background", () =>
        noshowRun(c, { callersStop: false }),
      );
    }

    const bg = dentallyCeiling("background");
    const wave = Math.max(K.pageBatch, K.historyConcurrency);
    // Six ticks, six waves. Still nowhere near interactive, let alone critical.
    expect(counter.count()).toBeLessThanOrEqual(bg + 6 * wave);
    expect(counter.count()).toBeLessThan(dentallyCeiling("interactive"));

    const slots = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(slots.allowed, "six sweeps in one hour starved the booking calendar").toBe(true);
    expect(dentallyCeiling("critical") - counter.count()).toBeGreaterThan(1_000);
  });

  it("refuses through the CLIENT with no upstream request and no store call", async () => {
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    let upstream = 0;
    const c = client(() => {
      upstream += 1;
    });

    await runWithDentallyPriority("background", async () => {
      // Spend the class out.
      for (let i = 0; i < dentallyCeiling("background") + 1; i += 1) {
        await consumeDentallyBudget("background");
      }
      const before = counter.count();
      await expect(c.listPatients({ siteId: "s", page: 1 })).rejects.toBeInstanceOf(
        DentallyBudgetExceededError,
      );
      expect(upstream).toBe(0);
      expect(counter.count()).toBe(before); // the refused read cost NOTHING
    });
  });
});

// ---------------------------------------------------------------------------
// 2. ISOLATION: a refused background scope must not starve anyone else
// ---------------------------------------------------------------------------

describe("RE-VERIFY 2: a refused background scope starves nobody else", () => {
  async function exhaustBackground(counter: BudgetConsumer): Promise<void> {
    __setDentallyBudgetForTests(counter);
    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i < dentallyCeiling("background") + 200; i += 1) {
        await consumeDentallyBudget("background");
      }
      expect(dentallyScopeRefused()).toBe(true);
    });
  }

  it("serves a practice manager's screen (interactive) in its own scope", async () => {
    const counter = sqlFaithfulCounter();
    await exhaustBackground(counter);
    const d = await runWithDentallyPriority("interactive", () =>
      consumeDentallyBudget("interactive"),
    );
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("within");
    expect(d.limit).toBe(dentallyCeiling("interactive"));
  });

  it("serves the booking calendar (critical) in its own scope", async () => {
    const counter = sqlFaithfulCounter();
    await exhaustBackground(counter);
    const d = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("within");
  });

  it("serves an UNSCOPED read, which defaults to interactive", async () => {
    const counter = sqlFaithfulCounter();
    await exhaustBackground(counter);
    const d = await consumeDentallyBudget("interactive");
    expect(d.allowed).toBe(true);
    expect(dentallyScopeRefused()).toBe(false); // no scope to inherit a refusal from
  });

  it("serves a CRITICAL read NESTED inside the refused background scope", async () => {
    // The agent taking a call inside a cron tick, and the write-validating read.
    // Nesting opens a new scope with its own ceiling, so it must not inherit.
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i < dentallyCeiling("background") + 1; i += 1) {
        await consumeDentallyBudget("background");
      }
      expect(dentallyScopeRefused()).toBe(true);
      const nested = await runWithDentallyPriority("critical", () =>
        consumeDentallyBudget("critical"),
      );
      expect(nested.allowed).toBe(true);
      expect(nested.reason).toBe("within");
    });
  });

  it("serves a client with an EXPLICIT critical priority inside a refused background scope", async () => {
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    let upstream = 0;
    const critical = new DentallyClient({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      readOnly: true,
      priority: "critical",
      fetchImpl: (async () => {
        upstream += 1;
        return new Response(JSON.stringify({ appointments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i < dentallyCeiling("background") + 1; i += 1) {
        await consumeDentallyBudget("background");
      }
      expect(dentallyScopeRefused()).toBe(true);
      await expect(critical.getPatientAppointments("p1")).resolves.toBeDefined();
      expect(upstream).toBe(1);
    });
  });

  it("does NOT let a refused INTERACTIVE scope dim the booking calendar either", async () => {
    // The other direction of the same property: staff screens spent to 90% must
    // still leave the patient-facing class served.
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    await runWithDentallyPriority("interactive", async () => {
      for (let i = 0; i < dentallyCeiling("interactive") + 1; i += 1) {
        await consumeDentallyBudget("interactive");
      }
      expect(dentallyScopeRefused()).toBe(true);
    });
    const slots = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(slots.allowed).toBe(true);
    // And the hard reserve is still intact and unspendable.
    expect(DENTALLY_HOURLY_LIMIT - dentallyCeiling("critical")).toBe(DENTALLY_HARD_RESERVE);
    expect(counter.count()).toBeLessThan(DENTALLY_HOURLY_LIMIT - DENTALLY_HARD_RESERVE + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. THE FAIL-OPEN / FAIL-CLOSED ASYMMETRY, AFTER THE CHANGE
// ---------------------------------------------------------------------------

describe("RE-VERIFY 3: the asymmetry survives the stickiness", () => {
  it("FAILS OPEN: a person's read proceeds when the budget store is down", async () => {
    const store = deadStore();
    __setDentallyBudgetForTests(store);
    let upstream = 0;
    const c = client(() => {
      upstream += 1;
    });
    await runWithDentallyPriority("interactive", async () => {
      await expect(c.listPatients({ siteId: "s", page: 1 })).resolves.toBeDefined();
      expect(dentallyScopeRefused()).toBe(false); // an allowed call must NOT stick
    });
    expect(upstream).toBe(1);
  });

  it("FAILS OPEN: the booking calendar proceeds when the budget store is down", async () => {
    __setDentallyBudgetForTests(deadStore());
    const d = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("store-unavailable");
  });

  it("FAILS CLOSED: a background bulk read is refused when the budget store is down", async () => {
    const store = deadStore();
    __setDentallyBudgetForTests(store);
    let upstream = 0;
    const c = client(() => {
      upstream += 1;
    });
    await runWithDentallyPriority("background", async () => {
      await expect(c.listPatients({ siteId: "s", page: 1 })).rejects.toBeInstanceOf(
        DentallyBudgetExceededError,
      );
    });
    expect(upstream).toBe(0);
  });

  it("does not HAMMER a down store once per swallowed row", async () => {
    // The stickiness has to apply to the fail-closed path too, or a dead Supabase
    // gets 3,300 doomed RPCs per sweep on top of whatever took it down.
    const store = deadStore();
    __setDentallyBudgetForTests(store);
    const c = client(() => {});
    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i < 2_000; i += 1) {
        try {
          await c.listPatients({ siteId: "s", page: i });
        } catch {
          // the swallow
        }
      }
    });
    expect(store.count()).toBe(1);
  });

  it("keeps the asymmetry when the store recovers mid-hour for a NEW scope", async () => {
    // A tick refused on a dead store must not poison the next tick once it is back.
    let dead = true;
    let calls = 0;
    __setDentallyBudgetForTests(async () => {
      calls += 1;
      if (dead) throw new Error("down");
      return true;
    });
    await runWithDentallyPriority("background", async () => {
      const d = await consumeDentallyBudget("background");
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("store-unavailable");
    });
    dead = false;
    const next = await runWithDentallyPriority("background", () =>
      consumeDentallyBudget("background"),
    );
    expect(next.allowed).toBe(true);
    expect(next.reason).toBe("within");
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. THE ARITHMETIC, RE-CHECKED WITH ALL CONSUMERS
// ---------------------------------------------------------------------------

describe("RE-VERIFY 4: what actually closes the hour", () => {
  /**
   * The pre-warm's own bound, recomputed here from the scan shapes rather than
   * quoted from the SQL comment, so the two are checked against each other.
   */
  const SITES = 3;
  const SCAN_MAX_PAGES = 40;
  const PREWARM_DASHBOARD =
    SCAN_MAX_PAGES * SITES + // payments
    SCAN_MAX_PAGES * SITES + // appointments
    SCAN_MAX_PAGES * SITES + // nhs claims
    SCAN_MAX_PAGES * SITES + // patients
    SCAN_MAX_PAGES * SITES + // treatment plans
    SCAN_MAX_PAGES * 1 + // invoices, unscoped
    1 * SITES; // practitioners
  const PREWARM_OUTSTANDING =
    40 * SITES + // OUTSTANDING_MAX_PAGES unpaid-invoice index
    100 * SITES; // MAX_PAGES of the whole patient book, + UNBOUNDED debtor reads
  const PREWARM_RUN = PREWARM_DASHBOARD + PREWARM_OUTSTANDING;

  it("agrees with the figures the register file states", () => {
    expect(PREWARM_DASHBOARD).toBe(643);
    expect(PREWARM_OUTSTANDING).toBe(420);
    expect(PREWARM_RUN).toBe(1_063);
    const sql = readFileSync(
      join(process.cwd(), "supabase/ops/register-dentally-prewarm-cron.sql"),
      "utf8",
    );
    expect(sql).toContain("643");
    expect(sql).toContain("1,063");
    expect(sql).toContain("'40 * * * *'");
  });

  it("shows ONE hourly pre-warm plus the four syncs already blows 3,600", () => {
    // Four lifecycle syncs, each capped at 300 patients a site (400 for the
    // coordinator including re-checks), 3 sites, at a floor of ONE read per patient.
    const SYNCS_FLOOR = (300 + 300 + 300 + 400) * SITES;
    expect(SYNCS_FLOOR).toBe(3_900);

    // At the MINIMUM cadence this cron can have — once an hour — and with every
    // per-patient enrichment costing its floor of one read, the hour is already over
    // Dentally's ceiling before a single member of staff opens a screen.
    expect(PREWARM_RUN + SYNCS_FLOOR).toBeGreaterThan(DENTALLY_HOURLY_LIMIT);

    // And that floor is generous to the cadence argument: the debtor fan-out in
    // listOutstanding and the per-instance SWR re-assembly are BOTH unbounded in
    // code, so no arithmetic over a schedule can close this. '40 * * * *' does not
    // close it; NO cadence does.
  });

  it("names the thing that DOES close it, and shows it closes under 3,600", () => {
    // One shared counter, nested ceilings. The platform's total spend in an hour is
    // bounded by the HIGHEST class's ceiling, because every class increments the same
    // counter and each is refused at its own line.
    const bg = dentallyCeiling("background");
    const inter = dentallyCeiling("interactive");
    const crit = dentallyCeiling("critical");
    expect(bg).toBe(2_160);
    expect(inter).toBe(3_240);
    expect(crit).toBe(3_420);

    // Strictly nested: background dies first, critical last.
    expect(bg).toBeLessThan(inter);
    expect(inter).toBeLessThan(crit);

    // THE CLOSING LINE. Total platform reads in any clock hour <= 3,420 < 3,600,
    // leaving a 180-request reserve for the unmetered writes, in-flight requests the
    // guard cannot see, and the practice's own Dentally logins.
    expect(crit).toBeLessThan(DENTALLY_HOURLY_LIMIT);
    expect(DENTALLY_HOURLY_LIMIT - crit).toBe(DENTALLY_HARD_RESERVE);
    expect(DENTALLY_HARD_RESERVE).toBe(180);

    // And the residual the stickiness cannot remove — one concurrent wave per scope
    // — is small enough that even a pathological hour of forty background scopes
    // each leaking a full wave of 10 stays under the interactive ceiling.
    expect(bg + 40 * 10).toBeLessThan(inter);
  });

  it("keeps every hour phase-locked to Dentally's, so the ceiling cannot be doubled", async () => {
    // A floating window against Dentally's fixed one is the classic fixed-window
    // burst: two of our windows overlapping one of theirs would let through twice
    // the ceiling in the hour that matters. The key carries the UTC hour, so it
    // cannot.
    const counter = sqlFaithfulCounter();
    __setDentallyBudgetForTests(counter);
    const keys = new Set<string>();
    __setDentallyBudgetForTests(async (_p, _l, key) => {
      keys.add(key);
      return true;
    });
    await consumeDentallyBudget("interactive", new Date("2026-08-20T13:00:00.000Z"));
    await consumeDentallyBudget("interactive", new Date("2026-08-20T13:59:59.999Z"));
    await consumeDentallyBudget("interactive", new Date("2026-08-20T14:00:00.000Z"));
    expect([...keys]).toEqual([
      "dentally:reads:2026-08-20T13",
      "dentally:reads:2026-08-20T14",
    ]);
  });
});
