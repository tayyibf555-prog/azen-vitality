import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DentallyBudgetExceededError, DentallyClient } from "./client";
import {
  __setDentallyBudgetForTests,
  dentallyCeiling,
  runWithDentallyPriority,
  type BudgetConsumer,
  type DentallyPriority,
} from "./budget";

// ---------------------------------------------------------------------------
// THE INCIDENT, REPLAYED THROUGH THE REAL CLIENT.
//
// On 2026-08-20 a pre-warm cron paging three sites x six 90-day scans, four times
// an hour, spent the practice's entire 3,600/hour Dentally quota. Every read from
// production answered 403 "Rate limit exceeded" for the working day: staff could
// not look a patient up, and the public booking calendar was dead, because a cache
// warmer had eaten the budget.
//
// This file drives a real DentallyClient with a real bulk page-scan against a
// counting budget and proves the shape of the fix: the scan is CUT OFF, and the
// screen and the booking calendar keep working on the budget it was refused.
// ---------------------------------------------------------------------------

/** In-memory stand-in for api_budget + consume_rate_budget: one counter per key. */
function counterConsumer(): BudgetConsumer & { total(): number } {
  let count = 0;
  const fn = (async (_priority: DentallyPriority, limit: number) => {
    count += 1;
    return count <= limit;
  }) as unknown as BudgetConsumer & { total(): number };
  fn.total = () => count;
  return fn;
}

/** A client whose every read succeeds with a FULL page, so a page walk never stops itself. */
function pagingClient(onRequest?: () => void): DentallyClient {
  const fullPage = { patients: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` })) };
  return new DentallyClient({
    apiKey: "k",
    baseUrl: "https://example.invalid",
    readOnly: true,
    fetchImpl: (async () => {
      onRequest?.();
      return new Response(JSON.stringify(fullPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

/** Page until the client refuses, exactly as the real scans do: abort, never retry. */
async function scanUntilRefused(client: DentallyClient, maxPages: number): Promise<number> {
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      await client.listPatients({ siteId: "site", page, perPage: 100 });
      pages += 1;
    } catch (err) {
      expect(err).toBeInstanceOf(DentallyBudgetExceededError);
      return pages;
    }
  }
  return pages;
}

afterEach(() => {
  __setDentallyBudgetForTests(null);
});

describe("a bulk background scan against the shared budget", () => {
  it("is cut off at the background ceiling, and the practice can still be read", async () => {
    const consumer = counterConsumer();
    __setDentallyBudgetForTests(consumer);

    let upstreamRequests = 0;
    const client = pagingClient(() => {
      upstreamRequests += 1;
    });

    // The pre-warm / sweep: an unbounded-looking page walk, in the background class.
    const pagesRead = await runWithDentallyPriority("background", () =>
      scanUntilRefused(client, 10_000),
    );

    // It stopped at 60% of the hour, not at 100% of it.
    expect(pagesRead).toBe(dentallyCeiling("background"));
    expect(upstreamRequests).toBe(dentallyCeiling("background"));
    // A REFUSAL COSTS NOTHING UPSTREAM. The guard sits in front of fetch, so the
    // refused page never left the building — which is the only reason refusing helps.
    expect(upstreamRequests).toBeLessThan(consumer.total());

    // AND THIS IS THE WHOLE POINT. With the scan cut off, a practice manager's read
    // and a patient's booking calendar are both still served from the same budget.
    await expect(
      runWithDentallyPriority("interactive", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).resolves.toBeTruthy();
    await expect(
      runWithDentallyPriority("critical", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).resolves.toBeTruthy();
  });

  it("keeps the booking calendar alive after even the interactive class is spent", async () => {
    __setDentallyBudgetForTests(counterConsumer());
    const client = pagingClient();

    // Burn the hour with interactive reads (a fleet of cold instances re-paging).
    await runWithDentallyPriority("interactive", () => scanUntilRefused(client, 10_000));

    await expect(
      runWithDentallyPriority("interactive", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    // A patient part-way through booking is the last thing to lose.
    await expect(
      runWithDentallyPriority("critical", () =>
        client.getAvailability({ practitionerIds: ["1"], startTime: "x", finishTime: "y" }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe("the asymmetry, through the client", () => {
  const exploding: BudgetConsumer = async () => {
    throw new Error("budget store unavailable");
  };

  it("blocks a background bulk scan when the budget store is unreadable", async () => {
    __setDentallyBudgetForTests(exploding);
    let upstreamRequests = 0;
    const client = pagingClient(() => {
      upstreamRequests += 1;
    });
    await expect(
      runWithDentallyPriority("background", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);
    expect(upstreamRequests).toBe(0);
  });

  it("lets a person's read through when the budget store is unreadable", async () => {
    __setDentallyBudgetForTests(exploding);
    let upstreamRequests = 0;
    const client = pagingClient(() => {
      upstreamRequests += 1;
    });
    await expect(
      runWithDentallyPriority("interactive", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).resolves.toBeTruthy();
    expect(upstreamRequests).toBe(1);
  });
});

describe("how a read is classified", () => {
  it("takes the class from the SCOPE it runs in, not from where the client was built", async () => {
    // dentallyFromEnv() builds ONE kind of client and hands it to a practice
    // manager's dashboard AND to the hourly recall sync. Freezing the class at
    // construction would classify one of them wrongly, every time.
    __setDentallyBudgetForTests(counterConsumer());
    const client = pagingClient();
    await runWithDentallyPriority("background", () => scanUntilRefused(client, 10_000));
    await expect(
      runWithDentallyPriority("background", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);
    // The SAME client instance, in a different scope, is still served.
    await expect(
      runWithDentallyPriority("interactive", () =>
        client.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).resolves.toBeTruthy();
  });

  it("lets an explicit priority on the client override the ambient scope", async () => {
    __setDentallyBudgetForTests(counterConsumer());
    const pinned = new DentallyClient({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      readOnly: true,
      priority: "background",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ patients: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const burner = pagingClient();
    await runWithDentallyPriority("background", () => scanUntilRefused(burner, 10_000));
    // Even inside an interactive scope, a client pinned to background is refused.
    await expect(
      runWithDentallyPriority("interactive", () =>
        pinned.listPatients({ siteId: "site", page: 1, perPage: 100 }),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);
  });
});

describe("a refusal must abort, never retry", () => {
  it("is honoured by the one read in the platform that retries", () => {
    // The payment-allocation report retries a failed invoice read exactly once,
    // because ~0.4% of live invoice GETs blip. A budget refusal is not a blip, and
    // retrying it takes a second token from the shared counter for a request that
    // never left the building. Over a 235-invoice report that is more phantom spend
    // than the entire hard reserve.
    const source = readFileSync(
      join(process.cwd(), "src/lib/reports/allocation-read.ts"),
      "utf8",
    );
    expect(source).toContain("err instanceof DentallyBudgetExceededError");
  });
});
