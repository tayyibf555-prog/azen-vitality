import { describe, it, expect, vi } from "vitest";

// guard.ts does `import "server-only"`, which does not resolve under the node test
// env; stub it (the guards are no-ops here anyway, auth is not enforced).
vi.mock("server-only", () => ({}));

import { POST, GET } from "./route";
import { PATCH } from "./[id]/route";

// Guard-path tests for the landing-page routes: the input validation that returns
// BEFORE any DB or model call. Auth is not enforced in the test env (no service-
// role key), so requireUser is a no-op here; the deeper DB paths and the owner-role
// gate are exercised at integration. The generation FALLBACK logic is unit-tested
// directly in generate-run.test.ts (mocked model).

function post(body: unknown): Request {
  return new Request("http://localhost/api/landing-pages", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/landing-pages (guards)", () => {
  it("rejects an invalid JSON body", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
  });

  it("404s an unknown client", async () => {
    const res = await POST(post({ clientSlug: "nope", treatment: "invisalign" }));
    expect(res.status).toBe(404);
  });

  it("400s a missing treatment", async () => {
    const res = await POST(post({ clientSlug: "vitality" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/treatment is required/);
  });

  it("400s an unknown treatment", async () => {
    const res = await POST(post({ clientSlug: "vitality", treatment: "teleportation" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown treatment/);
  });

  it("400s an invalid ctaTarget", async () => {
    const res = await POST(post({ clientSlug: "vitality", treatment: "invisalign", ctaTarget: "phone" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/landing-pages (guards)", () => {
  it("404s an unknown client before touching the DB", async () => {
    const res = await GET(new Request("http://localhost/api/landing-pages?client=nope"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/landing-pages/[id] (guards)", () => {
  const params = Promise.resolve({ id: "some-id" });

  it("rejects an invalid JSON body", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/landing-pages/some-id", { method: "PATCH", body: "{oops" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("404s an unknown client before touching the DB", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/landing-pages/some-id", {
        method: "PATCH",
        body: JSON.stringify({ clientSlug: "nope", action: "publish" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });
});
