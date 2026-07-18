import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isHiggsfieldConfigured,
  generateImage,
  generateVideo,
  aspectRatioForFormat,
  HIGGSFIELD_BASE_URL,
} from "./client";

const KEY = "HIGGSFIELD_API_KEY";

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

afterEach(() => {
  delete process.env[KEY];
  delete process.env.HIGGSFIELD_IMAGE_MODEL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("higgsfield client: configuration + mapping", () => {
  it("is not configured without the key", () => {
    delete process.env[KEY];
    expect(isHiggsfieldConfigured()).toBe(false);
  });

  it("is configured when the key is present", () => {
    process.env[KEY] = "id:secret";
    expect(isHiggsfieldConfigured()).toBe(true);
  });

  it("maps creative formats to Meta aspect ratios", () => {
    expect(aspectRatioForFormat("reel")).toBe("9:16");
    expect(aspectRatioForFormat("video")).toBe("4:5");
    expect(aspectRatioForFormat("image")).toBe("1:1");
    expect(aspectRatioForFormat("carousel")).toBe("1:1");
  });

  it("exposes the verified base URL", () => {
    expect(HIGGSFIELD_BASE_URL).toBe("https://platform.higgsfield.ai");
  });
});

describe("generateImage", () => {
  it("returns not_configured (never fabricates) when the key is absent", async () => {
    delete process.env[KEY];
    const result = await generateImage("a clean dental studio");
    expect(result.status).toBe("not_configured");
    if (result.status === "not_configured") expect(result.message).toMatch(/HIGGSFIELD_API_KEY/);
  });

  it("returns complete with the image URL on a completed response", async () => {
    process.env[KEY] = "id:secret";
    const fetchFn = mockFetch(() =>
      ok({ status: "completed", request_id: "req-1", images: [{ url: "https://img.example/x.jpg" }] }),
    );
    const result = await generateImage("prompt", { aspectRatio: "9:16" });
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.imageUrl).toBe("https://img.example/x.jpg");
      expect(result.requestId).toBe("req-1");
    }
    // Verifies the exact HTTP shape: platform base URL + "Key" auth scheme + flat body.
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("https://platform.higgsfield.ai/");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Key id:secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({ prompt: "prompt", aspect_ratio: "9:16" });
  });

  it("uses the model slug override from HIGGSFIELD_IMAGE_MODEL", async () => {
    process.env[KEY] = "id:secret";
    process.env.HIGGSFIELD_IMAGE_MODEL = "flux-pro/kontext/max/text-to-image";
    const fetchFn = mockFetch(() => ok({ status: "completed", images: [{ url: "https://img/x.jpg" }] }));
    await generateImage("prompt");
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      "https://platform.higgsfield.ai/flux-pro/kontext/max/text-to-image",
    );
  });

  it("returns failed (honest reason) on a non-ok HTTP status", async () => {
    process.env[KEY] = "id:secret";
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad key" }));
    const result = await generateImage("prompt");
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toMatch(/401/);
  });

  it("returns failed when the network throws", async () => {
    process.env[KEY] = "id:secret";
    mockFetch(() => {
      throw new Error("network down");
    });
    const result = await generateImage("prompt");
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toMatch(/network down/);
  });

  it("returns failed when the response carries no image", async () => {
    process.env[KEY] = "id:secret";
    mockFetch(() => ok({ status: "completed", images: [] }));
    const result = await generateImage("prompt");
    expect(result.status).toBe("failed");
  });
});

describe("generateVideo (second-phase seam, never fabricates)", () => {
  it("returns not_configured without the key", async () => {
    delete process.env[KEY];
    const result = await generateVideo();
    expect(result.status).toBe("not_configured");
  });

  it("returns not_built (honest) when the key is present", async () => {
    process.env[KEY] = "id:secret";
    const result = await generateVideo();
    expect(result.status).toBe("not_built");
    if (result.status === "not_built") expect(result.message).toMatch(/second phase/i);
  });
});
