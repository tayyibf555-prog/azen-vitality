import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// ===========================================================================
// ensureBranch: A BRANCH NAME IS A VALUE, NEVER A PATTERN (ruling W3/12).
//
// There was no test file for this repository at all, which is why the defect
// below survived a whole review round. Every suite that touches this module
// mocks it — all five `route.*.test.ts` files under
// src/app/api/practice-brain/[action]/ replace `@/lib/practice-brain/repository`
// wholesale, `ensureBranch` included, so the real function had never once been
// run against a database.
//
// WHAT IT USED TO DO. `ensureBranch(clientId, name, tier)` ended in
// `.ilike("title", trimmed).limit(1)`, and `trimmed` is untrusted text: it
// arrives as `result.branch` straight off the `create` request body, as the
// classifier's own model output on `learn`, and as `body.branch` on
// `resolve-review`. `plainLabel` (the route's write-side normaliser) strips
// control characters and caps the length — it does not strip `%` or `_`, and it
// should not, because those are ordinary characters in a name someone types.
//
// As a LIKE pattern they are not ordinary, and the damage is in TWO steps, which
// is why the tier assertions below matter as much as the id ones:
//
//   1. the note is filed under a branch nobody named, and
//   2. `ensureBranch` then LOWERS that unrelated branch's tier to this item's
//      tier, because a branch's tier is meant to be the minimum of its
//      children — a visibility change in the tree UI to a branch the author
//      never touched.
//
// (`visibleNodes` still filters per node by clearance, so this is mis-filing
// rather than disclosure. Mis-filing the practice's own knowledge is what this
// function exists to prevent.)
//
// WHY THE FIX IS NOT AN ESCAPE. `%` and `_` can be backslash-escaped; `*` cannot,
// because PostgREST rewrites `*` to `%` inside a like/ilike pattern before
// Postgres sees it, and `\*` therefore arrives as `\%` — an escaped per-cent
// sign, matching the wrong literal. So the pattern goes and the match happens in
// memory, the same way `serialKey` does it in src/lib/equipment/repository.ts.
//
// The last two tests hold the half that is easy to lose while fixing the first
// half: `ilike` was there for a REASON (case-insensitive re-use of a branch), and
// a match on values has to keep doing that, per client, deterministically.
// ===========================================================================

const fake = createFakeSupabase();

// ---------------------------------------------------------------------------
// A DATABASE WHERE ONLY THE READ CAN FAIL.
//
// `fake.failTable` fails every query on a table, which cannot separate the two
// halves of a fail direction: with the insert failing too, `ensureBranch` throws
// whether or not it checked the read's error, and the test would pass against
// code that had never looked. So the branch READ is failed on its own, leaving
// the insert working — which is exactly the outage that used to end in a
// duplicate branch, silently, with the caller told nothing.
//
// The `select` seam is the whole trick: the branch read starts with `.select()`
// on a fresh builder, while the create is `.insert(...).select("id")` and so
// never reaches this override.
// ---------------------------------------------------------------------------
let failBranchRead = false;

const READ_FAILURE = "branch read failed";

/** A select chain that errors at the end of it, however long the chain is. */
function failingSelect(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  // `like`/`ilike` are listed even though the fixed code calls neither: a
  // mutation that puts the pattern back should fail on the ASSERTION, not on a
  // TypeError from a chain method this stand-in forgot to offer.
  for (const method of [
    "select", "eq", "neq", "is", "in", "not", "like", "ilike", "order", "limit", "range",
  ]) {
    chain[method] = () => chain;
  }
  chain.then = (onOk: (r: unknown) => unknown) =>
    Promise.resolve(onOk({ data: null, error: { message: READ_FAILURE }, count: null }));
  return chain;
}

const client = {
  from(table: string) {
    const q = fake.client.from(table);
    if (table !== TABLE || !failBranchRead) return q;
    return new Proxy(q, {
      get(target, prop, receiver) {
        if (prop === "select") return () => failingSelect();
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => client }));

const { ensureBranch } = await import("./repository");

const CLIENT = "vitality";
const OTHER_CLIENT = "some-other-practice";
const TABLE = "knowledge_node";

/** A fixed instant, so row order never depends on when the suite runs. */
const T0 = Date.parse("2026-01-01T09:00:00.000Z");
function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function seedBranch(opts: {
  id: string;
  title: string;
  tier: number;
  clientId?: string;
  createdAt?: string;
}): void {
  fake.seed(TABLE, {
    id: opts.id,
    client_id: opts.clientId ?? CLIENT,
    parent_id: null,
    kind: "branch",
    title: opts.title,
    tier: opts.tier,
    source: "manual_note",
    status: "active",
    created_by: "seed",
    created_at: opts.createdAt ?? iso(0),
  });
}

function branchRows(): Array<{ id: string; title: string; tier: number; client_id: string }> {
  return fake.rows(TABLE) as unknown as Array<{
    id: string;
    title: string;
    tier: number;
    client_id: string;
  }>;
}

beforeEach(() => {
  fake.reset();
  failBranchRead = false;
});

describe("ensureBranch never treats a branch name as a LIKE pattern (W3/12)", () => {
  it('a branch name of "%" creates its own branch instead of adopting the first one', async () => {
    seedBranch({ id: "b-fees", title: "Fees", tier: 2 });

    const id = await ensureBranch(CLIENT, "%", 4);

    expect(id).not.toBe("b-fees");
    const fees = branchRows().find((r) => r.id === "b-fees");
    expect(fees?.tier).toBe(2); // the unrelated branch was not re-tiered
    expect(branchRows().some((r) => r.title === "%" && r.id === id)).toBe(true);
  });

  it('a branch name of "%" does not lower an existing branch\'s tier', async () => {
    // The second half of the damage, on its own: a tier-3 branch (visible to
    // fewer logins) dragged down to tier 1 (General — every login in the
    // practice) by an item that was never filed there.
    seedBranch({ id: "b-clinical", title: "Clinical protocols", tier: 3 });

    await ensureBranch(CLIENT, "%", 1);

    expect(branchRows().find((r) => r.id === "b-clinical")?.tier).toBe(3);
  });

  it("an underscore in a branch name matches only that name", async () => {
    // `_` is LIKE's single-character wildcard, so "Fee_" used to match "Fees".
    seedBranch({ id: "b-fees", title: "Fees", tier: 2 });

    const id = await ensureBranch(CLIENT, "Fee_", 4);

    expect(id).not.toBe("b-fees");
    expect(branchRows().find((r) => r.id === "b-fees")?.tier).toBe(2);
    expect(branchRows().some((r) => r.title === "Fee_")).toBe(true);
  });

  it("a failed branch read throws rather than inventing a duplicate branch", async () => {
    // The insert still works here (see `failingSelect`), so an unchecked read
    // error would return happily, having written a second "Fees" branch that
    // nobody asked for and nobody was told about.
    seedBranch({ id: "b-fees", title: "Fees", tier: 2 });
    failBranchRead = true;

    await expect(ensureBranch(CLIENT, "Fees", 2)).rejects.toThrow(READ_FAILURE);

    failBranchRead = false;
    expect(branchRows().filter((r) => r.title === "Fees")).toHaveLength(1);
  });
});

describe("ensureBranch still re-uses a branch by name, case-insensitively", () => {
  it("the same name in a different case and with stray spaces is the same branch", async () => {
    seedBranch({ id: "b-fees", title: "Fees", tier: 3 });

    const id = await ensureBranch(CLIENT, "  fees  ", 3);

    expect(id).toBe("b-fees");
    expect(branchRows()).toHaveLength(1); // nothing was created
  });

  it("a more accessible item lowers the matched branch's tier", async () => {
    seedBranch({ id: "b-fees", title: "Fees", tier: 3 });

    const id = await ensureBranch(CLIENT, "FEES", 1);

    expect(id).toBe("b-fees");
    expect(branchRows().find((r) => r.id === "b-fees")?.tier).toBe(1);
  });

  it("a branch belonging to another practice is never adopted", async () => {
    seedBranch({ id: "b-theirs", title: "Fees", tier: 1, clientId: OTHER_CLIENT });

    const id = await ensureBranch(CLIENT, "Fees", 4);

    expect(id).not.toBe("b-theirs");
    expect(branchRows().find((r) => r.id === "b-theirs")?.tier).toBe(1);
    expect(branchRows().find((r) => r.id === id)?.client_id).toBe(CLIENT);
  });

  it("two same-named branches resolve to the oldest, every time", async () => {
    // A tree written before this fix can hold both. Whichever row the database
    // hands back first, the answer has to be the same one on every call.
    seedBranch({ id: "b-older", title: "Fees", tier: 4, createdAt: iso(0) });
    seedBranch({ id: "b-newer", title: "fees", tier: 4, createdAt: iso(60_000) });

    expect(await ensureBranch(CLIENT, "Fees", 4)).toBe("b-older");
    expect(await ensureBranch(CLIENT, "fees", 4)).toBe("b-older");
    expect(branchRows()).toHaveLength(2); // still two, not three
  });
});
