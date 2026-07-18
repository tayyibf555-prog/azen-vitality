// HIGGSFIELD image-generation client. SHIPS DORMANT until HIGGSFIELD_API_KEY lands.
//
// This is the single adapter for turning a text prompt into an on-brand still. It is
// used by the "recreate this ad with your branding" flow (POST /api/creative-recreate).
// It never fabricates an image: without the key it returns a `not_configured` result;
// on any real failure it returns a `failed` result carrying the honest reason.
//
// -----------------------------------------------------------------------------------
// EXACT HTTP SHAPE (isolated in higgsfieldTextToImage below).
// Source: Higgsfield official docs, https://docs.higgsfield.ai/docs/llms-full.txt
// (checked 2026-07), cross-read against the official Node SDK repo higgsfield-ai/
// higgsfield-js. Confirmed by the docs:
//   - Base URL:    https://platform.higgsfield.ai
//   - Method+path: POST /{model_id}     (e.g. /higgsfield-ai/soul/standard)
//   - Auth header: `Authorization: Key KEY_ID:KEY_SECRET`  (NOT a plain Bearer token;
//     third-party aggregators say "Bearer" against api.higgsfield.ai, which the
//     official SDK contradicts, so we trust only the official docs/SDK here)
//   - Request body (flat JSON): { "prompt": "...", "aspect_ratio": "9:16", "resolution": "720p" }
//   - Completed response:
//       { "status": "completed", "request_id": "...", "status_url": "...",
//         "images": [{ "url": "..." }] }
//
// CALIBRATION WHEN THE KEY ARRIVES (a 5-minute job, no code restructure):
//   1. Set HIGGSFIELD_API_KEY to the "KEY_ID:KEY_SECRET" pair.
//   2. Confirm the text-to-image model slug. The docs example uses
//      "higgsfield-ai/soul/standard" (our default); the SDK also exposes
//      "flux-pro/kontext/max/text-to-image". Override with HIGGSFIELD_IMAGE_MODEL
//      if the account is provisioned for a different model.
//   3. Confirm whether the account returns "completed" synchronously or requires
//      polling the status_url; both paths are already handled below.
//
// British English, no dash characters in copy.

import type { AdFormat } from "@/lib/meta-ads/types";

/** Verified base URL for the Higgsfield platform API. */
export const HIGGSFIELD_BASE_URL = "https://platform.higgsfield.ai";

/**
 * Default text-to-image model slug (the path segment after the base URL). The docs
 * example uses "higgsfield-ai/soul/standard"; override per account with the
 * HIGGSFIELD_IMAGE_MODEL environment variable. This is the primary calibration knob.
 */
export const DEFAULT_IMAGE_MODEL = "higgsfield-ai/soul/standard";

export interface GenerateImageOptions {
  /** Meta aspect ratio, e.g. "1:1", "9:16", "4:5". Defaults to "1:1". */
  aspectRatio?: string;
  /** Output resolution hint, e.g. "720p", "1080p". Defaults to "1080p". */
  resolution?: string;
  /** Model slug override (else HIGGSFIELD_IMAGE_MODEL, else DEFAULT_IMAGE_MODEL). */
  model?: string;
  /** Optional abort signal for the request. */
  signal?: AbortSignal;
}

/**
 * Result of an image generation attempt. A discriminated union so callers (and the
 * creative_render row) can record exactly what happened without try/catch control flow.
 */
export type GenerateImageResult =
  | { status: "complete"; imageUrl: string; requestId?: string }
  | { status: "not_configured"; message: string }
  | { status: "failed"; error: string };

/** Result of a video generation attempt (second-phase seam, not built yet). */
export type GenerateVideoResult =
  | { status: "not_configured"; message: string }
  | { status: "not_built"; message: string };

/** True when the Higgsfield key is present. Drives the dormant/active UI state. */
export function isHiggsfieldConfigured(): boolean {
  return Boolean(process.env.HIGGSFIELD_API_KEY);
}

/** Meta aspect ratio for a creative format (drives the image composition). */
export function aspectRatioForFormat(format: AdFormat): string {
  switch (format) {
    case "reel":
      return "9:16";
    case "video":
      return "4:5";
    case "image":
    case "carousel":
    default:
      return "1:1";
  }
}

const NOT_CONFIGURED_MESSAGE =
  "Image generation is not configured. Add the HIGGSFIELD_API_KEY environment variable to enable it.";

/**
 * The ONE function that speaks raw HTTP to Higgsfield. See the file header for the
 * verified shape and the source. Kept isolated so the calibration when the key lands
 * touches only this function. Assumes the key is present (checked by the caller).
 */
async function higgsfieldTextToImage(
  prompt: string,
  opts: GenerateImageOptions,
): Promise<{ imageUrl: string; requestId?: string }> {
  const key = process.env.HIGGSFIELD_API_KEY as string;
  const model = opts.model || process.env.HIGGSFIELD_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The key env var holds the "KEY_ID:KEY_SECRET" pair; the scheme word is "Key".
    Authorization: `Key ${key}`,
    "User-Agent": "higgsfield-server-js/2.0",
  };
  const body = JSON.stringify({
    prompt,
    aspect_ratio: opts.aspectRatio || "1:1",
    resolution: opts.resolution || "1080p",
  });

  const res = await fetch(`${HIGGSFIELD_BASE_URL}/${model}`, {
    method: "POST",
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Higgsfield returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  let payload = (await res.json().catch(() => null)) as HiggsfieldResponse | null;
  // Some accounts return "completed" synchronously; others return a pending job with a
  // status_url to poll. Handle both, bounded so a stuck job cannot hang the request.
  payload = await settleIfPending(payload, headers, opts.signal);

  const status = payload?.status;
  const url = payload?.images?.find((i) => i && typeof i.url === "string")?.url;
  if (status === "completed" && url) {
    return { imageUrl: url, requestId: payload?.request_id };
  }
  if (status === "failed") {
    throw new Error("Higgsfield reported the generation failed.");
  }
  throw new Error("Higgsfield returned no image for this request.");
}

interface HiggsfieldResponse {
  status?: string;
  request_id?: string;
  status_url?: string;
  images?: { url?: string }[];
}

/** Poll a pending job's status_url a bounded number of times until it settles. */
async function settleIfPending(
  payload: HiggsfieldResponse | null,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<HiggsfieldResponse | null> {
  const terminal = new Set(["completed", "failed", "canceled", "cancelled"]);
  let current = payload;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = current?.status;
    const statusUrl = current?.status_url;
    if (!status || terminal.has(status) || !statusUrl) return current;
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(statusUrl, { headers, signal });
    if (!res.ok) return current;
    current = (await res.json().catch(() => current)) as HiggsfieldResponse | null;
  }
  return current;
}

/**
 * Generate an on-brand image from a prompt via Higgsfield.
 *
 * Never fabricates output. Returns `not_configured` when the key is absent, `complete`
 * with the image URL on success, or `failed` with an honest reason on any error.
 */
export async function generateImage(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  if (!isHiggsfieldConfigured()) {
    return { status: "not_configured", message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    const { imageUrl, requestId } = await higgsfieldTextToImage(prompt, opts);
    return { status: "complete", imageUrl, requestId };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "Image generation failed.",
    };
  }
}

/**
 * SECOND-PHASE SEAM: AI video / UGC generation. Not built yet, by design (the first
 * phase ships branded stills only). This exists so callers and the UI can be honest
 * that video is coming later, without pretending it works. It never fabricates output.
 */
export async function generateVideo(): Promise<GenerateVideoResult> {
  if (!isHiggsfieldConfigured()) {
    return { status: "not_configured", message: NOT_CONFIGURED_MESSAGE };
  }
  return {
    status: "not_built",
    message: "AI video generation arrives as a second phase. It is not available yet.",
  };
}
