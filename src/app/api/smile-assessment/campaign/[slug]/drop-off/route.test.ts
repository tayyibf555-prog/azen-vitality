// The step DROP-OFF read: the guarded GET behind the owner's funnel chart.
//
// Sibling of ../flow/route.test.ts and mocked at the same depth, with one
// deliberate exception: the step-event repository is mocked with its REAL module
// underneath (importActual), so StepEventTableMissingError is the genuine class.
// A hand-rolled stand-in would make the `instanceof` branch in route.ts pass here
// while doing nothing in production, and that branch is the whole "0080 has not
// been applied" story.
//
// WHAT THIS FILE IS FOR. The rows behind this endpoint are anonymous, so it is
// tempting to treat the read as harmless. It is not: the ANSWER is the practice's
// own marketing performance, and every query-string field on it is a number a
// caller chooses that ends up in a Postgres int4 column or a date range. So the
// pins are the guard chain, the two bounded inputs, and the one error that must
// stay named instead of being flattened into an empty funnel.

import { describe, it, expect, beforeEach, vi } from "vitest";

type User = { id: string; email: string; role: string; clientId: string | null };

const store = vi.hoisted(() => ({
  auth: null as unknown,
  campaign: null as Record<string, unknown> | null,
  /** What readStepEvents does: hand back rows, or blow up. */
  rows: [] as Array<{ stepIndex: number; nonce: string }>,
  truncated: false,
  throws: null as Error | null,
}));

const h = vi.hoisted(() => ({
  getCampaignBySlug: vi.fn(async (_clientId: string, _slug: string) => null as unknown),
  readStepEvents: vi.fn(async (_args: unknown) => ({ rows: [], truncated: false }) as unknown),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "client-vitality", slug: "vitality" } : undefined,
}));

vi.mock("@/lib/auth/guard", async () => {
  // The REAL module predicate, as ../flow/route.test.ts does and for the same
  // reason: it is the only thing keeping a clinician login out of the marketing
  // numbers, and a permissive stub would let that regress in silence.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.auth,
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

vi.mock("@/lib/smile-assessment/campaign-repository", () => ({
  getCampaignBySlug: h.getCampaignBySlug,
}));

vi.mock("@/lib/smile-assessment/step-events-repository", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readStepEvents: h.readStepEvents };
});

import { GET, maxDuration } from "./route";
import { MAX_FLOW_VERSION } from "@/lib/smile-assessment/step-events";
import { StepEventTableMissingError } from "@/lib/smile-assessment/step-events-repository";

const OWNER: User = {
  id: "u1",
  email: "owner@vitality.co",
  role: "client_owner",
  clientId: "client-vitality",
};

const CAMPAIGN = {
  id: "camp-1",
  clientId: "client-vitality",
  slug: "spring-implants",
  name: "Spring implants",
  status: "active",
  flowVersion: 7,
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function get(query = "?client=vitality", slug = "spring-implants"): Promise<Response> {
  return GET(
    new Request(`https://app.test/api/smile-assessment/campaign/${slug}/drop-off${query}`),
    { params: Promise.resolve({ slug }) },
  );
}

/** The arguments readStepEvents was actually handed. */
function scanArgs(): { campaignId: string; flowVersion: number; fromIso: string; toIso: string } {
  return h.readStepEvents.mock.calls[0][0] as {
    campaignId: string;
    flowVersion: number;
    fromIso: string;
    toIso: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.auth = OWNER;
  store.campaign = CAMPAIGN;
  store.rows = [];
  store.truncated = false;
  store.throws = null;
  h.getCampaignBySlug.mockImplementation(async (_clientId: string, slug: string) =>
    store.campaign && slug === CAMPAIGN.slug ? store.campaign : null,
  );
  h.readStepEvents.mockImplementation(async (_args: unknown) => {
    if (store.throws) throw store.throws;
    return { rows: store.rows, truncated: store.truncated };
  });
});

describe("drop-off, the shape of the route", () => {
  it("declares the house report timeout", () => {
    // A wide window is a paged scan, not a page fetch. Without this the platform
    // default cuts the scan off mid-walk and the owner gets a truncated funnel
    // with no explanation of why.
    expect(maxDuration).toBe(60);
  });
});

describe("drop-off, the guard chain", () => {
  it("hands back the auth challenge without reading anything", async () => {
    store.auth = Response.json({ error: "unauthorized" }, { status: 401 });

    const res = await get();
    expect(res.status).toBe(401);
    expect(h.getCampaignBySlug).not.toHaveBeenCalled();
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });

  it("403s a clinician, before the campaign is even looked up", async () => {
    store.auth = { ...OWNER, role: "client_clinician" };

    const res = await get();
    expect(res.status).toBe(403);
    expect(h.getCampaignBySlug).not.toHaveBeenCalled();
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });

  it("403s a signed-in user from another practice", async () => {
    store.auth = { ...OWNER, clientId: "client-other" };

    const res = await get();
    expect(res.status).toBe(403);
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });

  it("admits the practice coordinator, who legitimately has this module", async () => {
    store.auth = { ...OWNER, role: "client_coordinator" };
    expect((await get()).status).toBe(200);
  });
});

describe("drop-off, naming the practice and the campaign", () => {
  it("404s when no client is named at all", async () => {
    const res = await get("");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Unknown client");
    expect(h.getCampaignBySlug).not.toHaveBeenCalled();
  });

  it("404s an unknown client slug", async () => {
    const res = await get("?client=not-a-practice");
    expect(res.status).toBe(404);
    expect(h.getCampaignBySlug).not.toHaveBeenCalled();
  });

  it("404s an unknown campaign slug, and reads no events", async () => {
    const res = await get("?client=vitality", "no-such-campaign");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Assessment not found");
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });
});

describe("drop-off, the window", () => {
  it("defaults to 30 days", async () => {
    await get();
    const { fromIso, toIso } = scanArgs();
    expect(Date.parse(toIso) - Date.parse(fromIso)).toBe(30 * DAY_MS);
  });

  it("honours a whole number of days inside the ceiling", async () => {
    await get("?client=vitality&days=7");
    const { fromIso, toIso } = scanArgs();
    expect(Date.parse(toIso) - Date.parse(fromIso)).toBe(7 * DAY_MS);
  });

  it("accepts the boundaries, 1 and 365", async () => {
    expect((await get("?client=vitality&days=1")).status).toBe(200);
    vi.clearAllMocks();
    h.getCampaignBySlug.mockImplementation(async () => store.campaign);
    h.readStepEvents.mockImplementation(async () => ({ rows: [], truncated: false }));
    expect((await get("?client=vitality&days=365")).status).toBe(200);
  });

  it.each([
    ["0", "zero days is not a window"],
    ["366", "past the one-year ceiling"],
    ["-5", "negative"],
    ["1.5", "a fraction of a day"],
    ["abc", "not a number"],
    ["", "empty"],
    ["1e400", "an infinity"],
  ])("400s days=%s (%s) without touching the table", async (days) => {
    const res = await get(`?client=vitality&days=${days}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/365/);
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });
});

describe("drop-off, the funnel version", () => {
  it("defaults to the campaign's CURRENT version", async () => {
    const res = await get();
    expect(scanArgs().flowVersion).toBe(7);
    expect((await res.json()).flowVersion).toBe(7);
  });

  it("reads an older version when asked for one", async () => {
    await get("?client=vitality&flowVersion=3");
    expect(scanArgs().flowVersion).toBe(3);
  });

  it("treats version 0 as a real version, not as 'unset'", async () => {
    // A campaign that has never had a funnel saved carries flow_version 0, so
    // falling back to the default here would silently answer about a different
    // funnel than the one asked about.
    await get("?client=vitality&flowVersion=0");
    expect(scanArgs().flowVersion).toBe(0);
  });

  it("accepts the ceiling itself", async () => {
    const res = await get(`?client=vitality&flowVersion=${MAX_FLOW_VERSION}`);
    expect(res.status).toBe(200);
    expect(scanArgs().flowVersion).toBe(MAX_FLOW_VERSION);
  });

  it.each([
    ["-1", "negative"],
    ["2.5", "a fraction"],
    ["abc", "not a number"],
    ["Infinity", "an infinity"],
    [String(MAX_FLOW_VERSION + 1), "one past the ceiling"],
    ["1e20", "an integer-valued float far past int4"],
    ["9007199254740993", "past the safe integer range"],
  ])("400s flowVersion=%s (%s) rather than letting Postgres refuse it", async (version) => {
    // 1e20 is the one that matters: Number.isInteger(1e20) is TRUE, so a lower
    // bound alone lets it through to an int4 column, where it is not an empty
    // funnel but an out-of-range error — a 500 handed to an owner by a query
    // string. It never reaches the table.
    const res = await get(`?client=vitality&flowVersion=${version}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/flowVersion/);
    expect(h.readStepEvents).not.toHaveBeenCalled();
  });
});

describe("drop-off, when the database has not caught up", () => {
  it("503s NAMING migration 0080 rather than reporting an empty funnel", async () => {
    // The wrong answer here is not a crash, it is "0 sessions, 0% completion" —
    // which tells an owner that nobody uses their funnel.
    store.throws = new StepEventTableMissingError();

    const res = await get();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/0080/);
    expect(body.error).toMatch(/assessment_step_events/);
  });

  it("500s any other read failure, without blaming a migration", async () => {
    store.throws = new Error("connection reset");

    const res = await get();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/0080/);
  });
});

describe("drop-off, the answer", () => {
  it("reports the per-step funnel for the campaign it was asked about", async () => {
    store.rows = [
      { stepIndex: 0, nonce: "a" },
      { stepIndex: 0, nonce: "b" },
      { stepIndex: 0, nonce: "b" }, // a replayed beacon, not a second visitor
      { stepIndex: 1, nonce: "a" },
    ];

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      campaign: { slug: string; name: string };
      truncated: boolean;
      funnel: { sessions: number; completionPct: number | null; steps: Array<{ views: number }> };
    };

    expect(body.ok).toBe(true);
    expect(body.campaign).toEqual({ slug: "spring-implants", name: "Spring implants" });
    expect(body.funnel.sessions).toBe(2);
    expect(body.funnel.steps.map((s) => s.views)).toEqual([2, 1]);
    expect(body.funnel.completionPct).toBe(50);
    expect(scanArgs().campaignId).toBe("camp-1");
  });

  it("says out loud when the scan hit its ceiling", async () => {
    store.truncated = true;
    const body = (await (await get()).json()) as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * The stitch: the numbering the beacon emits with is the numbering this route
 * labels and pads with. A3 deliberately shipped without it; these are the pins
 * that keep the two halves talking about the same screens.
 * ------------------------------------------------------------------------- */

const FUNNEL_GRAPH = {
  schemaVersion: 2,
  entry: "w",
  nodes: [
    { kind: "welcome", id: "w", headline: "Straighter teeth", intro: "Two minutes." },
    { kind: "question", id: "q1", questionId: "treatment_interest", transition: null },
    { kind: "question", id: "q2", questionId: "timeline", transition: null },
    { kind: "contact", id: "c" },
    { kind: "outcome", id: "hot", band: "high", headline: "A great fit" },
    { kind: "outcome", id: "cold", band: "low", headline: "Worth a chat" },
  ],
  edges: [
    { from: "w", to: "q1", answer: null, transition: null },
    { from: "q1", to: "q2", answer: null, transition: null },
    { from: "q2", to: "c", answer: null, transition: null },
    { from: "c", to: "hot", answer: "high", transition: null },
    { from: "c", to: "cold", answer: "low", transition: null },
  ],
};

interface DropOffBody {
  funnel: { steps: Array<{ stepIndex: number; views: number }>; completionPct: number | null };
  labels?: Record<string, string>;
  stepCount?: number;
}

describe("drop-off, the funnel's own step numbering", () => {
  beforeEach(() => {
    store.campaign = { ...CAMPAIGN, flow: FUNNEL_GRAPH, headline: "Straighter teeth", intro: null };
  });

  // MUTATION: drop stepCount. A screen nobody reached then VANISHES from the chart
  // instead of drawing as an empty bar — which is precisely the fault an owner
  // opens this panel to find.
  it("pads the funnel to the length of the graph, so an unreached screen is an empty bar", async () => {
    store.rows = [
      { stepIndex: 0, nonce: "a" },
      { stepIndex: 0, nonce: "b" },
      { stepIndex: 1, nonce: "a" },
    ];

    const body = (await (await get()).json()) as DropOffBody;
    // 6 nodes, 4 screens: the welcome step is not one, and the two result steps
    // share the last ordinal.
    expect(body.stepCount).toBe(4);
    expect(body.funnel.steps.map((s) => s.views)).toEqual([2, 1, 0, 0]);
  });

  // MUTATION: label from a second lookup, or not at all. "Step 1, Step 2, Step 3"
  // answers nothing an owner asked — the whole question is WHICH screen loses
  // people.
  it("labels each ordinal with the screen's own words, and the result slot for what it is", async () => {
    const body = (await (await get()).json()) as DropOffBody;
    expect(body.labels).toBeDefined();
    const labels = body.labels!;
    expect(labels["0"]).toMatch(/\?$/); // the first question's prompt
    expect(labels["1"]).not.toBe(labels["0"]);
    expect(labels["2"]).toBe("Where should we send your tailored next step?");
    expect(labels["3"]).toBe("Result");
    // Never one band's headline: every band shares that slot.
    expect(labels["3"]).not.toBe("A great fit");
  });

  // MUTATION: label an older version with today's graph. A campaign row stores ONE
  // funnel, so bar 3 would be named with a question that funnel never asked and the
  // chart padded to a length it never had.
  it("refuses to label or pad an older flow version, whose graph it does not have", async () => {
    store.rows = [{ stepIndex: 0, nonce: "a" }];

    const body = (await (await get("?client=vitality&flowVersion=3")).json()) as DropOffBody;
    expect(body.labels).toBeUndefined();
    expect(body.stepCount).toBeUndefined();
    expect(body.funnel.steps).toHaveLength(1);
  });

  it("says nothing about numbering for a campaign with no readable funnel", async () => {
    store.campaign = { ...CAMPAIGN, flow: { not: "a graph" } };

    const body = (await (await get()).json()) as DropOffBody;
    expect(body.labels).toBeUndefined();
    expect(body.stepCount).toBeUndefined();
  });

  // The completion decision, end to end: the last ordinal is the RESULT screen, so
  // completionPct is the funnel's completion rate rather than the share of visitors
  // who happened to get one particular band.
  it("reports completion as the share who reached a result screen", async () => {
    store.rows = [
      { stepIndex: 0, nonce: "a" },
      { stepIndex: 0, nonce: "b" },
      { stepIndex: 0, nonce: "c" },
      { stepIndex: 0, nonce: "d" },
      { stepIndex: 3, nonce: "a" },
    ];

    const body = (await (await get()).json()) as DropOffBody;
    expect(body.funnel.completionPct).toBe(25);
  });
});
