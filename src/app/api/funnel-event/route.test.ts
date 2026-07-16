import { describe, it, expect, vi, beforeEach } from "vitest";

// PUBLIC POST /api/funnel-event: anonymous, PII-free telemetry. These tests
// defend the api_budget ceiling (over budget => nothing written) and the input
// validation + meta sanitisation (bad surface / unknown client / empty batch =>
// nothing written; nested/PII-shaped meta stripped to small scalars). The REAL
// validation runs; only the budget guard and the DB insert are mocked.

const h = vi.hoisted(() => ({
  consumeBudget: vi.fn(async (..._a: unknown[]) => true),
  insertFunnelEvents: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: (...a: unknown[]) => h.consumeBudget(...a) }));
vi.mock("@/lib/funnel/events", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, insertFunnelEvents: (...a: unknown[]) => h.insertFunnelEvents(...a) };
});

import { POST } from "./route";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/funnel-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function goodBody(overrides: Record<string, unknown> = {}) {
  return {
    clientSlug: "vitality",
    surface: "booking",
    sessionId: "sess-123",
    events: [{ step: "viewed" }, { step: "slot_selected" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeBudget.mockResolvedValue(true);
  h.insertFunnelEvents.mockResolvedValue(undefined);
});

describe("POST /api/funnel-event — happy path", () => {
  it("records a valid batch and always answers an opaque 202", async () => {
    const res = await post(goodBody());
    expect(res.status).toBe(202);
    expect(h.insertFunnelEvents).toHaveBeenCalledTimes(1);
    const rows = h.insertFunnelEvents.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ clientId: "vitality", surface: "booking", sessionId: "sess-123", step: "viewed" });
  });

  it("sanitises meta to small scalars, dropping nested/PII-shaped values", async () => {
    await post(
      goodBody({
        events: [{ step: "question_answered", meta: { index: 2, note: { deep: "x" }, ok: true } }],
      }),
    );
    const rows = h.insertFunnelEvents.mock.calls[0]![0] as Array<{ meta: Record<string, unknown> }>;
    expect(rows[0]!.meta).toEqual({ index: 2, ok: true }); // the nested object was dropped
  });
});

describe("POST /api/funnel-event — budget guard", () => {
  it("writes nothing when over the shared api_budget (still 202)", async () => {
    h.consumeBudget.mockResolvedValue(false);
    const res = await post(goodBody());
    expect(res.status).toBe(202);
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });
});

describe("POST /api/funnel-event — validation", () => {
  it("drops an unknown surface", async () => {
    await post(goodBody({ surface: "nope" }));
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });

  it("drops an unknown client slug", async () => {
    await post(goodBody({ clientSlug: "not-a-tenant" }));
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });

  it("drops a missing/blank session id", async () => {
    await post(goodBody({ sessionId: "" }));
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });

  it("drops an empty or all-invalid event batch", async () => {
    await post(goodBody({ events: [] }));
    await post(goodBody({ events: [{ nope: 1 }, { step: "" }] }));
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });

  it("never throws on malformed JSON (202, nothing written)", async () => {
    const res = await post("not json at all");
    expect(res.status).toBe(202);
    expect(h.insertFunnelEvents).not.toHaveBeenCalled();
  });
});
