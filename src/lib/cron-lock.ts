import { serviceClient } from "@/lib/supabase/server";

// Lease-lock for cron jobs so a run never overlaps itself (pg_cron can start the
// next tick before a slow run finishes, or double-fire). Backed by the cron_lock
// table (migration 0022). The acquire is a single atomic conditional UPDATE that
// exactly one caller can win when the prior lease has expired; the lease
// auto-expires so a crashed run never deadlocks the job.

/**
 * Like acquireCronLock, but distinguishes "someone else holds the lease" from
 * "the lock table is unreachable". Callers that must not silently drop work
 * (the inbound agent turn) fail OPEN on `error` — an unserialised turn beats a
 * dropped patient message — while still honouring a genuinely held lease.
 */
export async function tryAcquireLease(
  name: string,
  ttlSeconds: number,
): Promise<"acquired" | "held" | "error"> {
  try {
    const db = serviceClient();
    // Ensure the row exists without disturbing an active lease (ignore on conflict).
    await db.from("cron_lock").upsert({ name }, { onConflict: "name", ignoreDuplicates: true });
    const untilIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const { data, error } = await db
      .from("cron_lock")
      .update({ locked_until: untilIso })
      .eq("name", name)
      .lt("locked_until", new Date().toISOString()) // only if the prior lease expired
      .select("name");
    if (error) return "error";
    return (data?.length ?? 0) > 0 ? "acquired" : "held";
  } catch {
    return "error";
  }
}

/**
 * Try to acquire `name` for `ttlSeconds`. Returns true only if THIS caller won the
 * lease. Fail-safe: returns false on any error (skip the run rather than risk an
 * overlapping double-send) — the right posture for cron sweeps, where the next
 * tick retries anyway.
 */
export async function acquireCronLock(name: string, ttlSeconds: number): Promise<boolean> {
  return (await tryAcquireLease(name, ttlSeconds)) === "acquired";
}

/** Release the lease early (best-effort) so the next tick can run immediately. */
export async function releaseCronLock(name: string): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("cron_lock").update({ locked_until: new Date(0).toISOString() }).eq("name", name);
  } catch {
    // best effort; the lease expires on its own
  }
}
