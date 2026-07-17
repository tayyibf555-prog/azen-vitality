// HIGGSFIELD image-generation seam. SHIPS DORMANT.
//
// The "Generate branded image" action on a creative is meant to call Higgsfield to
// produce an on-brand still from a prompt plus the practice's brand (name, colours).
// This file exposes the typed interface and the env gate, but DELIBERATELY does not
// call a live endpoint. Here is why, and what is verified:
//
// WHAT IS VERIFIED (from Higgsfield's official Node SDK repo, higgsfield-ai/
// higgsfield-js, checked 2026-07):
//   - Base URL:   https://platform.higgsfield.ai
//   - Auth header: `Authorization: Key KEY_ID:KEY_SECRET`  (NOT a plain Bearer token;
//     third-party aggregators disagree and say "Bearer", which is why we trust only
//     the official SDK here)
//   - A generation request body looks like:
//       { "input": { "prompt": "...", "aspect_ratio": "9:16", ... }, "withPolling": true }
//   - A completed response looks like:
//       { "status": "completed", "request_id": "...", "images": [{ "url": "..." }] }
//
// WHAT IS NOT VERIFIED (and why we do NOT guess):
//   The official SDK's README states plainly that the exact HTTP METHOD and the full
//   URL PATH for a text-to-image request are abstracted inside the SDK's subscribe()
//   call and are "not documented" for raw HTTP. Model slugs seen in the wild
//   (e.g. "flux-pro/kontext/max/text-to-image", "bytedance/seedream/v4/text-to-image")
//   are model identifiers, not confirmed endpoint paths. Our house rules forbid
//   adding the SDK (no new npm deps) and forbid guessing an endpoint. So rather than
//   POST to an unverified URL and ship something that looks wired but 404s, we throw
//   a descriptive error and keep the UI honest ("activates when the key is added").
//
// TO COMPLETE THIS LATER: confirm the full text-to-image endpoint path + method from
// Higgsfield's official API docs (or capture it from the SDK), then implement the
// fetch call below against the verified base URL and auth header. Everything else
// (env gate, input shape, aspect-ratio mapping, UI states) is already in place.
//
// British English, no dash characters.

import type { AdFormat } from "@/lib/meta-ads/types";

/** Verified base URL for the Higgsfield platform API (documentation only today). */
export const HIGGSFIELD_BASE_URL = "https://platform.higgsfield.ai";

export interface BrandedCreativeInput {
  /** The image prompt (what to depict), typically derived from the ad + treatment. */
  prompt: string;
  /** The practice's brand, so the image can be kept on-brand. */
  brand: {
    name: string;
    /** Brand colours as hex or CSS colour strings, most important first. */
    colours: string[];
  };
  /** The creative format, which drives the aspect ratio. */
  format: AdFormat;
}

export interface BrandedCreativeResult {
  /** URL of the generated image. */
  imageUrl: string;
  /** Higgsfield request id, when available, for later reference. */
  requestId?: string;
}

/** True when the Higgsfield key is present. Drives the dormant/active UI state. */
export function higgsfieldConfigured(): boolean {
  return Boolean(process.env.HIGGSFIELD_API_KEY);
}

/** Meta aspect ratio for a creative format (used when the real client is wired). */
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

/**
 * Generate an on-brand image via Higgsfield.
 *
 * DORMANT SEAM: this intentionally throws. It never returns fabricated output and
 * never calls an unverified endpoint (see the file header). When the key is absent
 * it reports "not configured"; when the key is present it reports that the endpoint
 * is not yet wired, so the caller and UI can be honest about why nothing generated.
 */
export async function generateBrandedCreative(
  input: BrandedCreativeInput,
): Promise<BrandedCreativeResult> {
  void input; // the typed input is settled; only the endpoint wiring is outstanding

  if (!higgsfieldConfigured()) {
    throw new Error(
      "Image generation is not configured. Add the HIGGSFIELD_API_KEY environment variable to enable it.",
    );
  }

  // Key present, but the verified endpoint path/method is not available (see header).
  // Do NOT guess a URL here: a future engineer wires the real fetch call against
  // HIGGSFIELD_BASE_URL with the `Authorization: Key KEY_ID:KEY_SECRET` header once
  // the text-to-image endpoint is confirmed from official docs.
  throw new Error(
    "Higgsfield image generation is not yet wired: the text-to-image endpoint could not be verified from official documentation, so it has not been connected. This activates once the endpoint is confirmed.",
  );
}
