import { describe, it, expect, vi, beforeEach } from "vitest";

// PUBLIC GATES on the funnel-progress endpoint.
//
// Sibling of step-event/public-gates.test.ts, and a harder case than that one. The
// beacon writes anonymous rows to a table of its own; this route reaches into
// speed_to_lead_lead — the practice's enquiry list, with names and phone numbers in
// it — from an unauthenticated request. So the properties pinned here are not only
// "how many rows can a stranger create" but "what can a stranger touch at all":
//
//   THE BEARER IS THE WHOLE AUTHORISATION, so a post without the exact token must
//   write nothing and be indistinguishable from one with it.
//   THE WRITE IS NARROW, so even the right token can only move funnel_* columns of
//   the one lead it belongs to.
//   THE RULES ARE IN THE `WHERE`, so a race between two of the patient's own posts
//   cannot land a backwards step or a second completion.
//
// THE POINT OF THIS FILE: deleting ANY guard from route.ts, or any filter from
// advanceLeadFunnelProgress, must turn a NAMED test below red.
//
// The DATABASE seam is a filter-aware in-memory stand-in (the same technique
// onboarding-lead-bridge.test.ts uses, and for the same reason): a filter-blind
// stub would make every assertion below vacuous, because a query that ignores its
// predicates returns the row whatever the route asked for. The REAL route, the REAL
// pure rules and the REAL repository functions run against it.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

const db = vi.hoisted(() => {
  const rows: Row[] = [];
  const stats = { selects: 0, updates: 0 };
  /** The column list of the most recent select, so "it never reads a patient" is checkable. */
  let lastSelect = "";
  /** The predicate of the most recent UPDATE, as `op:column` — one entry per filter. */
  let lastUpdateFilters: string[] = [];
  /** The SET list of the most recent UPDATE. */
  let lastUpdatePatch: string[] = [];
  /** Fired once, just after the next select runs, so a test can move the row underneath the write. */
  let onSelect: (() => void) | null = null;

  function cmp(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }

  function builder() {
    const filters: Filter[] = [];
    const shape: string[] = [];
    let mode: "select" | "update" = "select";
    let payload: Row = {};

    const run = (): Row[] => {
      if (mode === "update") {
        stats.updates += 1;
        lastUpdateFilters = [...shape];
        lastUpdatePatch = Object.keys(payload).sort();
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) Object.assign(r, payload);
        return hit;
      }
      stats.selects += 1;
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      // Snapshot BEFORE the hook, so the caller sees the row as it was read — which
      // is exactly the stale value a real read-then-write race hands it.
      const snap = hit.map((r) => ({ ...r }));
      const hook = onSelect;
      onSelect = null;
      hook?.();
      return snap;
    };

    const b: Record<string, unknown> = {};
    b.select = (cols?: string) => {
      if (typeof cols === "string" && mode === "select") lastSelect = cols;
      return b;
    };
    b.update = (v: Row) => {
      mode = "update";
      payload = v;
      return b;
    };
    b.eq = (col: string, v: unknown) => {
      shape.push(`eq:${col}`);
      filters.push((r) => r[col] === v);
      return b;
    };
    b.is = (col: string, v: unknown) => {
      shape.push(`is:${col}`);
      filters.push((r) => (r[col] ?? null) === v);
      return b;
    };
    b.lt = (col: string, v: unknown) => {
      shape.push(`lt:${col}`);
      filters.push((r) => cmp(r[col], v) < 0);
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: run()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej);
    return b;
  }

  return {
    rows,
    stats,
    lastSelect: () => lastSelect,
    lastUpdateFilters: () => [...lastUpdateFilters].sort(),
    lastUpdatePatch: () => [...lastUpdatePatch],
    /** Run `fn` once, in the window between the next read and the write that follows it. */
    raceOnNextSelect: (fn: () => void) => {
      onSelect = fn;
    },
    reset: () => {
      rows.length = 0;
      stats.selects = 0;
      stats.updates = 0;
      lastSelect = "";
      lastUpdateFilters = [];
      lastUpdatePatch = [];
      onSelect = null;
    },
    serviceClient: vi.fn(() => ({ from: () => builder() })),
  };
});

const h = vi.hoisted(() => {
  const state = {
    /** Budget keys whose allowance is spent. Everything else is allowed. */
    exhausted: new Set<string>(),
    /** The smile-assessment kill switch, as the STRICT reader would answer. */
    systemOn: true,
    /** Whether the lead's site resolves to exactly one practice. */
    siteResolves: true,
  };
  return {
    state,
    consumeBudget: vi.fn(async (key: string, _limit: number, _window: number) => {
      return !state.exhausted.has(key);
    }),
    clientIdForSites: vi.fn((siteIds: readonly string[]) =>
      state.siteResolves && siteIds.length === 1 ? "client-vitality" : null,
    ),
    /** STRICT: fails closed. This is the one the route must consult. */
    isSystemEnabledStrict: vi.fn(async () => state.systemOn),
    /**
     * The lax reader, mocked PERMISSIVE on purpose — the same decoy step-event's
     * gates use. If route.ts drops to this one, the kill-switch test goes red.
     */
    isSystemEnabled: vi.fn(async () => true),
    isSystemEnabledForSend: vi.fn(async () => true),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: db.serviceClient }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/mock/clients", () => ({ clientIdForSites: h.clientIdForSites }));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledForSend: h.isSystemEnabledForSend,
}));

import { POST } from "./route";

/** route.ts's MAX_BODY. Not exported (it is the route's own rule), so it is restated. */
const MAX_BODY = 512;

const TOKEN = "3f2b0d61-7c44-4a1e-9d2c-5e8b7a1f0c93";
const OTHER_TOKEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The single acknowledgement, byte for byte. Every outcome must produce THIS. */
const ACK_BODY = JSON.stringify({ ok: true });

/**
 * A lead mid-funnel: it gave its details at screen 5 of a 7-screen funnel drawn at
 * version 3. Every field a real row has that this route must NOT touch is present,
 * so "it moves nothing else" is checkable rather than assumed.
 */
function seedLead(over: Row = {}): Row {
  const row: Row = {
    id: "lead-1",
    site_id: "site-ng",
    name: "Amara Osei",
    phone: "+447700900123",
    email: "amara@example.com",
    stage: "contacted",
    score: 82,
    source: "smile:spring-implants",
    consent: { sms: true },
    created_at: "2026-08-21T10:00:00.000Z",
    updated_at: "2026-08-21T10:00:05.000Z",
    first_response_at: "2026-08-21T10:00:07.000Z",
    conversation_id: null,
    nurture_step: 0,
    nurture_next_at: null,
    funnel_last_step: 5,
    funnel_total_steps: 7,
    funnel_flow_version: 3,
    funnel_last_step_at: "2026-08-21T10:00:04.000Z",
    funnel_completed_at: null,
    funnel_session_nonce: TOKEN,
    ...over,
  };
  db.rows.push(row);
  return row;
}

/** Everything on the row this endpoint must never move. */
const UNTOUCHABLE = [
  "site_id",
  "name",
  "phone",
  "email",
  "stage",
  "score",
  "source",
  "consent",
  "created_at",
  "updated_at",
  "first_response_at",
  "conversation_id",
  "nurture_step",
  "nurture_next_at",
] as const;

function snapshot(row: Row): Row {
  return Object.fromEntries(UNTOUCHABLE.map((k) => [k, JSON.stringify(row[k])]));
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/smile-assessment/funnel-progress", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
    body: text,
  });
}

async function post(body: unknown, headers?: Record<string, string>) {
  const res = await POST(req(body, headers));
  return { status: res.status, body: await res.text() };
}

beforeEach(() => {
  db.reset();
  h.state.exhausted.clear();
  h.state.systemOn = true;
  h.state.siteResolves = true;
  h.consumeBudget.mockClear();
  h.isSystemEnabledStrict.mockClear();
  h.isSystemEnabled.mockClear();
});

describe("it says exactly the same thing whatever happens", () => {
  it("acknowledges a successful advance with the opaque 202", async () => {
    seedLead();
    const res = await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(res.status).toBe(202);
    expect(res.body).toBe(ACK_BODY);
  });

  it.each([
    ["an unknown token", { token: OTHER_TOKEN, flowVersion: 3, step: 6 }],
    ["a wrong flow version", { token: TOKEN, flowVersion: 4, step: 6 }],
    ["a backwards step", { token: TOKEN, flowVersion: 3, step: 1 }],
    ["a step past the end", { token: TOKEN, flowVersion: 3, step: 20 }],
    ["a malformed body", { nope: true }],
    ["not JSON at all", "<<<not json>>>"],
  ])("answers %s with the identical acknowledgement", async (_why, body) => {
    seedLead();
    const res = await post(body);
    expect(res.status).toBe(202);
    expect(res.body).toBe(ACK_BODY);
  });

  it("A WRONG TOKEN IS INDISTINGUISHABLE FROM A RIGHT ONE", async () => {
    // The endpoint must not be an oracle for guessing tokens, and must not reveal
    // that a lead exists. Status AND body, byte for byte.
    seedLead();
    const good = await post({ token: TOKEN, flowVersion: 3, step: 6 });
    db.reset();
    seedLead();
    const bad = await post({ token: OTHER_TOKEN, flowVersion: 3, step: 6 });
    expect(bad).toEqual(good);
  });
});

describe("the bearer is the whole authorisation", () => {
  it("advances the lead holding the token", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(6);
  });

  it("A NONCE MISMATCH WRITES NOTHING", async () => {
    const row = seedLead();
    const before = { ...row };
    await post({ token: OTHER_TOKEN, flowVersion: 3, step: 6 });
    expect(row).toEqual(before);
    expect(db.stats.updates).toBe(0);
  });

  it("cannot touch a SECOND lead, even one mid-funnel on the same site", async () => {
    const mine = seedLead();
    const theirs = seedLead({ id: "lead-2", funnel_session_nonce: OTHER_TOKEN, name: "Someone Else" });
    const before = { ...theirs };
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(mine.funnel_last_step).toBe(6);
    expect(theirs).toEqual(before);
  });

  it("A LEAD ID IN THE BODY IS WORTH NOTHING", async () => {
    // The parser constructs its result, so an invented key never reaches the query
    // — and the UPDATE is keyed on the nonce as well as the id, so even if one did
    // it could not address a row.
    const row = seedLead();
    const before = { ...row };
    await post({ token: OTHER_TOKEN, flowVersion: 3, step: 6, leadId: "lead-1", id: "lead-1" });
    expect(row).toEqual(before);
  });
});

describe("the write is narrow", () => {
  it("MOVES ONLY funnel_ COLUMNS", async () => {
    const row = seedLead();
    const before = snapshot(row);
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(snapshot(row)).toEqual(before);
  });

  it("does not bump updated_at, which the stale-claim failsafe reads", async () => {
    // resetStaleContacting reclaims a lead stranded at 'contacting' by comparing
    // updated_at to a cutoff. A patient's browser must not be able to postpone it.
    const row = seedLead({ stage: "contacting" });
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.updated_at).toBe("2026-08-21T10:00:05.000Z");
    expect(row.stage).toBe("contacting");
  });

  // MUTATION: delete any one filter from advanceLeadFunnelProgress. The early exit
  // in the route would still cover most of them, so this is what makes each filter
  // individually load-bearing rather than decorative — and the filters are the real
  // guard, because anything can happen between the read and the write on a public
  // endpoint (the two race tests below are the proof of that for two of them).
  it("THE UPDATE CARRIES EVERY GUARD IN ITS OWN PREDICATE", async () => {
    seedLead({ funnel_last_step: 2 });
    await post({ token: TOKEN, flowVersion: 3, step: 4 });
    expect(db.lastUpdateFilters()).toEqual(
      ["eq:funnel_flow_version", "eq:funnel_session_nonce", "eq:id", "lt:funnel_last_step"].sort(),
    );
  });

  it("adds the completed-once filter, and only on the write that completes", async () => {
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(db.lastUpdateFilters()).toContain("is:funnel_completed_at");
  });

  it("SETS ONLY funnel_ COLUMNS", async () => {
    // The row-level check above proves nothing moved; this proves nothing was even
    // NAMED, which is the property that survives a column being added to the table.
    seedLead({ funnel_last_step: 2 });
    await post({ token: TOKEN, flowVersion: 3, step: 4 });
    expect(db.lastUpdatePatch().sort()).toEqual(["funnel_last_step", "funnel_last_step_at"]);
    seedLead({ id: "lead-2", funnel_session_nonce: OTHER_TOKEN, funnel_last_step: 5 });
    await post({ token: OTHER_TOKEN, flowVersion: 3, step: 6 });
    expect(db.lastUpdatePatch().sort()).toEqual([
      "funnel_completed_at",
      "funnel_last_step",
      "funnel_last_step_at",
    ]);
  });

  it("never reads a patient's contact details", async () => {
    // The lookup names its columns instead of select("*"), so a name, a phone
    // number and an email address never enter the process serving this
    // unauthenticated request at all.
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    const cols = db.lastSelect();
    expect(cols).not.toBe("*");
    expect(cols).not.toMatch(/\bname\b|\bphone\b|\bemail\b|\bconsent\b/);
    expect(cols).toContain("funnel_total_steps");
  });
});

describe("the step can only go forwards, and only inside the funnel", () => {
  it("A BACKWARDS STEP IS REFUSED", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 2 });
    expect(row.funnel_last_step).toBe(5);
    expect(db.stats.updates).toBe(0);
  });

  it("repeating the current step changes nothing", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 5 });
    expect(row.funnel_last_step).toBe(5);
    expect(row.funnel_last_step_at).toBe("2026-08-21T10:00:04.000Z");
  });

  it("A STEP PAST THE LAST SCREEN IS REFUSED", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 7 });
    expect(row.funnel_last_step).toBe(5);
    expect(row.funnel_completed_at).toBeNull();
  });

  it("the ceiling comes from the ROW, not from the request", async () => {
    // A caller cannot lengthen their own funnel to reach a higher ordinal: the only
    // total in play is the one stored on the lead.
    //
    // MUTATION, said honestly: this one needs BOTH layers changed to go red —
    // `canAdvanceFunnelProgress`'s ceiling AND the route's `totalSteps:
    // session.progress.totalSteps`. Reading the total off the body in the route
    // alone leaves the pure rule (which only ever sees the row's own total) still
    // refusing, which is the point of it being two layers. Verified by mutating
    // both together.
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 9, totalSteps: 40, funnel_total_steps: 40 });
    expect(row.funnel_last_step).toBe(5);
    expect(row.funnel_total_steps).toBe(7);
  });

  it("A POST ABOUT A DIFFERENT FLOW VERSION IS REFUSED", async () => {
    // The owner republished mid-session. That ordinal now means a different screen,
    // so N and M would stop describing the same funnel.
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 4, step: 6 });
    expect(row.funnel_last_step).toBe(5);
    expect(row.funnel_flow_version).toBe(3);
  });

  it("N AND M STAY FROM ONE VERSION, so the displayed fraction cannot drift", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 4, step: 6 });
    expect({ step: row.funnel_last_step, total: row.funnel_total_steps, v: row.funnel_flow_version })
      .toEqual({ step: 5, total: 7, v: 3 });
  });
});

describe("a race between the read and the write cannot undo progress", () => {
  // MUTATION: drop `.lt("funnel_last_step", step)` from advanceLeadFunnelProgress.
  // The route's early exit checks the same rule, so every other test in this file
  // stays green — and a patient's own two in-flight posts would still be able to
  // drag their position backwards. ONLY the filter can catch this one.
  it("A LATE POST CANNOT LOWER A POSITION THAT MOVED WHILE IT WAS IN FLIGHT", async () => {
    const row = seedLead({ funnel_last_step: 2 });
    // The other post lands in the window between this one's read and its write.
    db.raceOnNextSelect(() => {
      row.funnel_last_step = 5;
    });
    await post({ token: TOKEN, flowVersion: 3, step: 4 });
    expect(row.funnel_last_step).toBe(5);
  });

  // MUTATION: drop `.is("funnel_completed_at", null)`. Same story: the route's
  // early exit cannot see a completion that happened after it read the row.
  it("A LATE POST CANNOT RE-STAMP A COMPLETION THAT LANDED WHILE IT WAS IN FLIGHT", async () => {
    const row = seedLead({ funnel_last_step: 2 });
    db.raceOnNextSelect(() => {
      row.funnel_last_step = 5;
      row.funnel_completed_at = "2026-08-21T10:00:09.000Z";
    });
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_completed_at).toBe("2026-08-21T10:00:09.000Z");
  });
});

describe("completion", () => {
  it("stamps funnel_completed_at when the last screen is reached", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(6);
    expect(typeof row.funnel_completed_at).toBe("string");
  });

  it("does NOT stamp completion on a step that is not the last", async () => {
    const row = seedLead({ funnel_last_step: 2, funnel_total_steps: 7 });
    await post({ token: TOKEN, flowVersion: 3, step: 4 });
    expect(row.funnel_last_step).toBe(4);
    expect(row.funnel_completed_at).toBeNull();
  });

  it("STAMPS COMPLETION ONCE, however many times the last screen is reported", async () => {
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    const stampedAt = row.funnel_completed_at;
    expect(typeof stampedAt).toBe("string");
    const updatesAfterFirst = db.stats.updates;
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_completed_at).toBe(stampedAt);
    expect(db.stats.updates).toBe(updatesAfterFirst);
  });

  it("cannot be re-stamped by a post that arrives after completion", async () => {
    // Belt and braces on the `funnel_completed_at is null` filter: a row that is
    // already complete stays exactly as it was.
    const row = seedLead({ funnel_last_step: 6, funnel_completed_at: "2026-08-21T10:00:09.000Z" });
    const before = { ...row };
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row).toEqual(before);
  });
});

describe("the kill switch", () => {
  it("writes nothing when the owner has switched smile-assessment off", async () => {
    const row = seedLead();
    h.state.systemOn = false;
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(5);
    expect(db.stats.updates).toBe(0);
  });

  it("consults the STRICT reader, which fails closed", async () => {
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(h.isSystemEnabledStrict).toHaveBeenCalledWith("client-vitality", "smile-assessment");
    // The lax reader is mocked permissive; using it would make the test above pass
    // for the wrong reason, so it must never be called.
    expect(h.isSystemEnabled).not.toHaveBeenCalled();
  });

  it("resolves the practice from the LEAD's site, never from the body", async () => {
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6, clientSlug: "someone-else" });
    expect(h.clientIdForSites).toHaveBeenCalledWith(["site-ng"]);
  });

  it("writes nothing when the lead's site does not resolve to one practice", async () => {
    const row = seedLead();
    h.state.siteResolves = false;
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(5);
  });
});

describe("the cost ceilings", () => {
  it("refuses a body whose Content-Length is over the cap, without reading it", async () => {
    // Only the header pre-check can catch this: the body itself is tiny.
    const row = seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 }, { "content-length": String(MAX_BODY + 1) });
    expect(row.funnel_last_step).toBe(5);
    expect(db.stats.selects).toBe(0);
  });

  it("refuses an oversized body that declares no Content-Length", async () => {
    // Only the post-read length check can catch this one.
    const row = seedLead();
    const padded = JSON.stringify({ token: TOKEN, flowVersion: 3, step: 6, pad: "x".repeat(MAX_BODY) });
    const res = await POST(
      new Request("http://localhost/api/smile-assessment/funnel-progress", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
        body: padded,
      }),
    );
    expect(res.status).toBe(202);
    expect(row.funnel_last_step).toBe(5);
  });

  it("stops at the PER-IP budget before touching the database", async () => {
    const row = seedLead();
    h.state.exhausted.add("assess-progress-ip:203.0.113.7");
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(5);
    expect(db.stats.selects).toBe(0);
    expect(db.stats.updates).toBe(0);
  });

  it("stops at the PER-TOKEN budget, so one bearer cannot hammer one row", async () => {
    const row = seedLead();
    h.state.exhausted.add(`assess-progress:${TOKEN}`);
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBe(5);
    expect(db.stats.updates).toBe(0);
  });

  it("spends the per-IP budget on the address the PLATFORM reports, not the one the caller writes", async () => {
    // Two spoofed x-forwarded-for prefixes from one real client must land on ONE
    // key, or the per-IP cap caps nothing.
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 }, { "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    db.reset();
    seedLead();
    await post({ token: TOKEN, flowVersion: 3, step: 6 }, { "x-forwarded-for": "9.9.9.9, 203.0.113.7" });
    const ipKeys = h.consumeBudget.mock.calls
      .map((c) => String(c[0]))
      .filter((k) => k.startsWith("assess-progress-ip:"));
    expect(new Set(ipKeys).size).toBe(1);
  });
});

describe("it never errors the caller", () => {
  it("swallows a database failure and still acknowledges", async () => {
    seedLead();
    db.serviceClient.mockImplementationOnce(() => {
      throw new Error("0094 has not been applied");
    });
    const res = await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(res.status).toBe(202);
    expect(res.body).toBe(ACK_BODY);
  });

  it("records nothing for a lead that carries no funnel position", async () => {
    // A missed call, a website form, any lead created before 0094 — and a token
    // that somehow matched one. There is nothing to advance.
    const row = seedLead({
      funnel_last_step: null,
      funnel_total_steps: null,
      funnel_flow_version: null,
    });
    await post({ token: TOKEN, flowVersion: 3, step: 6 });
    expect(row.funnel_last_step).toBeNull();
    expect(db.stats.updates).toBe(0);
  });
});
