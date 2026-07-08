import "server-only";
import { serviceClient } from "@/lib/supabase/server";

// Persistence for the owner go-live checklist ticks (table getting_started_state,
// migration 0037). Keyed by client so both owners share one view of progress.

const TABLE = "getting_started_state";

/**
 * The ticked items for a client, as { itemKey: true }. Never throws: a read error
 * resolves to an empty map (nothing ticked), so the checklist always renders.
 */
export async function getChecklistState(clientId: string): Promise<Record<string, boolean>> {
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("item_key, checked")
      .eq("client_id", clientId);
    if (error) throw error;
    const out: Record<string, boolean> = {};
    for (const r of (data ?? []) as { item_key: string; checked: boolean }[]) {
      if (r.checked) out[r.item_key] = true;
    }
    return out;
  } catch (err) {
    console.error(`[getting-started] getChecklistState(${clientId}) failed`, err);
    return {};
  }
}

/** Tick or untick one item for a client. Records who ticked it and when. */
export async function setChecklistItem(
  clientId: string,
  itemKey: string,
  checked: boolean,
  checkedBy: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await serviceClient()
    .from(TABLE)
    .upsert(
      {
        client_id: clientId,
        item_key: itemKey,
        checked,
        checked_at: checked ? now : null,
        checked_by: checked ? checkedBy : null,
        updated_at: now,
      },
      { onConflict: "client_id,item_key" },
    );
  if (error) throw error;
}
