import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The reads the co-pilot's lead-sight tools stand on.
 *
 * Their meaning is in the PREDICATE, not in the mapping, so the stub records
 * every filter each query issues. A stub that merely returned rows would let the
 * site scope, the bound and the window be deleted one by one with every test
 * still green.
 */

type Call = [string, ...unknown[]];

const h = vi.hoisted(() => {
  let result: { data: unknown; error: unknown } = { data: [], error: null };
  const calls: Call[] = [];
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["insert", "update", "select", "eq", "neq", "is", "in", "lt", "lte", "gte", "not", "or", "order", "limit"]) {
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    }
    b.single = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    calls,
    set: (r: { data: unknown; error: unknown }) => {
      result = r;
    },
    reset: () => {
      calls.length = 0;
      result = { data: [], error: null };
    },
    serviceClient: vi.fn(() => ({
      from: (t: string) => {
        calls.push(["from", t]);
        return makeBuilder();
      },
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { OPEN_LEAD_STAGES } from "@/lib/copilot/lead-sight";
import {
  findOpenLeadByAddress,
  listAttemptsForLeads,
  listLeads,
  listLeadsByIds,
} from "./repository";

function issued(...call: Call): boolean {
  return h.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe("listLeads: the optional window", () => {
  it("issues NO created_at filter when no window was asked for", () => {
    // Every pre-existing caller passes no window, and their behaviour must be
    // byte-for-byte what it was: the newest N leads, however old.
    return listLeads({ siteIds: ["site-cc"] }).then(() => {
      expect(h.calls.some((c) => c[0] === "gte")).toBe(false);
      expect(issued("in", "site_id", ["site-cc"])).toBe(true);
    });
  });

  it("pushes the window INTO the query, not into a post-filter", async () => {
    // A day busier than the row bound would otherwise lose its earliest enquiries
    // to the bound and report the remainder as the whole day.
    await listLeads({ siteIds: ["site-cc"], sinceIso: "2026-08-17T00:00:00.000Z" });
    expect(issued("gte", "created_at", "2026-08-17T00:00:00.000Z")).toBe(true);
  });

  it("stays site-scoped and bounded whatever else is asked for", async () => {
    await listLeads({ siteIds: ["site-cc"], stages: ["new"], sinceIso: "2026-08-17T00:00:00.000Z", limit: 25 });
    expect(issued("in", "site_id", ["site-cc"])).toBe(true);
    expect(issued("in", "stage", ["new"])).toBe(true);
    expect(issued("limit", 25)).toBe(true);
  });
});

describe("listLeadsByIds", () => {
  it("scopes by SITE as well as by id", async () => {
    // The ids arrive as a foreign key on another table's rows. Reading by id
    // alone would let a stale or tampered lead_id pull a lead belonging to a
    // different site - at a multi-site group, a different practice's enquiry.
    await listLeadsByIds({ siteIds: ["site-cc"], ids: ["lead-1", "lead-2"] });
    expect(issued("in", "site_id", ["site-cc"])).toBe(true);
    expect(issued("in", "id", ["lead-1", "lead-2"])).toBe(true);
  });

  it("is BOUNDED, so a long id list cannot become an unbounded read", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `lead-${i}`);
    await listLeadsByIds({ siteIds: ["site-cc"], ids: many });
    const inIds = h.calls.find((c) => c[0] === "in" && c[1] === "id") as [string, string, string[]];
    expect(inIds[2].length).toBeLessThanOrEqual(200);
    const limit = h.calls.find((c) => c[0] === "limit");
    expect(typeof limit![1]).toBe("number");
  });

  it("does not query at all on an empty scope or an empty id list", async () => {
    // "No scope" must never degrade into "every site", and an empty `in.()` is
    // not reliably "match nothing".
    expect(await listLeadsByIds({ siteIds: [], ids: ["lead-1"] })).toEqual([]);
    expect(await listLeadsByIds({ siteIds: ["site-cc"], ids: [] })).toEqual([]);
    expect(h.calls.length).toBe(0);
  });
});

describe("listAttemptsForLeads", () => {
  it("reads the attempts of the given leads, bounded", async () => {
    await listAttemptsForLeads(["lead-1", "lead-2"]);
    expect(issued("from", "speed_to_lead_attempt")).toBe(true);
    expect(issued("in", "lead_id", ["lead-1", "lead-2"])).toBe(true);
    const limit = h.calls.find((c) => c[0] === "limit");
    expect(typeof limit![1]).toBe("number");
  });

  it("does not query on an empty id list", async () => {
    expect(await listAttemptsForLeads([])).toEqual([]);
    expect(h.calls.length).toBe(0);
  });
});

describe("what 'open' means", () => {
  it("is the SAME four stages the pipeline's own dedupe treats as open", async () => {
    // OPEN_LEAD_STAGES is the co-pilot's definition and findOpenLeadByAddress is
    // the pipeline's. If they ever drift, the co-pilot describes a worklist the
    // practice does not have - so the drift is caught here rather than in a
    // conversation with an owner.
    await findOpenLeadByAddress("site-cc", "+447700900001", null, "2026-08-01T00:00:00.000Z");
    const stageFilter = h.calls.find((c) => c[0] === "in" && c[1] === "stage") as [string, string, string[]];
    expect(stageFilter).toBeDefined();
    expect([...stageFilter[2]].sort()).toEqual([...OPEN_LEAD_STAGES].sort());
  });
});
