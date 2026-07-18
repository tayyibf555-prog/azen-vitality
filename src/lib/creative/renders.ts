import "server-only";
import { serviceClient } from "@/lib/supabase/server";

// Supabase-backed store for creative_render rows (migration 0053). Server-only,
// service-role, RLS bypassed like the other post-0012 modules (see cache.ts).
//
// DEFENSIVE BY DESIGN: writes are best-effort and swallow errors so a rendering
// attempt still returns its result to the caller even if the row cannot be written
// (e.g. before migration 0053 is applied, or if Supabase is unreachable). listRenders
// returns [] on any problem. The row is an honest audit trail, not a hard dependency
// of the generation itself.

export type RenderStatus = "pending" | "complete" | "failed" | "not_configured";

export interface CreativeRender {
  id: string;
  clientId: string;
  sourceRef: string | null;
  prompt: string;
  status: RenderStatus;
  imageUrl: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface RenderRow {
  id: string;
  client_id: string;
  source_ref: string | null;
  prompt: string;
  status: RenderStatus;
  image_url: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
}

/** True when Supabase is configured enough to attempt a query. */
function configured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}

function toRender(row: RenderRow): CreativeRender {
  return {
    id: row.id,
    clientId: row.client_id,
    sourceRef: row.source_ref,
    prompt: row.prompt,
    status: row.status,
    imageUrl: row.image_url,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Insert a render row. Best-effort: a failed write just means it is not audited. */
export async function insertRender(render: CreativeRender): Promise<void> {
  if (!configured()) return;
  try {
    await serviceClient()
      .from("creative_render")
      .insert({
        id: render.id,
        client_id: render.clientId,
        source_ref: render.sourceRef,
        prompt: render.prompt,
        status: render.status,
        image_url: render.imageUrl,
        error: render.error,
        created_by: render.createdBy,
        created_at: render.createdAt,
      } satisfies RenderRow);
  } catch {
    // Best-effort audit only.
  }
}

/** Mark a render complete with its image URL. */
export async function markRenderComplete(id: string, imageUrl: string): Promise<void> {
  if (!configured()) return;
  try {
    await serviceClient()
      .from("creative_render")
      .update({ status: "complete", image_url: imageUrl, error: null })
      .eq("id", id);
  } catch {
    // Best-effort.
  }
}

/** Mark a render failed with an honest reason. */
export async function markRenderFailed(id: string, error: string): Promise<void> {
  if (!configured()) return;
  try {
    await serviceClient().from("creative_render").update({ status: "failed", error }).eq("id", id);
  } catch {
    // Best-effort.
  }
}

/** List a practice's renders, newest first. Returns [] on any problem. */
export async function listRenders(clientId: string, limit = 24): Promise<CreativeRender[]> {
  if (!configured()) return [];
  try {
    const { data, error } = await serviceClient()
      .from("creative_render")
      .select("id, client_id, source_ref, prompt, status, image_url, error, created_by, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return (data as RenderRow[]).map(toRender);
  } catch {
    return [];
  }
}
