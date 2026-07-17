import { describe, it, expect, vi } from "vitest";

// guard.ts and the cache do `import "server-only"`, which does not resolve under the
// node test env; stub it. Auth is not enforced here (no service-role key), so
// requireUser is a no-op and these tests exercise the input validation that returns
// BEFORE any DB or model call. The cache-hit / fallback behaviour is unit-tested in
// lib/creative/resolve.test.ts (injected cache + mocked model).
vi.mock("server-only", () => ({}));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/creative-analysis", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/creative-analysis (guards)", () => {
  it("400s an invalid JSON body", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
  });

  it("400s an unknown client", async () => {
    const res = await POST(post({ clientSlug: "nope", creativeRef: "adlib-bright-smile-whitening" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown client/i);
  });

  it("400s a missing creativeRef", async () => {
    const res = await POST(post({ clientSlug: "vitality" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/creativeRef is required/i);
  });

  it("404s an unknown creative before touching the model or cache", async () => {
    const res = await POST(post({ clientSlug: "vitality", creativeRef: "adlib-does-not-exist" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/unknown creative/i);
  });
});
