import { serviceClient } from "@/lib/supabase/server";

/**
 * Atomically consume one unit of a SHARED per-window call budget (api_budget +
 * the consume_rate_budget RPC, migration 0023). Returns true if the call is within
 * `limit` for the current `windowSeconds` window. Unlike an in-process counter
 * this bounds spend across every serverless instance and cannot be bypassed by IP
 * spoofing, so it is the real ceiling for a public AI endpoint's cost.
 *
 * Fails OPEN (returns true) on any DB error so a transient outage degrades the
 * cost cap rather than breaking the user-facing flow.
 */
export async function consumeBudget(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const db = serviceClient();
    const { data, error } = await db.rpc("consume_rate_budget", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return true;
    return data === true;
  } catch {
    return true;
  }
}
