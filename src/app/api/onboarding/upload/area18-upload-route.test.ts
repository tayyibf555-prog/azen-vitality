// AREA 18: public per-file onboarding upload /api/onboarding/upload.
//
// UNAUTHENTICATED and writes bytes to Storage. We assert:
//   - an unknown practice is rejected,
//   - the content-type allow-list rejects disallowed types,
//   - empty and oversized files are rejected (413 for oversized),
//   - a pre-parse Content-Length far over the cap is rejected as 413,
//   - more than one file per request is rejected,
//   - the stored path lives under onboarding/<clientSlug>/<token>/ and the leaf
//     filename is sanitised (no traversal, forced canonical extension),
//   - the budget guard blocks (429).
//
// Storage + budget seams are mocked; the REAL handler runs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const upload = vi.fn(async (..._a: unknown[]) => ({ error: null as { message: string } | null }));
  return {
    upload,
    serviceClient: vi.fn(() => ({ storage: { from: () => ({ upload }) } })),
    consumeBudget: vi.fn(async (..._a: unknown[]) => true as boolean),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));

import { POST } from "./route";

let ipCounter = 0;
function upReq(
  fields: { clientSlug?: string; file?: File; extraFiles?: File[] },
  headers: Record<string, string> = {},
): Request {
  ipCounter += 1;
  const fd = new FormData();
  if (fields.clientSlug !== undefined) fd.set("clientSlug", fields.clientSlug);
  if (fields.file) fd.append("file", fields.file);
  for (const f of fields.extraFiles ?? []) fd.append("file", f);
  return new Request("http://localhost/api/onboarding/upload", {
    method: "POST",
    headers: { "x-real-ip": `198.51.100.${ipCounter}`, ...headers },
    body: fd,
  });
}

function file(name: string, type: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.upload.mockResolvedValue({ error: null });
  h.consumeBudget.mockResolvedValue(true);
});

describe("onboarding/upload — guards", () => {
  it("rejects an unknown practice", async () => {
    const res = await POST(upReq({ clientSlug: "ghost", file: file("x.pdf", "application/pdf") }));
    expect(res.status).toBe(400);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("returns 429 when the shared budget is exhausted", async () => {
    h.consumeBudget.mockResolvedValueOnce(false);
    const res = await POST(upReq({ clientSlug: "vitality", file: file("x.pdf", "application/pdf") }));
    expect(res.status).toBe(429);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content-type", async () => {
    const res = await POST(upReq({ clientSlug: "vitality", file: file("e.exe", "application/x-msdownload") }));
    expect(res.status).toBe(400);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    const res = await POST(upReq({ clientSlug: "vitality", file: file("empty.pdf", "application/pdf", 0) }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized file with 413", async () => {
    const res = await POST(
      upReq({ clientSlug: "vitality", file: file("big.pdf", "application/pdf", 11 * 1024 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("rejects a body whose Content-Length far exceeds the cap before parsing", async () => {
    const res = await POST(
      upReq(
        { clientSlug: "vitality", file: file("x.pdf", "application/pdf") },
        { "content-length": "99000000" },
      ),
    );
    expect(res.status).toBe(413);
  });

  it("rejects more than one file per request", async () => {
    const res = await POST(
      upReq({
        clientSlug: "vitality",
        file: file("a.pdf", "application/pdf"),
        extraFiles: [file("b.pdf", "application/pdf")],
      }),
    );
    expect(res.status).toBe(400);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("requires a file part", async () => {
    const res = await POST(upReq({ clientSlug: "vitality" }));
    expect(res.status).toBe(400);
  });
});

describe("onboarding/upload — path + filename safety", () => {
  it("stores under onboarding/<clientSlug>/<token>/ with a sanitised, canonical-extension leaf", async () => {
    const res = await POST(
      upReq({ clientSlug: "vitality", file: file("../../../etc/passwd.png", "image/png") }),
    );
    expect(res.status).toBe(200);
    expect(h.upload).toHaveBeenCalledTimes(1);
    const storedPath = h.upload.mock.calls[0]![0] as string;
    expect(storedPath.startsWith("onboarding/vitality/")).toBe(true);
    expect(storedPath).not.toContain(".."); // traversal stripped
    expect(storedPath.endsWith(".png")).toBe(true); // extension forced from validated type
    // path shape: onboarding/vitality/<uuid>/<leaf>.png
    expect(storedPath.split("/")).toHaveLength(4);
    const ref = (await res.json()) as { ok: boolean; file: { path: string; type: string } };
    expect(ref.ok).toBe(true);
    expect(ref.file.path).toBe(storedPath);
    expect(ref.file.type).toBe("image/png");
  });

  it("returns a 500-ish friendly error (never throws) when storage fails", async () => {
    h.upload.mockResolvedValueOnce({ error: { message: "boom" } });
    const res = await POST(upReq({ clientSlug: "vitality", file: file("x.jpg", "image/jpeg") }));
    expect(res.status).toBe(500);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });
});
