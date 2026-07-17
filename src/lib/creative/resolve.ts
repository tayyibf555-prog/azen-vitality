// Orchestration for one creative's analysis: cache -> model -> assemble, with a
// deterministic fallback. The model call and the cache are INJECTED (like
// landing/generate-run.ts) so the whole flow is unit-testable without the network,
// the Anthropic SDK, or a database.
//
// Behaviour:
//   1. Unless `regenerate`, return a cached analysis when one exists (no model call).
//   2. Otherwise build the grounded prompt, call the model, and assemble.
//   3. If the model call fails or its reply is unusable, return the deterministic
//      "Quick read" fallback.
//   4. Store ONLY AI-sourced analyses. A fallback is returned but not cached, so the
//      next natural request retries the model rather than pinning a transient miss.

import type { AdLibraryItem } from "@/lib/meta-ads/types";
import {
  buildAnalysisPrompt,
  parseModelAnalysis,
  assembleFromModel,
  fallbackAnalysis,
  type CreativeAnalysis,
} from "./analysis";

/** A single system+user round trip to the model, returning the raw reply text. */
export type CallModel = (system: string, user: string) => Promise<string>;

/** Injected persistence for analyses. Both methods must never throw (best-effort). */
export interface AnalysisCache {
  get(clientId: string, creativeRef: string): Promise<CreativeAnalysis | null>;
  put(clientId: string, creativeRef: string, analysis: CreativeAnalysis): Promise<void>;
}

export interface ResolveInput {
  ad: AdLibraryItem;
  clientId: string;
  regenerate: boolean;
  callModel: CallModel;
  cache: AnalysisCache;
  modelId: string;
}

export interface ResolveResult {
  analysis: CreativeAnalysis;
  /** True when served from the cache (no model call was made). */
  cached: boolean;
}

export async function resolveAnalysis(input: ResolveInput): Promise<ResolveResult> {
  const { ad, clientId, regenerate, callModel, cache, modelId } = input;

  if (!regenerate) {
    const hit = await cache.get(clientId, ad.id).catch(() => null);
    if (hit) return { analysis: hit, cached: true };
  }

  const { system, user } = buildAnalysisPrompt(ad);
  let analysis: CreativeAnalysis;
  try {
    const reply = await callModel(system, user);
    const model = parseModelAnalysis(reply);
    analysis = model ? assembleFromModel(ad, model, modelId) : fallbackAnalysis(ad);
  } catch {
    // Model or network error: fall back to the deterministic Quick read.
    analysis = fallbackAnalysis(ad);
  }

  // Only persist a genuine AI analysis; never pin a fallback in the cache.
  if (analysis.source === "ai") {
    await cache.put(clientId, ad.id, analysis).catch(() => {});
  }

  return { analysis, cached: false };
}
