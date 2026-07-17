import { describe, it, expect, vi } from "vitest";
import type { AdLibraryItem } from "@/lib/meta-ads/types";
import type { CreativeAnalysis } from "./analysis";
import { resolveAnalysis, type AnalysisCache } from "./resolve";

function ad(): AdLibraryItem {
  return {
    id: "adlib-test",
    advertiser: "Test Dental",
    location: "Manchester",
    treatment: "Teeth whitening",
    format: "reel",
    objective: "Leads",
    headline: "A brighter smile before your big day",
    primaryText: "Professional whitening. Book a checkup and we will include whitening. Suitability confirmed at your visit.",
    offer: "Whitening included with a checkup",
    hookType: "Outcome-first",
    daysRunning: 96,
    estPerformance: "strong",
    aiAnalysis: "n/a",
    complianceFlag: null,
  };
}

const VALID_REPLY = JSON.stringify({
  overallScore: 82,
  verdict: "Strong",
  factors: { hook: 85, offerClarity: 80, credibility: 78, callToAction: 75, audienceFit: 80 },
  why: ["The hook leads with the outcome", "The offer is concrete", "It has run 96 days"],
  watchOuts: ["Adapt to your brand"],
});

/** In-memory cache double. */
function memoryCache(): AnalysisCache & { store: Map<string, CreativeAnalysis> } {
  const store = new Map<string, CreativeAnalysis>();
  return {
    store,
    async get(clientId, ref) {
      return store.get(`${clientId}:${ref}`) ?? null;
    },
    async put(clientId, ref, analysis) {
      store.set(`${clientId}:${ref}`, analysis);
    },
  };
}

describe("resolveAnalysis", () => {
  it("MISS: generates via the model, stores it, returns source ai", async () => {
    const cache = memoryCache();
    const callModel = vi.fn().mockResolvedValue(VALID_REPLY);
    const res = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "claude-sonnet-5" });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(res.cached).toBe(false);
    expect(res.analysis.source).toBe("ai");
    expect(cache.store.size).toBe(1);
  });

  it("HIT: a second call serves the cache and does NOT call the model", async () => {
    const cache = memoryCache();
    const callModel = vi.fn().mockResolvedValue(VALID_REPLY);
    await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });
    const second = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });

    expect(callModel).toHaveBeenCalledTimes(1); // not called again
    expect(second.cached).toBe(true);
    expect(second.analysis.source).toBe("ai");
  });

  it("REGENERATE: forces a fresh model call even when cached", async () => {
    const cache = memoryCache();
    const callModel = vi.fn().mockResolvedValue(VALID_REPLY);
    await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });
    const regen = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: true, callModel, cache, modelId: "m" });

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(regen.cached).toBe(false);
  });

  it("MODEL FAILURE: falls back to the deterministic Quick read and does NOT cache it", async () => {
    const cache = memoryCache();
    const callModel = vi.fn().mockRejectedValue(new Error("model down"));
    const res = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });

    expect(res.analysis.source).toBe("fallback");
    expect(res.cached).toBe(false);
    expect(cache.store.size).toBe(0); // fallbacks are never pinned
  });

  it("UNUSABLE REPLY: junk from the model also falls back to Quick read", async () => {
    const cache = memoryCache();
    const callModel = vi.fn().mockResolvedValue("sorry, I cannot do that");
    const res = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });

    expect(res.analysis.source).toBe("fallback");
    expect(cache.store.size).toBe(0);
  });

  it("survives a throwing cache.get (best-effort) and still generates", async () => {
    const cache: AnalysisCache = {
      async get() {
        throw new Error("db down");
      },
      async put() {
        /* no-op */
      },
    };
    const callModel = vi.fn().mockResolvedValue(VALID_REPLY);
    const res = await resolveAnalysis({ ad: ad(), clientId: "vitality", regenerate: false, callModel, cache, modelId: "m" });
    expect(res.analysis.source).toBe("ai");
  });
});
