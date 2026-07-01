// FIXA (drain bounds): every module outbox the shared drain iterates must cap
// its listQueuedOutbox batch at 100 rows, oldest first. Without the cap, a
// large backlog (e.g. after a provider outage) is listed in full and a single
// drain run can be killed by maxDuration mid-way; with it, each 5-minute tick
// sends at most 100 per module and the next tick picks up the rest.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable fake for the supabase query builder. Records every call; awaiting
// it (the builder is thenable, like the real PostgrestFilterBuilder) resolves
// to an empty, error-free result.
const fake = vi.hoisted(() => {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "in", "eq", "order", "limit"]) {
    builder[m] = vi.fn((...args: unknown[]) => {
      (calls[m] ??= []).push(args);
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { calls, builder };
});

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => fake.builder,
  anonServerClient: () => fake.builder,
}));

import { listQueuedOutbox as listReactivation } from "@/lib/reactivation/repository";
import { listQueuedOutbox as listRecall } from "@/lib/recall/repository";
import { listQueuedOutbox as listNoshow } from "@/lib/noshow/repository";
import { listQueuedOutbox as listCoordinator } from "@/lib/coordinator/repository";
import { listQueuedOutbox as listReviews } from "@/lib/reviews/repository";

const REPOS = [
  { name: "reactivation", table: "reactivation_outbox", list: listReactivation },
  { name: "recall", table: "recall_outbox", list: listRecall },
  { name: "noshow", table: "noshow_outbox", list: listNoshow },
  { name: "coordinator", table: "outbox", list: listCoordinator },
  { name: "reviews", table: "review_outbox", list: listReviews },
] as const;

beforeEach(() => {
  for (const key of Object.keys(fake.calls)) delete fake.calls[key];
});

describe("listQueuedOutbox batch cap (all five drained outboxes)", () => {
  for (const repo of REPOS) {
    it(`${repo.name}: queries ${repo.table} oldest-first with a batch cap of 100`, async () => {
      await repo.list(["site-1"]);
      expect(fake.calls.from).toEqual([[repo.table]]);
      expect(fake.calls.eq).toEqual([["status", "queued"]]);
      // Oldest-first ordering is preserved...
      expect(fake.calls.order).toEqual([["created_at", { ascending: true }]]);
      // ...and the batch is bounded so a backlog cannot outlast maxDuration.
      expect(fake.calls.limit).toEqual([[100]]);
    });
  }
});
