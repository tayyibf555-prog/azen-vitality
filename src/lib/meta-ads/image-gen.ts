import "server-only";
import { generateImage as higgsfieldGenerate } from "@/lib/higgsfield/client";

// IMAGE-GENERATION PROVIDER ABSTRACTION for the "recreate this ad" flow.
//
// A recreated ad needs a CREATIVE, not only copy. This module is the single seam
// between the recreate route and whichever image model is provisioned, so the route
// never speaks HTTP to a model directly and swapping providers is a one-line change.
//
//   * The PRIMARY provider is OpenAI gpt-image-1, behind OPENAI_API_KEY. The key is
//     SERVER-SIDE only and rides in the Authorization HEADER, never a query string
//     and never a response body (a secret does not leave the server).
//   * Higgsfield stays the ALTERNATIVE provider behind the exact same interface,
//     delegating to the existing, calibrated adapter (src/lib/higgsfield/client.ts).
//     It is the documented seam for later, not the default.
//
// SHIPS HONEST WHEN UNCONFIGURED. With no image key set, the button is still present
// and the flow still writes the compliant COPY as a draft; the image step returns a
// `not_configured` result carrying a clear "connect an image key" message. It NEVER
// fabricates an image and NEVER crashes. Real failures are surfaced honestly.
//
// British English, no dash characters in copy.

/** A discriminated result so the route records exactly what happened, no try/catch. */
export type ImageGenResult =
  | { status: "complete"; provider: string; imageUrl: string }
  | { status: "not_configured"; provider: string; message: string }
  | { status: "failed"; provider: string; error: string };

export interface GenerateCreativeInput {
  /** The final, ALREADY-COMPLIANT image prompt (built from original Vitality copy). */
  prompt: string;
  /** Meta aspect ratio, e.g. "1:1", "9:16", "4:5". Defaults to "1:1". */
  aspectRatio?: string;
}

export interface GenerateCreativeOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** One image model behind a common shape. */
export interface ImageProvider {
  readonly name: string;
  /** True when the provider's key is present (server-side env). */
  isConfigured(): boolean;
  generate(input: GenerateCreativeInput, opts?: GenerateCreativeOptions): Promise<ImageGenResult>;
}

/** The honest "no key" message the button surfaces. Names the exact env var to set. */
export const NOT_CONFIGURED_MESSAGE =
  "Connect an image key to generate the creative. Set OPENAI_API_KEY (gpt-image-1) on the server, or a Higgsfield key, to enable it. Your compliant ad copy has still been written and saved as a draft.";

// ---------------------------------------------------------------------------
// OpenAI gpt-image-1 (the PRIMARY provider).
// ---------------------------------------------------------------------------

/** Verified endpoint for the OpenAI Images API. */
export const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

/**
 * Map a Meta aspect ratio to a gpt-image-1 `size`. gpt-image-1 supports a square and
 * the two 2:3 / 3:2 rectangles (plus "auto"); portrait Meta ratios (9:16, 4:5) map to
 * the tall option and landscape to the wide one. Pure, so it is trivially testable.
 */
export function gptImageSize(aspectRatio: string | undefined): string {
  switch ((aspectRatio ?? "1:1").trim()) {
    case "9:16":
    case "4:5":
    case "2:3":
      return "1024x1536";
    case "16:9":
    case "1.91:1":
    case "3:2":
      return "1536x1024";
    case "1:1":
    default:
      return "1024x1024";
  }
}

interface OpenAiImageResponse {
  data?: { b64_json?: string | null; url?: string | null }[];
}

/** The gpt-image-1 provider. Reads OPENAI_API_KEY only inside `generate`, so the module stays importable anywhere. */
export function gptImageProvider(): ImageProvider {
  return {
    name: "gpt-image-1",
    isConfigured() {
      return Boolean(process.env.OPENAI_API_KEY);
    },
    async generate(input, opts = {}) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return { status: "not_configured", provider: "gpt-image-1", message: NOT_CONFIGURED_MESSAGE };
      const doFetch = opts.fetchImpl ?? fetch;
      try {
        const res = await doFetch(OPENAI_IMAGES_URL, {
          method: "POST",
          headers: {
            // The secret rides in the HEADER, never the URL and never the response.
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-image-1",
            prompt: input.prompt,
            size: gptImageSize(input.aspectRatio),
            n: 1,
          }),
          signal: opts.signal,
        });
        if (!res.ok) {
          // Deliberately terse: we do NOT echo the provider's body, which keeps any
          // stray token or account detail out of our own error surface.
          return { status: "failed", provider: "gpt-image-1", error: `Image generation failed (HTTP ${res.status}).` };
        }
        const payload = (await res.json().catch(() => null)) as OpenAiImageResponse | null;
        const first = payload?.data?.find((d) => d && (d.b64_json || d.url));
        if (first?.b64_json) {
          return { status: "complete", provider: "gpt-image-1", imageUrl: `data:image/png;base64,${first.b64_json}` };
        }
        if (first?.url) {
          return { status: "complete", provider: "gpt-image-1", imageUrl: first.url };
        }
        return { status: "failed", provider: "gpt-image-1", error: "Image generation returned no image." };
      } catch (err) {
        return {
          status: "failed",
          provider: "gpt-image-1",
          error: err instanceof Error ? err.message : "Image generation failed.",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Higgsfield (the ALTERNATIVE provider, kept behind the same interface).
// ---------------------------------------------------------------------------

/**
 * The Higgsfield provider, delegating to the existing, calibrated adapter. It is the
 * documented seam for later: whenever HIGGSFIELD_API_KEY is provisioned instead of (or
 * as a fallback to) OPENAI_API_KEY, this provider is selected with no route change.
 */
export function higgsfieldProvider(): ImageProvider {
  return {
    name: "higgsfield",
    isConfigured() {
      return Boolean(process.env.HIGGSFIELD_API_KEY);
    },
    async generate(input) {
      const result = await higgsfieldGenerate(input.prompt, { aspectRatio: input.aspectRatio ?? "1:1" });
      if (result.status === "complete") {
        return { status: "complete", provider: "higgsfield", imageUrl: result.imageUrl };
      }
      if (result.status === "not_configured") {
        return { status: "not_configured", provider: "higgsfield", message: NOT_CONFIGURED_MESSAGE };
      }
      return { status: "failed", provider: "higgsfield", error: result.error };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection + the one function the route calls.
// ---------------------------------------------------------------------------

/**
 * Pick the active provider: gpt-image-1 when OPENAI_API_KEY is set (the primary),
 * else Higgsfield when its key is set, else gpt-image-1 so its honest not_configured
 * message drives the UI. The route never needs to know which one ran.
 */
export function selectImageProvider(): ImageProvider {
  const gpt = gptImageProvider();
  if (gpt.isConfigured()) return gpt;
  const hf = higgsfieldProvider();
  if (hf.isConfigured()) return hf;
  return gpt;
}

/** True when SOME image provider is configured (drives the button's active state). */
export function isImageGenConfigured(): boolean {
  return gptImageProvider().isConfigured() || higgsfieldProvider().isConfigured();
}

/**
 * Generate a creative from an ALREADY-COMPLIANT prompt, via the active provider. A
 * thin convenience the route calls; the provider does the work. Never throws, never
 * fabricates, never leaks the key.
 */
export async function generateCreative(
  input: GenerateCreativeInput,
  opts?: GenerateCreativeOptions,
): Promise<ImageGenResult> {
  return selectImageProvider().generate(input, opts);
}
