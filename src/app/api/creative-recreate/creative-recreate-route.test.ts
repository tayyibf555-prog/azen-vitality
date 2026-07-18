import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// renders.ts + guard.ts do `import "server-only"` (unresolvable under the node test
// env). Stub it. The renders repo and the auth guard are fully mocked below so we can
// drive roles and assert persistence without a database. The Higgsfield client is NOT
// mocked: the happy path exercises the real client against a mocked global fetch, so
// the stored URL genuinely comes from a (mocked) API response.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(() => null),
  requireOwnerRole: vi.fn((user: { role?: string } | null) =>
    user && user.role !== "client_owner" && user.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  ),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
  requireOwnerRole: h.requireOwnerRole,
}));

vi.mock("@/lib/creative/renders", () => ({
  insertRender: vi.fn(async () => {}),
  markRenderComplete: vi.fn(async () => {}),
  markRenderFailed: vi.fn(async () => {}),
  listRenders: vi.fn(async () => []),
}));

import { POST, GET } from "./route";
import {
  insertRender,
  markRenderComplete,
  markRenderFailed,
  listRenders,
} from "@/lib/creative/renders";

const KEY = "HIGGSFIELD_API_KEY";
const CREATIVE = "adlib-bright-smile-whitening";
const COORD = { id: "u2", email: "c@x", role: "client_coordinator", clientId: "vitality", siteIds: [] };

function post(body: unknown): Request {
  return new Request("http://localhost/api/creative-recreate", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockFetchCompleted(url = "https://img.example/x.jpg") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "completed", request_id: "req-1", images: [{ url }] }),
      text: async () => "",
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth not enforced (requireUser -> null), so the owner gate is a no-op and
  // the input/compliance/config behaviour is what is exercised.
  h.requireUser.mockResolvedValue(null);
  h.requireClientAccess.mockReturnValue(null);
  delete process.env[KEY];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[KEY];
});

describe("POST /api/creative-recreate: guards", () => {
  it("400s an invalid JSON body", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
  });

  it("400s an unknown client", async () => {
    const res = await POST(post({ clientSlug: "nope", creativeRef: CREATIVE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown client/i);
  });

  it("404s an unknown creative", async () => {
    const res = await POST(post({ clientSlug: "vitality", creativeRef: "adlib-nope" }));
    expect(res.status).toBe(404);
  });

  it("403s a non-owner (coordinator) and never persists or generates", async () => {
    h.requireUser.mockResolvedValue(COORD);
    mockFetchCompleted();
    const res = await POST(post({ clientSlug: "vitality", creativeRef: CREATIVE }));
    expect(res.status).toBe(403);
    expect(insertRender).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/creative-recreate: compliance lint", () => {
  it("refuses (400) a banned claim injected via angle notes, before any persistence", async () => {
    const res = await POST(
      post({ clientSlug: "vitality", creativeRef: CREATIVE, angleNotes: "the best, pain-free results" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/compliance/i);
    expect(insertRender).not.toHaveBeenCalled();
  });
});

describe("POST /api/creative-recreate: not configured (dormant)", () => {
  it("records a not_configured render row and returns the honest message", async () => {
    delete process.env[KEY];
    const res = await POST(post({ clientSlug: "vitality", creativeRef: CREATIVE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("not_configured");
    expect(body.message).toMatch(/HIGGSFIELD_API_KEY/);
    expect(insertRender).toHaveBeenCalledTimes(1);
    expect(insertRender).toHaveBeenCalledWith(
      expect.objectContaining({ status: "not_configured", clientId: "vitality", sourceRef: CREATIVE }),
    );
    expect(markRenderComplete).not.toHaveBeenCalled();
  });
});

describe("POST /api/creative-recreate: configured happy path", () => {
  it("generates via Higgsfield and stores a completed render with the image URL", async () => {
    process.env[KEY] = "id:secret";
    mockFetchCompleted("https://img.example/branded.jpg");
    const res = await POST(post({ clientSlug: "vitality", creativeRef: CREATIVE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("complete");
    expect(body.render.imageUrl).toBe("https://img.example/branded.jpg");
    // A pending row is written first, then marked complete with the URL.
    expect(insertRender).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    expect(markRenderComplete).toHaveBeenCalledWith(expect.any(String), "https://img.example/branded.jpg");
    expect(markRenderFailed).not.toHaveBeenCalled();
  });

  it("marks the render failed (503) and never fabricates when Higgsfield errors", async () => {
    process.env[KEY] = "id:secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" })),
    );
    const res = await POST(post({ clientSlug: "vitality", creativeRef: CREATIVE }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("failed");
    expect(markRenderFailed).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/creative-recreate: renders list", () => {
  it("returns the practice's renders, scoped to the client id", async () => {
    const rows = [
      { id: "r1", clientId: "vitality", sourceRef: CREATIVE, prompt: "p", status: "complete", imageUrl: "u", error: null, createdBy: null, createdAt: "2026-07-18T00:00:00Z" },
    ];
    (listRenders as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);
    const res = await GET(new Request("http://localhost/api/creative-recreate?clientSlug=vitality"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.renders).toHaveLength(1);
    // Scoped by the resolved client id, not the raw slug guesswork.
    expect(listRenders).toHaveBeenCalledWith("vitality");
  });

  it("403s a non-owner on the list", async () => {
    h.requireUser.mockResolvedValue(COORD);
    const res = await GET(new Request("http://localhost/api/creative-recreate?clientSlug=vitality"));
    expect(res.status).toBe(403);
    expect(listRenders).not.toHaveBeenCalled();
  });
});
