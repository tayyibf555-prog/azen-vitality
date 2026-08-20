import { describe, it, expect, afterEach } from "vitest";
import { DentallyBudgetExceededError, DentallyClient } from "./client";
import {
  __setDentallyBudgetForTests,
  dentallyCeiling,
  runWithDentallyPriority,
  type BudgetConsumer,
  type DentallyPriority,
} from "./budget";

// Faithful in-memory replica of consume_rate_budget (migration 0023):
// INSERT ... ON CONFLICT DO UPDATE count = count + 1 RETURNING count <= p_limit.
// THE INCREMENT IS UNCONDITIONAL: a refused call still takes a token.
function pgConsumer(): BudgetConsumer & { total(): number } {
  let count = 0;
  const fn = (async (_p: DentallyPriority, limit: number) => {
    count += 1;                 // unconditional, exactly as the SQL does it
    return count <= limit;
  }) as unknown as BudgetConsumer & { total(): number };
  fn.total = () => count;
  return fn;
}

function client(onRequest: () => void): DentallyClient {
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

// mapWithConcurrency, copied byte-for-byte in shape from
// src/app/api/sync/noshow/route.ts (recall/reactivation/coordinator use the same).
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (i: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i; i += 1; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

afterEach(() => { __setDentallyBudgetForTests(null); });

// ---------------------------------------------------------------------------
// THIS FILE WAS WRITTEN TO PROVE A DEFECT, AND IT DID.
//
// Its scenario is unchanged — the same faithful consume_rate_budget replica, the
// same mapWithConcurrency copied in shape from the sweeps, the same 2,700 swallowed
// patients across three sweeps and three sites. Only the ASSERTIONS have flipped,
// because the defect is closed: a refusal is now STICKY per execution scope
// (src/lib/dentally/budget.ts), so a swallowing loop cannot drive the shared counter
// for requests it never sends.
//
// It is kept in the adversary's own construction rather than rewritten into
// something tidier, because a regression test is only worth what the person who
// built it was trying to break.
// ---------------------------------------------------------------------------

const SWEEPS = ["recall", "reactivation", "coordinator"];
const SITES = ["ng", "n15", "rv"];
const POOL_CONCURRENCY = 8;

describe("ADVERSARIAL: the real sweep loop shape vs the shared counter", () => {
  it("no longer burns the interactive or critical headroom on refusals that never leave the building", async () => {
    const consumer = pgConsumer();
    __setDentallyBudgetForTests(consumer);
    let upstream = 0;
    const c = client(() => { upstream += 1; });

    // Pre-spend the background ceiling the way a prewarm/consent-map walk does.
    await runWithDentallyPriority("background", async () => {
      for (let p = 1; p <= dentallyCeiling("background"); p += 1) {
        try { await c.listPatients({ siteId: "s", page: p, perPage: 100 }); } catch { break; }
      }
    });
    expect(upstream).toBe(dentallyCeiling("background"));   // 2160 real requests

    // NOW the hourly sweeps run. recall/reactivation/coordinator/noshow each loop
    // 300 patients PER SITE with a per-item try/catch that SWALLOWS the error and
    // keeps going (src/app/api/sync/recall/route.ts step 2, noshow step 2,
    // coordinator step 3). Three sites, three sweeps = 2700 refused attempts.
    for (const sweep of SWEEPS) {
      for (const site of SITES) {
        const patients = Array.from({ length: 300 }, (_, i) => `${sweep}-${site}-${i}`);
        await runWithDentallyPriority("background", () =>
          mapWithConcurrency(patients, POOL_CONCURRENCY, async (pid) => {
            try { await c.getPatientAppointments(pid, 1, 100); } catch { /* swallowed, loop continues */ }
          }),
        );
      }
    }

    // Not one extra Dentally request was made...
    expect(upstream).toBe(dentallyCeiling("background"));

    // ...and the counter no longer moves for them either. Each of the nine
    // sweep-scopes is a fresh cron tick entitled to ask once for itself, and its
    // first concurrent wave asks together before the flag is set — so the residual
    // is nine waves of eight, NOT 2,700. That is the whole difference between a
    // counter that tracks reality and one that invents a shortage.
    const residual = SWEEPS.length * SITES.length * POOL_CONCURRENCY;
    expect(consumer.total()).toBeLessThanOrEqual(dentallyCeiling("background") + residual);
    expect(consumer.total()).toBeLessThan(dentallyCeiling("interactive"));
    expect(consumer.total()).toBeLessThan(dentallyCeiling("critical"));

    // THE CONSEQUENCE THAT MATTERED: a patient mid-booking. This used to be refused
    // by our own guard with ~1,400 of the practice's real Dentally requests unspent —
    // a case where having NO guard at all would have served them. It is served now.
    await expect(
      runWithDentallyPriority("critical", () => c.listPatients({ siteId: "s", page: 1, perPage: 100 })),
    ).resolves.toBeTruthy();
    expect(upstream).toBe(dentallyCeiling("background") + 1); // the patient's read really went out

    // And a background scope still IS refused: the fix does not hand the quota back
    // to the sweeps, it stops them lying about how much they took.
    await expect(
      runWithDentallyPriority("background", () => c.listPatients({ siteId: "s", page: 1, perPage: 100 })),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    process.stderr.write(
      `\n[adversarial] real upstream requests=${upstream}, counter=${consumer.total()}, ` +
      `critical ceiling=${dentallyCeiling("critical")}, unspent real quota=${3600 - upstream}\n`,
    );
  }, 120_000);
});
