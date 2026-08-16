import { describe, it, expect, vi, beforeEach } from "vitest";

// PUBLIC GATES on the anonymous step-view beacon endpoint.
//
// Sibling of submit/public-gates.test.ts, and the same shape of file for the same
// reason: this endpoint is unauthenticated, so the only thing standing between it
// and an attacker is the guard chain inside route.ts. Submit's exposure is SPEND
// (an AI call and a real SMS). This one's exposure is TABLE GROWTH — it writes
// scalar rows and nothing else — so the properties pinned here are the ones that
// bound how many rows a stranger can put in the practice's database, plus the one
// property that makes the endpoint safe to point at the public internet at all:
// it says exactly the same thing whatever happens.
//
// THE POINT OF THIS FILE: deleting ANY guard from route.ts must turn a NAMED test
// below red. Each guard therefore has a test that ONLY that guard can satisfy —
// the payload cap is proved twice (a lying Content-Length with a small body can
// only be caught by the header pre-check; an oversized body with no
// Content-Length at all can only be caught by the post-read check), the
// kill-switch test is written so that swapping the STRICT reader for the lax one
// fails it, and the paused-campaign test is written so that swapping the
// active-only campaign lookup for the plain one fails it.
//
// Every I/O seam is mocked; the REAL route handler and the REAL batch validator
// (parseStepEventBatch) run.

const CAMPAIGN = { id: "camp-1", slug: "spring-implants", status: "active" };

const h = vi.hoisted(() => {
  const state = {
    /** Budget keys whose allowance is spent. Everything else is allowed. */
    exhausted: new Set<string>(),
    /** The one slug getClient knows about. */
    knownClientSlug: "vitality",
    /** "active" | "paused" | "missing" — the campaign as the DATABASE holds it. */
    campaignStatus: "active" as "active" | "paused" | "missing",
    /** The smile-assessment kill switch, as the STRICT reader would answer. */
    systemOn: true,
    /** Set to make the insert blow up (0080 not applied, DB down, ...). */
    insertThrows: null as Error | null,
  };
  return {
    state,
    consumeBudget: vi.fn(async (key: string, _limit: number, _windowSeconds: number) => {
      return !state.exhausted.has(key);
    }),
    getClient: vi.fn((slug: string) =>
      slug === state.knownClientSlug ? { id: "client-vitality", slug } : undefined,
    ),
    /**
     * The ACTIVE-only lookup: null for a paused campaign, exactly as the real one is.
     */
    getActiveCampaignBySlug: vi.fn(async (_clientId: string, slug: string) => {
      if (state.campaignStatus === "missing" || slug !== "spring-implants") return null;
      return state.campaignStatus === "active" ? CAMPAIGN : null;
    }),
    /**
     * The DECOY, and it earns its place. It is the sibling lookup that ignores
     * status, so if route.ts is ever "simplified" onto it, the paused-campaign test
     * below starts inserting rows and goes red. Without this export in the mock,
     * that swap would be invisible.
     */
    getCampaignBySlug: vi.fn(async (_clientId: string, slug: string) => {
      if (state.campaignStatus === "missing" || slug !== "spring-implants") return null;
      return { ...CAMPAIGN, status: state.campaignStatus };
    }),
    /** STRICT: fails closed. This is the one the route must consult. */
    isSystemEnabledStrict: vi.fn(async (_clientId: string, _slug: string) => state.systemOn),
    /**
     * The lax reader, mocked PERMISSIVE on purpose — the same decoy trick. If the
     * route drops to this one, "the owner switched the system off" stops being
     * honoured and the kill-switch test goes red.
     */
    isSystemEnabled: vi.fn(async () => true),
    insertStepEvents: vi.fn(async (_rows: unknown[]) => {
      if (state.insertThrows) throw state.insertThrows;
    }),
  };
});

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/mock/clients", () => ({ getClient: h.getClient }));
vi.mock("@/lib/smile-assessment/campaign-repository", () => ({
  getActiveCampaignBySlug: h.getActiveCampaignBySlug,
  getCampaignBySlug: h.getCampaignBySlug,
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  isSystemEnabled: h.isSystemEnabled,
}));
vi.mock("@/lib/smile-assessment/step-events-repository", () => ({
  insertStepEvents: h.insertStepEvents,
}));

import { POST } from "./route";
import { MAX_EVENTS_PER_BATCH } from "@/lib/smile-assessment/step-events";

/** route.ts's MAX_BODY. Not exported (it is the route's own rule), so it is restated. */
const MAX_BODY = 2048;

const NONCE = "s3ss10n-nonce_AZ09";

const GOOD = {
  clientSlug: "vitality",
  campaignSlug: "spring-implants",
  flowVersion: 3,
  nonce: NONCE,
  steps: [0, 1, 2],
};

/** The single acknowledgement, byte for byte. Every outcome must produce THIS. */
const ACK_BODY = JSON.stringify({ ok: true });

function req(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/smile-assessment/step-event", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
    body: text,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.exhausted = new Set();
  h.state.knownClientSlug = "vitality";
  h.state.campaignStatus = "active";
  h.state.systemOn = true;
  h.state.insertThrows = null;
});

/** Nothing reached the table, and nothing downstream of the guard was even asked. */
function expectNoRows(): void {
  expect(h.insertStepEvents).not.toHaveBeenCalled();
}

describe("step-event beacon, payload cap", () => {
  it("drops a batch whose declared Content-Length is over the cap, before reading the body", async () => {
    // A SMALL, perfectly valid body with a LYING header. Only the pre-read header
    // check can refuse this: by the time the body is read it is a good batch.
    const res = await POST(req(GOOD, { "content-length": String(MAX_BODY + 1) }));

    expect(res.status).toBe(202);
    expectNoRows();
    // Refused before a single budget unit was spent, which is the point of putting
    // it first: an oversized post must not even cost a round trip to api_budget.
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.getClient).not.toHaveBeenCalled();
  });

  it("drops an oversized body that declares no Content-Length at all", async () => {
    // No Content-Length header: `new Request` does not add one, so the header
    // pre-check cannot fire and ONLY the authoritative post-read check is left.
    // The padding is an extra key the batch validator ignores, so if the cap were
    // removed this would parse into a perfectly good batch and insert.
    const fat = { ...GOOD, pad: "x".repeat(MAX_BODY) };
    const text = JSON.stringify(fat);
    expect(text.length).toBeGreaterThan(MAX_BODY);

    const res = await POST(
      new Request("http://localhost/api/smile-assessment/step-event", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
        body: text,
      }),
    );

    expect(res.status).toBe(202);
    expectNoRows();
    expect(h.consumeBudget).not.toHaveBeenCalled();
  });

  it("accepts a batch that sits just under the cap", async () => {
    const pad = "y".repeat(MAX_BODY - JSON.stringify(GOOD).length - 12);
    const text = JSON.stringify({ ...GOOD, pad });
    expect(text.length).toBeLessThanOrEqual(MAX_BODY);

    const res = await POST(req(text, { "content-length": String(text.length) }));
    expect(res.status).toBe(202);
    expect(h.insertStepEvents).toHaveBeenCalledTimes(1);
  });

  it("drops a body that is not JSON, without spending any budget", async () => {
    const res = await POST(req("<html>not a beacon</html>"));
    expect(res.status).toBe(202);
    expectNoRows();
    expect(h.consumeBudget).not.toHaveBeenCalled();
  });
});

describe("step-event beacon, the three durable ceilings", () => {
  it("spends the per-IP, per-campaign-minute and per-campaign-day budgets, with the stated limits", async () => {
    await POST(req(GOOD));

    expect(h.consumeBudget).toHaveBeenCalledWith("assess-step-ip:203.0.113.7", 240, 60 * 60);
    expect(h.consumeBudget).toHaveBeenCalledWith(
      "assess-step:vitality:spring-implants",
      300,
      60,
    );
    expect(h.consumeBudget).toHaveBeenCalledWith(
      "assess-step-day:vitality:spring-implants",
      5000,
      60 * 60 * 24,
    );
  });

  it("writes nothing once the per-IP hourly allowance is spent", async () => {
    h.state.exhausted.add("assess-step-ip:203.0.113.7");

    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expectNoRows();
    // And stops there: a flooder does not get to make us resolve a campaign either.
    expect(h.getClient).not.toHaveBeenCalled();
    expect(h.getActiveCampaignBySlug).not.toHaveBeenCalled();
    expect(h.isSystemEnabledStrict).not.toHaveBeenCalled();
  });

  it("writes nothing once the per-campaign burst allowance is spent, whatever the IP", async () => {
    h.state.exhausted.add("assess-step:vitality:spring-implants");

    const res = await POST(req(GOOD, { "x-real-ip": "198.51.100.44" }));
    expect(res.status).toBe(202);
    expectNoRows();
    expect(h.getActiveCampaignBySlug).not.toHaveBeenCalled();
  });

  it("writes nothing once the per-campaign DAILY row ceiling is spent", async () => {
    h.state.exhausted.add("assess-step-day:vitality:spring-implants");

    const res = await POST(req(GOOD, { "x-real-ip": "198.51.100.45" }));
    expect(res.status).toBe(202);
    expectNoRows();
    expect(h.getActiveCampaignBySlug).not.toHaveBeenCalled();
  });

  it("budgets an unknown slug too, so unknown-slug spam is capped as well", async () => {
    // The keys are built from the RAW posted slugs before anything is resolved,
    // which is the only way a stranger posting nonsense slugs is bounded at all.
    await POST(req({ ...GOOD, clientSlug: "not-a-practice", campaignSlug: "not-a-campaign" }));

    const keys = h.consumeBudget.mock.calls.map((c) => c[0]);
    expect(keys).toContain("assess-step:not-a-practice:not-a-campaign");
    expect(keys).toContain("assess-step-day:not-a-practice:not-a-campaign");
    expectNoRows();
  });
});

describe("step-event beacon, the per-IP budget identity", () => {
  // M1. x-forwarded-for is a list the CALLER can seed and the platform APPENDS to,
  // so the leftmost entry is attacker-chosen. Keying the budget on it would let one
  // client mint a fresh allowance per request by changing a header — a per-IP cap
  // that caps nothing. Derived exactly as smile-assessment/next/route.ts derives it.

  function ipKeyFor(headers: Record<string, string>): string {
    const key = h.consumeBudget.mock.calls.map((c) => c[0]).find((k) => k.startsWith("assess-step-ip:"));
    return key ?? `MISSING(${JSON.stringify(headers)})`;
  }

  async function keyWith(headers: Record<string, string>): Promise<string> {
    vi.clearAllMocks();
    await POST(
      new Request("http://localhost/api/smile-assessment/step-event", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(GOOD),
      }),
    );
    return ipKeyFor(headers);
  }

  it("keys two spoofed x-forwarded-for prefixes from one real client to the SAME budget", async () => {
    const a = await keyWith({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" });
    const b = await keyWith({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" });

    expect(a).toBe("assess-step-ip:9.9.9.9");
    expect(b).toBe(a);
  });

  it("still separates two genuinely different clients behind the same spoofed prefix", async () => {
    const a = await keyWith({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" });
    const b = await keyWith({ "x-forwarded-for": "9.9.9.9, 2.2.2.2" });

    expect(a).toBe("assess-step-ip:1.1.1.1");
    expect(b).toBe("assess-step-ip:2.2.2.2");
  });

  it("prefers the platform-set x-real-ip over anything the caller forwarded", async () => {
    const k = await keyWith({ "x-real-ip": "192.0.2.10", "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(k).toBe("assess-step-ip:192.0.2.10");
  });

  it("falls back to a single shared key when there is no address at all", async () => {
    const k = await keyWith({});
    expect(k).toBe("assess-step-ip:unknown");
  });
});

describe("step-event beacon, the kill switch", () => {
  it("writes nothing while the owner has smile-assessment switched off", async () => {
    h.state.systemOn = false;

    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expectNoRows();
    // STRICT, i.e. fail closed: an unreadable switch is an off switch here, and the
    // lax reader is mocked permissive above so dropping to it would fail this test.
    expect(h.isSystemEnabledStrict).toHaveBeenCalledWith("client-vitality", "smile-assessment");
    expect(h.isSystemEnabled).not.toHaveBeenCalled();
  });

  it("checks the switch BEFORE reading the campaign, so an off system does no DB work", async () => {
    h.state.systemOn = false;

    await POST(req(GOOD));
    expect(h.isSystemEnabledStrict).toHaveBeenCalledTimes(1);
    expect(h.getActiveCampaignBySlug).not.toHaveBeenCalled();
    expect(h.getCampaignBySlug).not.toHaveBeenCalled();
  });
});

describe("step-event beacon, who the rows may be attributed to", () => {
  it("writes nothing for an unknown client slug", async () => {
    const res = await POST(req({ ...GOOD, clientSlug: "not-a-practice" }));
    expect(res.status).toBe(202);
    expectNoRows();
    expect(h.isSystemEnabledStrict).not.toHaveBeenCalled();
    expect(h.getActiveCampaignBySlug).not.toHaveBeenCalled();
  });

  it("writes nothing for an unknown campaign slug", async () => {
    const res = await POST(req({ ...GOOD, campaignSlug: "no-such-campaign" }));
    expect(res.status).toBe(202);
    expectNoRows();
  });

  it("writes nothing for a PAUSED campaign, which still exists in the table", async () => {
    // The campaign is present and readable — getCampaignBySlug would hand it over.
    // Only the ACTIVE-only lookup refuses it, so this is the test that fails if the
    // route ever stops asking that question.
    h.state.campaignStatus = "paused";

    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expectNoRows();
  });

  it("writes nothing when the batch names no campaign at all", async () => {
    const res = await POST(req({ ...GOOD, campaignSlug: "" }));
    expect(res.status).toBe(202);
    expectNoRows();
  });

  it("attributes rows to the SERVER's resolution of the slugs, never to ids in the body", async () => {
    await POST(
      req({
        ...GOOD,
        clientId: "client-someone-else",
        campaignId: "camp-someone-else",
        siteId: "site-someone-else",
      }),
    );

    expect(h.insertStepEvents).toHaveBeenCalledTimes(1);
    const rows = h.insertStepEvents.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { clientId: "client-vitality", campaignId: "camp-1", flowVersion: 3, stepIndex: 0, nonce: NONCE },
      { clientId: "client-vitality", campaignId: "camp-1", flowVersion: 3, stepIndex: 1, nonce: NONCE },
      { clientId: "client-vitality", campaignId: "camp-1", flowVersion: 3, stepIndex: 2, nonce: NONCE },
    ]);
    // And no key the caller invented survived into the row.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "campaignId",
        "clientId",
        "flowVersion",
        "nonce",
        "stepIndex",
      ]);
    }
  });
});

describe("step-event beacon, the batch validator at the door", () => {
  it("writes nothing for a batch with an unusable nonce", async () => {
    const res = await POST(req({ ...GOOD, nonce: "alex@example.com" }));
    expect(res.status).toBe(202);
    expectNoRows();
  });

  it("writes nothing for a batch with no usable step at all", async () => {
    const res = await POST(req({ ...GOOD, steps: [-1, 999, "three"] }));
    expect(res.status).toBe(202);
    expectNoRows();
  });

  it("caps one post at MAX_EVENTS_PER_BATCH rows however many steps are posted", async () => {
    const steps = Array.from({ length: 200 }, (_, i) => i % 64);
    await POST(req({ ...GOOD, steps }));

    const rows = h.insertStepEvents.mock.calls[0][0] as unknown[];
    expect(rows).toHaveLength(MAX_EVENTS_PER_BATCH);
  });
});

describe("step-event beacon, one opaque answer for every outcome", () => {
  // A telemetry endpoint that answered differently for "unknown campaign" and
  // "accepted" would be a slug oracle for the practice's whole campaign list, on a
  // public URL. So the assertion is byte equality, not just a matching status.
  const outcomes: Array<[string, () => Promise<Response>]> = [
    ["accepted", () => POST(req(GOOD))],
    [
      "over the declared payload cap",
      () => POST(req(GOOD, { "content-length": String(MAX_BODY + 1) })),
    ],
    [
      "over the actual payload cap",
      () => POST(req({ ...GOOD, pad: "x".repeat(MAX_BODY) })),
    ],
    ["not JSON", () => POST(req("nope"))],
    ["not an object", () => POST(req("[1,2,3]"))],
    [
      "over the per-IP budget",
      () => {
        h.state.exhausted.add("assess-step-ip:203.0.113.7");
        return POST(req(GOOD));
      },
    ],
    [
      "over the per-campaign budget",
      () => {
        h.state.exhausted.add("assess-step:vitality:spring-implants");
        return POST(req(GOOD));
      },
    ],
    [
      "over the daily budget",
      () => {
        h.state.exhausted.add("assess-step-day:vitality:spring-implants");
        return POST(req(GOOD));
      },
    ],
    ["an unusable batch", () => POST(req({ ...GOOD, nonce: "short" }))],
    ["an unknown client", () => POST(req({ ...GOOD, clientSlug: "not-a-practice" }))],
    [
      "the system switched off",
      () => {
        h.state.systemOn = false;
        return POST(req(GOOD));
      },
    ],
    ["an unknown campaign", () => POST(req({ ...GOOD, campaignSlug: "no-such-campaign" }))],
    [
      "a paused campaign",
      () => {
        h.state.campaignStatus = "paused";
        return POST(req(GOOD));
      },
    ],
    [
      "the insert failing",
      () => {
        h.state.insertThrows = new Error("relation assessment_step_event does not exist");
        return POST(req(GOOD));
      },
    ],
  ];

  it.each(outcomes)("answers an identical 202 for: %s", async (_label, run) => {
    const res = await run();
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(ACK_BODY);
  });

  it("answers the SAME BYTES for every outcome, compared against each other", async () => {
    const bodies: string[] = [];
    const statuses: number[] = [];
    for (const [, run] of outcomes) {
      vi.clearAllMocks();
      h.state.exhausted = new Set();
      h.state.campaignStatus = "active";
      h.state.systemOn = true;
      h.state.insertThrows = null;
      const res = await run();
      statuses.push(res.status);
      bodies.push(await res.text());
    }
    expect(new Set(statuses)).toEqual(new Set([202]));
    expect(new Set(bodies)).toEqual(new Set([ACK_BODY]));
  });

  it("never turns a failed insert into an error the patient's browser can see", async () => {
    h.state.insertThrows = new Error("boom");
    const res = await POST(req(GOOD));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(ACK_BODY);
  });
});
