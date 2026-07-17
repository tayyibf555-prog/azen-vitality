import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { CreativeAnalysis } from "./analysis";
import type { AnalysisCache } from "./resolve";

// Supabase-backed AnalysisCache for creative_analysis (migration 0046). Server-only,
// service-role, RLS bypassed like the other post-0012 modules.
//
// DEFENSIVE BY DESIGN: this is a cache, not a source of truth. Every operation is
// best-effort and swallows errors, so the feature keeps working (generating fresh
// each time) even before migration 0046 is applied, or if Supabase is unreachable.
// get() returns null on any problem; put() silently no-ops.

/** True when Supabase is configured enough to attempt a query. */
function configured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}

export const creativeAnalysisCache: AnalysisCache = {
  async get(clientId: string, creativeRef: string): Promise<CreativeAnalysis | null> {
    if (!configured()) return null;
    try {
      const { data, error } = await serviceClient()
        .from("creative_analysis")
        .select("analysis")
        .eq("client_id", clientId)
        .eq("creative_ref", creativeRef)
        .maybeSingle();
      if (error || !data) return null;
      const analysis = (data as { analysis?: unknown }).analysis;
      return analysis && typeof analysis === "object" ? (analysis as CreativeAnalysis) : null;
    } catch {
      return null;
    }
  },

  async put(clientId: string, creativeRef: string, analysis: CreativeAnalysis): Promise<void> {
    if (!configured()) return;
    try {
      await serviceClient()
        .from("creative_analysis")
        .upsert(
          {
            client_id: clientId,
            creative_ref: creativeRef,
            analysis,
            model: analysis.model,
          },
          { onConflict: "client_id,creative_ref" },
        );
    } catch {
      // Best-effort: a failed write just means the next request regenerates.
    }
  },
};
