// THE IMAGE PROVIDER SEAM.
//
// The recreate flow can generate a creative. Nobody has provisioned an image key
// yet, so the path that MUST be right today is the one where there is no key at
// all: the button still works, the compliant copy is still written, and what comes
// back is an honest "not configured" naming the env var. What must never happen is
// a crash, a placeholder image dressed up as a real one, or the key leaking into a
// URL, a response body or an error string.
//
// `fetch` is INJECTED, so nothing here reaches OpenAI. The module does
// `import "server-only"`, which is stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Higgsfield's client is the alternative provider. Stubbed so this file tests the
// SELECTION and the OpenAI adapter, not somebody else's HTTP.
const hf = vi.hoisted(() => ({
  generateImage: vi.fn(async () => ({ status: "complete" as const, imageUrl: "https://hf.example/x.png" })),
}));
vi.mock("@/lib/higgsfield/client", () => ({ generateImage: hf.generateImage }));

import {
  gptImageProvider,
  higgsfieldProvider,
  selectImageProvider,
  isImageGenConfigured,
  generateCreative,
  gptImageSize,
  NOT_CONFIGURED_MESSAGE,
  OPENAI_IMAGES_URL,
} from "./image-gen";

const PROMPT = "A bright, welcoming dental studio in soft natural light.";

const KEYS = ["OPENAI_API_KEY", "HIGGSFIELD_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A fetch that must never be called. Calling it fails the test by name. */
function forbiddenFetch(): typeof fetch {
  return (async () => {
    throw new Error("the provider was called with no key configured");
  }) as unknown as typeof fetch;
}

/** A fetch returning one JSON body with a given status. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

// ===========================================================================
// 1. NO KEY: the state the platform actually ships in.
// ===========================================================================

describe("with no image key set", () => {
  it("reports itself unconfigured rather than pretending", () => {
    expect(isImageGenConfigured()).toBe(false);
    expect(gptImageProvider().isConfigured()).toBe(false);
    expect(higgsfieldProvider().isConfigured()).toBe(false);
  });

  it("returns not_configured, never throws, and calls no provider at all", async () => {
    const result = await gptImageProvider().generate({ prompt: PROMPT }, { fetchImpl: forbiddenFetch() });
    expect(result.status).toBe("not_configured");
    if (result.status === "not_configured") {
      // The message names the exact thing an owner has to do.
      expect(result.message).toBe(NOT_CONFIGURED_MESSAGE);
      expect(result.message).toContain("OPENAI_API_KEY");
      // And it says the copy survived, because it did.
      expect(result.message).toContain("saved as a draft");
    }
  });

  it("never fabricates an image: there is no imageUrl on the unconfigured result", async () => {
    const result = await generateCreative({ prompt: PROMPT });
    expect(result.status).toBe("not_configured");
    expect(result).not.toHaveProperty("imageUrl");
    // Not a data URI, not a placeholder, not a stock URL. Nothing.
    expect(JSON.stringify(result)).not.toContain("data:image");
    expect(JSON.stringify(result)).not.toContain("http");
  });

  it("still selects a provider, so the honest message has somewhere to come from", () => {
    expect(selectImageProvider().name).toBe("gpt-image-1");
  });
});

// ===========================================================================
// 2. PROVIDER SELECTION.
// ===========================================================================

describe("provider selection", () => {
  it("prefers gpt-image-1 when its key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.HIGGSFIELD_API_KEY = "hf-test";
    expect(selectImageProvider().name).toBe("gpt-image-1");
    expect(isImageGenConfigured()).toBe(true);
  });

  it("falls back to Higgsfield when only its key is present", async () => {
    process.env.HIGGSFIELD_API_KEY = "hf-test";
    expect(selectImageProvider().name).toBe("higgsfield");
    const out = await generateCreative({ prompt: PROMPT });
    expect(out).toEqual({
      status: "complete",
      provider: "higgsfield",
      imageUrl: "https://hf.example/x.png",
    });
  });
});

// ===========================================================================
// 3. THE KEY NEVER LEAVES THE SERVER.
// ===========================================================================

describe("the key", () => {
  it("rides in the Authorization header, never in the URL", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret";
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "AAAA" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await gptImageProvider().generate({ prompt: PROMPT }, { fetchImpl: spy });
    expect(seenUrl).toBe(OPENAI_IMAGES_URL);
    expect(seenUrl).not.toContain("sk-super-secret");
    const headers = (seenInit?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-super-secret");
  });

  it("never echoes the provider's body, so a stray token cannot ride out on an error", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret";
    const result = await gptImageProvider().generate(
      { prompt: PROMPT },
      { fetchImpl: jsonFetch(401, { error: { message: "Incorrect API key sk-super-secret" } }) },
    );
    expect(result.status).toBe("failed");
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("sk-super-secret");
    expect(serialised).toContain("HTTP 401");
  });
});

// ===========================================================================
// 4. REAL FAILURES ARE REPORTED AS FAILURES.
// ===========================================================================

describe("failures are honest, never a silent fake", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });

  it("a network throw becomes a failed result, not an exception", async () => {
    const boom = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const result = await gptImageProvider().generate({ prompt: PROMPT }, { fetchImpl: boom });
    expect(result).toEqual({ status: "failed", provider: "gpt-image-1", error: "socket hang up" });
  });

  it("a 200 with no image is a failure, not a success with an empty URL", async () => {
    const result = await gptImageProvider().generate(
      { prompt: PROMPT },
      { fetchImpl: jsonFetch(200, { data: [] }) },
    );
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("imageUrl");
  });

  it("unparseable JSON is a failure, not a crash", async () => {
    const bad = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await gptImageProvider().generate({ prompt: PROMPT }, { fetchImpl: bad });
    expect(result.status).toBe("failed");
  });

  it("returns a data URI for base64 and the hosted URL when one is given", async () => {
    const b64 = await gptImageProvider().generate(
      { prompt: PROMPT },
      { fetchImpl: jsonFetch(200, { data: [{ b64_json: "QUJD" }] }) },
    );
    expect(b64).toEqual({
      status: "complete",
      provider: "gpt-image-1",
      imageUrl: "data:image/png;base64,QUJD",
    });

    const hosted = await gptImageProvider().generate(
      { prompt: PROMPT },
      { fetchImpl: jsonFetch(200, { data: [{ url: "https://cdn.example/a.png" }] }) },
    );
    expect(hosted).toEqual({
      status: "complete",
      provider: "gpt-image-1",
      imageUrl: "https://cdn.example/a.png",
    });
  });
});

// ===========================================================================
// 5. ASPECT RATIO MAPPING (pure).
// ===========================================================================

describe("gptImageSize", () => {
  it("maps every Meta ratio the builder can produce to a size gpt-image-1 accepts", () => {
    const allowed = new Set(["1024x1024", "1024x1536", "1536x1024"]);
    for (const ratio of ["1:1", "4:5", "9:16", "2:3", "16:9", "1.91:1", "3:2", undefined, "nonsense"]) {
      expect(allowed.has(gptImageSize(ratio)), String(ratio)).toBe(true);
    }
    expect(gptImageSize("9:16")).toBe("1024x1536");
    expect(gptImageSize("16:9")).toBe("1536x1024");
    expect(gptImageSize(undefined)).toBe("1024x1024");
  });
});
