import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DentallyBudgetExceededError, DentallyClient } from "./client";
import {
  DENTALLY_HOURLY_LIMIT,
  __setDentallyBudgetForTests,
  consumeDentallyBudget,
  dentallyCeiling,
  dentallyScopeRefused,
  runWithDentallyPriority,
  type BudgetConsumer,
} from "./budget";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTSTANDING_TTL_MS, READ_CACHE_TTL_MS } from "./read";

// ---------------------------------------------------------------------------
// THE DEFECT THIS FILE IS THE POST-MORTEM OF
//
// consume_rate_budget increments the shared counter on EVERY call, including the
// call it refuses — it has to, it is one atomic increment-and-check. So a refusal
// only stays free if the caller stops. Four of ours did not: each wraps its
// per-row Dentally read in a try/catch and treats any failure as "skip this row
// and carry on", which is exactly right for a transient 500 and exactly wrong for
// a budget refusal.
//
// The consequence was not a slow sweep. It was this: a background sweep, refused
// at its 2,160 ceiling, would walk the rest of its per-run cap — hundreds of
// patients, three sites — spending a REAL increment of the practice's shared
// hourly counter for every request it never sent. The counter would sail past
// 3,420 while actual Dentally consumption sat at 2,160, and the next patient to
// open the booking calendar would be refused by OUR OWN GUARD with 1,440 real
// Dentally requests still unspent. A platform with no guard at all would have
// served that patient. That is the specific case this file makes impossible.
//
// The fix is in budget.ts: a refusal is STICKY per execution scope, so the second
// and every later consume in a refused scope short-circuits without touching the
// store. The tests below are the deciding experiment, kept.
// ---------------------------------------------------------------------------

/**
 * The in-memory stand-in for api_budget + consume_rate_budget.
 *
 * ONE counter, shared by all three classes, incremented on EVERY call including a
 * refusal — that last part is the whole point, and is what the real SQL does.
 * `calls()` is therefore both "RPC round trips" and "increments against the
 * practice's hourly counter": the two are the same number by construction.
 */
function counterConsumer(): BudgetConsumer & { calls(): number } {
  let count = 0;
  const fn = (async (_priority: unknown, limit: number) => {
    count += 1;
    return count <= limit;
  }) as unknown as BudgetConsumer & { calls(): number };
  fn.calls = () => count;
  return fn;
}

/** A client whose reads always succeed, so nothing but the budget can stop a scan. */
function alwaysOkClient(onRequest: () => void): DentallyClient {
  return new DentallyClient({
    apiKey: "k",
    baseUrl: "https://example.invalid",
    readOnly: true,
    fetchImpl: (async () => {
      onRequest();
      return new Response(JSON.stringify({ patients: [], appointments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

/** The pool shape every one of the four sweeps uses. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i;
        i += 1;
        await fn(items[idx]);
      }
    }),
  );
}

/** Spend the shared hour down to `used` before the experiment starts. */
async function preSpend(used: number): Promise<void> {
  await runWithDentallyPriority("background", async () => {
    for (let i = 0; i < used; i += 1) await consumeDentallyBudget("background");
  });
}

afterEach(() => {
  __setDentallyBudgetForTests(null);
});

// ---------------------------------------------------------------------------

describe("a swallowing background sweep that is refused mid-scan", () => {
  const PATIENTS_IN_RUN = 400; // the coordinator's real per-run reach: 300 + 100 re-checks
  const POOL_CONCURRENCY = 10; // PLAN_CONCURRENCY / HISTORY_CONCURRENCY in the real sweeps

  /**
   * The sweep, reproduced at the shape that matters: a bounded-concurrency pool over
   * a per-run patient cap, each item doing a Dentally read inside a catch that
   * swallows everything and carries on. This is not a caricature — it is
   * fetchPlansForPatient (which catches and returns null) and the recall/
   * reactivation enrichment pools (which catch and leave the patient unset), with
   * the surrounding bookkeeping removed.
   */
  async function swallowingSweep(
    client: DentallyClient,
    opts: { stopWhenRefused: boolean },
  ): Promise<{ scanned: number; skipped: number }> {
    let scanned = 0;
    let skipped = 0;
    const ids = Array.from({ length: PATIENTS_IN_RUN }, (_, i) => `p${i}`);
    await mapWithConcurrency(ids, POOL_CONCURRENCY, async (id) => {
      if (opts.stopWhenRefused && dentallyScopeRefused()) {
        skipped += 1;
        return;
      }
      try {
        await client.getPatientAppointments(id, 1, 100);
        scanned += 1;
      } catch {
        skipped += 1; // the swallow: "this patient failed, try the next one"
      }
    });
    return { scanned, skipped };
  }

  it("cannot push the shared counter past its own ceiling, so the booking calendar survives", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);

    // Start the hour with the practice's background work almost exactly spent: the
    // sweep gets ten reads in and is refused, with the pool still holding 390
    // patients it has not looked at. This is the moment the defect fired.
    const ceiling = dentallyCeiling("background");
    await preSpend(ceiling - 10);

    let upstreamRequests = 0;
    const client = alwaysOkClient(() => {
      upstreamRequests += 1;
    });

    const result = await runWithDentallyPriority("background", () =>
      swallowingSweep(client, { stopWhenRefused: false }),
    );

    // The sweep did exactly what it always did: swallowed and kept walking.
    expect(result.scanned).toBe(10);
    expect(result.skipped).toBe(PATIENTS_IN_RUN - 10);

    // THE DECIDING NUMBER. Ten reads were served, then the refusal stuck. The 390
    // swallowed items cost NOTHING: no upstream request, and — the part that broke —
    // no increment of the practice's shared hourly counter.
    expect(upstreamRequests).toBe(10);

    // The residual is the pool's in-flight wave at the instant the first refusal
    // lands: those calls were already past the sticky check and each costs one
    // increment. It is bounded by CONCURRENCY, not by the 400 items behind them.
    expect(consumer.calls()).toBeGreaterThanOrEqual(ceiling);
    expect(consumer.calls()).toBeLessThanOrEqual(ceiling + POOL_CONCURRENCY);

    // Without the stickiness this read 2,560: one sweep's 390 swallowed patients on
    // top of the ceiling. One sweep is survivable. The hour is not — see the next
    // describe, which is the case that actually took the booking calendar down.
    expect(consumer.calls()).toBeLessThan(dentallyCeiling("interactive"));
    expect(consumer.calls()).toBeLessThan(dentallyCeiling("critical"));
  });

  it("still serves a patient's booking calendar afterwards, with real headroom left", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    await preSpend(dentallyCeiling("background") - 10);

    const client = alwaysOkClient(() => {});
    await runWithDentallyPriority("background", () =>
      swallowingSweep(client, { stopWhenRefused: false }),
    );

    // /api/booking/slots — a patient part-way through booking, the last thing in the
    // platform allowed to fail. It runs in its OWN scope, so the sweep's sticky
    // refusal is not inherited.
    const availability = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(availability.allowed, "a patient mid-booking was refused by our own guard").toBe(true);
    expect(availability.reason).toBe("within");

    // And not by a whisker: the hour still has more than a thousand real Dentally
    // requests left. This is the assertion that fails loudly if the phantom
    // increments ever come back — the sweep would have burnt this headroom without
    // sending a single request for it.
    const headroom = dentallyCeiling("critical") - consumer.calls();
    expect(headroom).toBeGreaterThan(1_000);
    expect(DENTALLY_HOURLY_LIMIT - consumer.calls()).toBeGreaterThan(1_000);
  });

  it("costs nothing more when the caller ALSO stops, which is why the callers stop too", async () => {
    // Stickiness alone bounds the damage to one concurrent wave. The callers
    // consulting dentallyScopeRefused() removes even that, and — more importantly —
    // is what turns "silently produced nothing" into "said so and stopped".
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const ceiling = dentallyCeiling("background");
    await preSpend(ceiling - 10);

    let upstreamRequests = 0;
    const client = alwaysOkClient(() => {
      upstreamRequests += 1;
    });
    const result = await runWithDentallyPriority("background", () =>
      swallowingSweep(client, { stopWhenRefused: true }),
    );

    expect(upstreamRequests).toBe(10);
    expect(result.skipped).toBe(PATIENTS_IN_RUN - 10);
    expect(consumer.calls()).toBeLessThanOrEqual(ceiling + POOL_CONCURRENCY);
  });
});

describe("THE HOUR THAT BROKE IT, replayed end to end", () => {
  // The deciding experiment, at the scale it actually happens. One clock hour with
  // every background consumer running, each one a swallowing fan-out:
  //
  //   :05 reactivation   3 sites x 300 patients, concurrency 8
  //   :10 recall         3 sites x 300 patients, concurrency 8
  //   :15 no-show        3 sites x (8 consent pages + 300 histories), concurrency 10
  //   :20 coordinator    3 sites x 400 patients (300 + 100 re-checks), concurrency 10
  //   :xx drain          200 queued rows, one recipient lookup each, serial
  //
  // Real consumption is capped at the background ceiling, 2,160, because that is
  // where the guard stops sending. The question this test answers is what the
  // COUNTER says, because the counter is what the booking calendar is measured
  // against — and before the fix the two numbers were not the same number.

  interface Sweep {
    name: string;
    sites: number;
    itemsPerSite: number;
    concurrency: number;
  }

  const HOUR: Sweep[] = [
    { name: "sync-reactivation", sites: 3, itemsPerSite: 300, concurrency: 8 },
    { name: "sync-recall", sites: 3, itemsPerSite: 300, concurrency: 8 },
    { name: "sync-noshow", sites: 3, itemsPerSite: 308, concurrency: 10 },
    { name: "sync-coordinator", sites: 3, itemsPerSite: 400, concurrency: 10 },
    { name: "messaging-drain", sites: 1, itemsPerSite: 200, concurrency: 1 },
  ];

  /** Total items the hour walks if nothing stops early. */
  const HOUR_ITEMS = HOUR.reduce((n, s) => n + s.sites * s.itemsPerSite, 0);

  /** Returns how many items the hour actually ATTEMPTED a Dentally read for. */
  async function runHour(
    client: DentallyClient,
    opts: { callersStop: boolean },
  ): Promise<number> {
    let attempted = 0;
    for (const sweep of HOUR) {
      // Each cron tick is its own scope — its own fresh entitlement to ask, which is
      // why a later tick still pays ONE real refusal (and its first concurrent wave)
      // before its own scope sticks. A tick must be able to find out for itself
      // whether the hour has turned over; caching a refusal across ticks would mean
      // a sweep refused at 13:59 stayed refused at 14:01 for no reason.
      await runWithDentallyPriority("background", async () => {
        for (let site = 0; site < sweep.sites; site += 1) {
          if (opts.callersStop && dentallyScopeRefused()) break; // the site-boundary stop
          const ids = Array.from({ length: sweep.itemsPerSite }, (_, i) => `${sweep.name}:${site}:${i}`);
          await mapWithConcurrency(ids, sweep.concurrency, async (id) => {
            if (opts.callersStop && dentallyScopeRefused()) return;
            attempted += 1;
            try {
              await client.getPatientAppointments(id, 1, 100);
            } catch {
              // THE SWALLOW. Every one of these five callers does exactly this.
            }
          });
        }
      });
    }
    return attempted;
  }

  it("leaves the booking calendar served, with the unspent Dentally headroom intact", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);

    let upstreamRequests = 0;
    const client = alwaysOkClient(() => {
      upstreamRequests += 1;
    });

    // Stickiness ALONE, with the callers left exactly as they were: still swallowing,
    // still walking every item. This isolates what budget.ts fixes by itself.
    const attempted = await runHour(client, { callersStop: false });
    expect(attempted).toBe(HOUR_ITEMS);

    // 1. REAL CONSUMPTION. This is what Dentally's own counter saw. The guard did its
    //    job: background stopped dead on its ceiling.
    expect(upstreamRequests).toBe(dentallyCeiling("background"));

    // 2. THE PATIENT. /api/booking/slots, mid-booking, after the whole hour of sweeps.
    //    Asserted FIRST because it is the only thing the incident was ever about: the
    //    counter numbers below are why, this is what.
    const availability = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(
      availability.allowed,
      "a patient mid-booking was refused by our own guard while real Dentally " +
        "headroom was still unspent — the exact failure the sticky refusal exists to stop",
    ).toBe(true);

    // 3. THE PLATFORM'S COUNTER. Before the stickiness this reached every item the
    //    hour walked — each swallowed one a phantom increment — while real
    //    consumption sat at 2,160. It must now track reality, within one in-flight
    //    wave per sweep.
    const waves = HOUR.reduce((n, s) => n + s.concurrency, 0);
    expect(consumer.calls()).toBeLessThanOrEqual(dentallyCeiling("background") + waves);
    expect(HOUR_ITEMS).toBeGreaterThan(dentallyCeiling("critical")); // the size of the lie

    // 4. AND THE HEADROOM IS REAL, not a rounding win: over a thousand requests the
    //    practice can still make this hour, on top of everything the sweeps spent.
    expect(DENTALLY_HOURLY_LIMIT - upstreamRequests).toBeGreaterThan(1_400);
    expect(dentallyCeiling("critical") - consumer.calls()).toBeGreaterThan(1_200);
  });

  it("stops walking thousands of no-op patients once the callers ask as well", async () => {
    // What the caller changes add on top of the stickiness. The counter was already
    // safe; this is about the OTHER cost — an hour of function time spent producing
    // nothing, and a run that reports success over a coverage gap it never mentions.
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    const client = alwaysOkClient(() => {});

    const attempted = await runHour(client, { callersStop: true });

    // From every item in the hour down to the ones that were actually served, plus
    // the in-flight wave of whichever sweep was mid-pool when the ceiling arrived and
    // one wave for each later tick asking for itself.
    expect(attempted).toBeLessThan(dentallyCeiling("background") + 100);
    expect(HOUR_ITEMS - attempted).toBeGreaterThan(1_900); // the no-op walk, removed

    const waves = HOUR.reduce((n, s) => n + s.concurrency, 0);
    expect(consumer.calls()).toBeLessThanOrEqual(dentallyCeiling("background") + waves);

    const availability = await runWithDentallyPriority("critical", () =>
      consumeDentallyBudget("critical"),
    );
    expect(availability.allowed).toBe(true);
  });
});

describe("the stickiness itself", () => {
  it("answers a refused scope WITHOUT calling the store at all", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    await preSpend(dentallyCeiling("background"));

    await runWithDentallyPriority("background", async () => {
      const first = await consumeDentallyBudget("background");
      expect(first.allowed).toBe(false);
      expect(first.reason).toBe("over"); // a real answer from the store
      const callsAfterFirst = consumer.calls();

      for (let i = 0; i < 500; i += 1) {
        const d = await consumeDentallyBudget("background");
        expect(d.allowed).toBe(false);
        expect(d.reason).toBe("scope-refused"); // answered locally, store untouched
      }
      expect(consumer.calls()).toBe(callsAfterFirst);
    });
  });

  it("is sticky per SCOPE, so a refused sweep does not refuse the next one", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);

    // Sweep A exhausts the background ceiling and is refused.
    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i <= dentallyCeiling("background"); i += 1) {
        await consumeDentallyBudget("background");
      }
      expect(dentallyScopeRefused()).toBe(true);
    });

    // Sweep B, the next tick, gets a FRESH scope: it is entitled to ask for itself,
    // and here it is still refused for the real reason (the hour is spent) rather
    // than by inheriting A's flag. Nothing is cached across runs.
    await runWithDentallyPriority("background", async () => {
      expect(dentallyScopeRefused()).toBe(false);
      const d = await consumeDentallyBudget("background");
      expect(d.reason).toBe("over");
    });
  });

  it("does not leak between classes: critical spends while background sits refused", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    await preSpend(dentallyCeiling("background"));

    await runWithDentallyPriority("background", async () => {
      expect((await consumeDentallyBudget("background")).allowed).toBe(false);
      expect(dentallyScopeRefused()).toBe(true);

      // A critical read NESTED inside the refused sweep — the shape of a sweep that
      // has to confirm a write, or an agent call made from a background job. Its own
      // scope, its own ceiling, its own answer.
      const nested = await runWithDentallyPriority("critical", () =>
        consumeDentallyBudget("critical"),
      );
      expect(nested.allowed).toBe(true);
      expect(nested.reason).toBe("within");
    });

    // And an interactive scope started afterwards is untouched by any of it.
    const dashboard = await runWithDentallyPriority("interactive", () =>
      consumeDentallyBudget("interactive"),
    );
    expect(dashboard.allowed).toBe(true);
  });

  it("does not refuse a client whose explicit class differs from the scope's", async () => {
    // client.ts lets a client be built with an explicit opts.priority. Such a read is
    // a different class from the scope it happens to run inside, with a different
    // ceiling and its own headroom — inheriting the scope's refusal would refuse it
    // wrongly, and it is the booking/agent paths that would be refused.
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    await preSpend(dentallyCeiling("background"));

    await runWithDentallyPriority("background", async () => {
      expect((await consumeDentallyBudget("background")).allowed).toBe(false);
      const critical = await consumeDentallyBudget("critical");
      expect(critical.allowed).toBe(true);
      expect(critical.reason).toBe("within");
    });
  });

  it("sticks on a DOWN budget store too, instead of hammering it once per row", async () => {
    // Background fails CLOSED when the store cannot answer. Without stickiness that
    // verdict is re-litigated once per swallowed row: hundreds of RPCs at an already
    // unreachable Supabase, to be told the same thing every time.
    let calls = 0;
    __setDentallyBudgetForTests(async () => {
      calls += 1;
      throw new Error("supabase unavailable");
    });

    await runWithDentallyPriority("background", async () => {
      const first = await consumeDentallyBudget("background");
      expect(first.allowed).toBe(false);
      expect(first.reason).toBe("store-unavailable");
      for (let i = 0; i < 200; i += 1) {
        expect((await consumeDentallyBudget("background")).reason).toBe("scope-refused");
      }
    });
    expect(calls).toBe(1);

    // Interactive still fails OPEN, and does so every time: the asymmetry is not
    // touched by any of this.
    for (let i = 0; i < 3; i += 1) {
      expect((await consumeDentallyBudget("interactive")).allowed).toBe(true);
    }
  });

  it("has no scope to stick to outside a declared one, and stays silent about it", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    expect(dentallyScopeRefused()).toBe(false);
    // An unscoped read is a one-off; there is no run for a refusal to belong to, and
    // the default class is interactive, which is served to 90%.
    expect((await consumeDentallyBudget("interactive")).allowed).toBe(true);
  });
});

describe("the client honours a sticky refusal without sending anything", () => {
  it("throws DentallyBudgetExceededError and makes no upstream request", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);
    await preSpend(dentallyCeiling("background"));

    let upstreamRequests = 0;
    const client = alwaysOkClient(() => {
      upstreamRequests += 1;
    });

    await runWithDentallyPriority("background", async () => {
      for (let i = 0; i < 50; i += 1) {
        await expect(client.listPatients({ siteId: "s", page: i + 1, perPage: 100 })).rejects.toBeInstanceOf(
          DentallyBudgetExceededError,
        );
      }
    });

    expect(upstreamRequests).toBe(0);
    expect(consumer.calls()).toBe(dentallyCeiling("background") + 1); // the one real refusal
  });
});

// ---------------------------------------------------------------------------

describe("the swallowing callers consult the refusal", () => {
  // Stickiness makes a swallowing loop HARMLESS; it does not make it honest. A sweep
  // that walks 400 no-op patients still reports a green run over a coverage gap it
  // never mentions. These are the loops that swallow a Dentally read and therefore
  // have to ask, so the log and the response body say what happened.
  const CALLERS = [
    "src/app/api/sync/noshow/route.ts",
    "src/app/api/sync/recall/route.ts",
    "src/app/api/sync/reactivation/route.ts",
    "src/app/api/sync/coordinator/route.ts",
    "src/app/api/sync/patient-count/route.ts",
    "src/app/api/messaging/drain/route.ts",
    // The longest swallowing loop in the platform: getPatientById returns null on
    // every error and `misses` is unbounded, so a refusal here silently drops
    // debtors out of the practice's outstanding total.
    "src/lib/dentally/read.ts",
  ];

  for (const path of CALLERS) {
    it(`${path} stops its scan when the shared budget refuses it`, () => {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(
        source.includes("dentallyScopeRefused("),
        `${path} swallows Dentally read failures in a loop. It must ask ` +
          "dentallyScopeRefused() and stop, or a budget refusal is indistinguishable " +
          "from a quiet run with full coverage.",
      ).toBe(true);
    });
  }

  it("reports the refusal in the response body, not only in the log", () => {
    // cron.job_run_details records the body. A refusal that only reaches console
    // reaches nobody: the operator looking at why the sweep did nothing is looking
    // at the JSON.
    for (const path of CALLERS.filter((p) => p.startsWith("src/app/api/"))) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source, `${path} must report budgetRefused in its response body`).toContain(
        "budgetRefused",
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * THE EXPIRY TREADMILL, PINNED ON BOTH EXPENSIVE READS.
 *
 * The outage this whole guard exists to prevent had two causes, and the second
 * was subtler than the cron: a reader's own refresh re-stamped the shared row
 * with the READER's TTL. At sixty seconds that row expired every minute, so
 * every cold instance re-paged the practice's whole book - sixty assemblies an
 * hour, which IS the ceiling. The dashboard was fixed by raising its constant;
 * outstanding (the second most expensive read, an invoice index plus a direct
 * read per unreached debtor) was left on the 60s default and re-stamped itself
 * back down for forty-five minutes of every hour once the cron moved hourly.
 *
 * So the property is not "fifteen minutes" - it is that the warmer and the
 * reader of a given read agree, because a warmer stamping longer than its
 * reader is the treadmill by construction. Asserted per read, so raising one
 * constant without the other cannot pass. */
describe("the warmer and the reader agree on how long an answer is good for", () => {
  it("keeps both expensive reads off the sixty-second treadmill", () => {
    expect(OUTSTANDING_TTL_MS).toBeGreaterThan(READ_CACHE_TTL_MS);
    // dashboard/read.ts is server-only, so it cannot be imported here; its
    // constant is asserted from source rather than skipped.
    const dashboard = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "read.ts"),
      "utf8",
    );
    const declared = dashboard.match(/export const DASHBOARD_TTL_MS = ([^;]+);/);
    expect(declared, "DASHBOARD_TTL_MS is no longer declared where this pin looks").not.toBeNull();
    expect(declared![1]).not.toContain("60_000\n");
    expect(eval(declared![1]) as number).toBeGreaterThan(READ_CACHE_TTL_MS);
  });

  it("stamps outstanding from the outstanding constant, not the dashboard's", () => {
    const prewarm = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "api", "dentally", "prewarm", "route.ts"),
      "utf8",
    );
    // The two constants are equal today. This pins the DERIVATION, which is the
    // thing that survives one of them changing.
    expect(prewarm).toContain("prewarmOutstanding(siteIds, OUTSTANDING_TTL_MS)");
  });
});
