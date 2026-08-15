// The funnel SAVE + PUBLISH route.
//
// The DB is faked at the supabase seam rather than at the repository seam on
// purpose: the repository is where validation, the compliance scan, the version
// bump and the concurrency guard live, so mocking it away would leave this file
// testing a `Response.json` wrapper. Everything below runs the real
// updateCampaignFlow against an in-memory row.

import { describe, it, expect, beforeEach, vi } from "vitest";

type User = { id: string; email: string; role: string; clientId: string | null };

const store = vi.hoisted(() => ({
  user: null as User | null,
  rows: [] as Record<string, unknown>[],
  /**
   * Forced DB error for the "0078 has not been applied" path. Applied ONLY to a
   * query that names a flow column, because that is how the real failure behaves:
   * `select("*")` on an un-migrated table succeeds and simply omits the keys.
   */
  error: null as { code?: string; message?: string } | null,
  /**
   * Simulate the real race: another save lands in the window between this
   * request's version read and its write. Nothing else can exercise the
   * `.eq("flow_version", ...)` on the UPDATE, which is the only thing that stops
   * a lost funnel edit, and a lost edit is silent by nature.
   */
  raceAfterRead: false,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "client-vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  // The REAL module predicate, not a stub that returns null: it is the only thing
  // keeping a clinician login out of the marketing funnels, and a permissive mock
  // would let that regress in silence.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.user,
    requireClientAccess: (u: User | null, cid: string) =>
      u && u.role !== "agency_admin" && u.clientId !== cid
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : null,
    requireModuleApiAccess: (u: User | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

/** A minimal supabase table honouring select/update + the exact .eq() predicates. */
function fakeTable() {
  const filters: [string, unknown][] = [];
  let patch: Record<string, unknown> | null = null;
  let columns = "*";
  const api = {
    select: (c = "*") => {
      columns = c;
      return api;
    },
    eq: (k: string, v: unknown) => {
      filters.push([k, v]);
      return api;
    },
    update: (p: Record<string, unknown>) => {
      patch = p;
      return api;
    },
    maybeSingle: async () => {
      if (store.error && columns.includes("flow")) return { data: null, error: store.error };
      const matched = store.rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      if (patch) for (const r of matched) Object.assign(r, patch);
      const data = matched[0] ? { ...matched[0] } : null;
      if (!patch && store.raceAfterRead && columns.includes("flow") && matched[0]) {
        matched[0].flow_version = (matched[0].flow_version as number) + 1;
      }
      return { data, error: null };
    },
  };
  return api;
}
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => fakeTable() }) }));

import { PUT } from "./route";
import { FLOW_TEMPLATES } from "@/lib/smile-assessment/flow-templates";
import { Q_BUDGET } from "@/lib/smile-assessment/quiz";
import type { FlowGraph } from "@/lib/smile-assessment/flow";

const OWNER: User = { id: "u1", email: "owner@vitality.co", role: "client_owner", clientId: "client-vitality" };

/** A real, valid template funnel: the thing an owner actually saves. */
const valid = (): FlowGraph => FLOW_TEMPLATES[0].build();

/**
 * The same funnel with the funding question cut out. This is the silent failure
 * rule 10 exists for: it looks like a working quiz and produces zero fast-tracked
 * leads forever (scoring.ts:98-105 -> submit/route.ts:291).
 */
function withoutBudget(): FlowGraph {
  const g = valid();
  const node = g.nodes.find((n) => n.kind === "question" && n.questionId === Q_BUDGET)!;
  const incoming = g.edges.filter((e) => e.to === node.id);
  const outgoing = g.edges.filter((e) => e.from === node.id);
  return {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== node.id),
    edges: [
      ...g.edges.filter((e) => e.from !== node.id && e.to !== node.id),
      ...incoming.map((e) => ({ from: e.from, to: outgoing[0]!.to, answer: e.answer })),
    ],
  };
}

function campaignRow(over: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    client_id: "client-vitality",
    site_id: "site-cc",
    slug: "invisalign",
    name: "Invisalign",
    goal: "invisalign",
    goal_note: null,
    ideal_customer: null,
    target_budget: "any",
    headline: null,
    intro: null,
    status: "active",
    flow: null,
    flow_version: 0,
    flow_published: false,
    created_by: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

async function put(body: unknown, slug = "invisalign"): Promise<Response> {
  return PUT(
    new Request("https://app.test/api/smile-assessment/campaign/invisalign/flow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

beforeEach(() => {
  store.user = OWNER;
  store.rows = [campaignRow()];
  store.error = null;
  store.raceAfterRead = false;
});

describe("guards", () => {
  it("403s a role that does not have the module, before touching the row", async () => {
    store.user = { ...OWNER, role: "client_clinician" };
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(403);
    expect(store.rows[0].flow).toBeNull();
    expect(store.rows[0].flow_version).toBe(0);
  });

  it("403s a signed-in user from another practice", async () => {
    store.user = { ...OWNER, clientId: "client-other" };
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(403);
  });

  it("404s an unknown client", async () => {
    const res = await put({ clientSlug: "not-a-practice", flow: valid() });
    expect(res.status).toBe(404);
  });

  it("404s an unknown campaign slug", async () => {
    const res = await put({ clientSlug: "vitality", flow: valid() }, "no-such-campaign");
    expect(res.status).toBe(404);
  });

  it("allows the practice coordinator, who legitimately has this module", async () => {
    store.user = { ...OWNER, role: "client_coordinator" };
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(200);
  });
});

describe("saving a graph", () => {
  it("stores the funnel and bumps the version, without publishing it", async () => {
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, flowVersion: 1, flowPublished: false });
    expect(store.rows[0].flow).not.toBeNull();
    // A save must never go live on its own: the campaign is an active ad
    // destination and there is no draft status to hide behind.
    expect(store.rows[0].flow_published).toBe(false);
  });

  it("bumps the version on every save", async () => {
    await put({ clientSlug: "vitality", flow: valid() });
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect((await res.json()).flowVersion).toBe(2);
  });

  it("rejects an invalid funnel with EVERY failure, not just the first", async () => {
    const res = await put({ clientSlug: "vitality", flow: withoutBudget() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { failures: { rule: number; code: string }[] };
    expect(body.failures.length).toBeGreaterThan(0);
    expect(body.failures.some((f) => f.rule === 10)).toBe(true);
    expect(store.rows[0].flow).toBeNull();
    expect(store.rows[0].flow_version).toBe(0);
  });

  it("rejects a blob that is not a graph at all, as rule 0", async () => {
    const res = await put({ clientSlug: "vitality", flow: { nodes: "yes please" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { failures: { rule: number; code: string }[] };
    expect(body.failures[0]).toMatchObject({ rule: 0, code: "unreadable" });
  });

  it("rejects non-compliant patient-facing copy and writes nothing", async () => {
    const g = valid();
    const outcome = g.nodes.find((n) => n.kind === "outcome")!;
    if (outcome.kind === "outcome") outcome.headline = "We guarantee the best result in London";
    const res = await put({ clientSlug: "vitality", flow: g });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { copyHits: { category: string }[] };
    expect(body.copyHits.length).toBeGreaterThan(0);
    expect(store.rows[0].flow).toBeNull();
  });

  it("rejects NHS wording, which the landing lint alone scopes more loosely", async () => {
    const g = valid();
    const q = g.nodes.find((n) => n.kind === "question")!;
    if (q.kind === "question") q.transition = "Are you with us on the NHS?";
    const res = await put({ clientSlug: "vitality", flow: g });
    expect(res.status).toBe(400);
    expect(store.rows[0].flow).toBeNull();
  });
});

describe("publishing", () => {
  it("refuses to publish when there is no valid saved funnel", async () => {
    const res = await put({ clientSlug: "vitality", published: true });
    expect(res.status).toBe(400);
    expect(store.rows[0].flow_published).toBe(false);
  });

  it("publishes a stored funnel without bumping its version", async () => {
    await put({ clientSlug: "vitality", flow: valid() });
    const res = await put({ clientSlug: "vitality", published: true });
    expect(res.status).toBe(200);
    // The version identifies WHICH funnel produced a response. Publishing what is
    // already stored does not make it a different funnel.
    expect(await res.json()).toEqual({ ok: true, flowVersion: 1, flowPublished: true });
  });

  it("unpublishes without losing the saved funnel", async () => {
    await put({ clientSlug: "vitality", flow: valid(), published: true });
    const res = await put({ clientSlug: "vitality", published: false });
    expect((await res.json()).flowPublished).toBe(false);
    expect(store.rows[0].flow).not.toBeNull();
  });

  it("refuses a request that asks for nothing at all", async () => {
    const res = await put({ clientSlug: "vitality" });
    expect(res.status).toBe(400);
  });

  it("refuses a non-boolean published flag", async () => {
    const res = await put({ clientSlug: "vitality", published: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("two people editing the same funnel", () => {
  it("409s the second save when the version moved underneath it", async () => {
    await put({ clientSlug: "vitality", flow: valid() }); // now at version 1
    const res = await put({ clientSlug: "vitality", flow: valid(), expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).storedVersion).toBe(1);
    expect(store.rows[0].flow_version).toBe(1); // the loser wrote nothing
  });

  it("refuses rather than overwriting when a save lands mid-request", async () => {
    // No expectedVersion here on purpose: this is the window the WRITE's own
    // version predicate exists for. Without it the second save would silently
    // discard the first, and nothing anywhere would say so.
    store.raceAfterRead = true;
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(409);
    expect(store.rows[0].flow).toBeNull();
  });

  it("accepts a save that names the version it loaded", async () => {
    await put({ clientSlug: "vitality", flow: valid() });
    const res = await put({ clientSlug: "vitality", flow: valid(), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect((await res.json()).flowVersion).toBe(2);
  });
});

describe("the database has not caught up", () => {
  it("says so plainly when migration 0078 has not been applied", async () => {
    store.error = { code: "42703", message: 'column "flow_version" does not exist' };
    const res = await put({ clientSlug: "vitality", flow: valid() });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/0078/);
  });
});
