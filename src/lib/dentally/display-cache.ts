import { serviceClient } from "@/lib/supabase/server";

/**
 * Cross-instance display cache for the expensive live Dentally DISPLAY reads.
 *
 * WHY. read.ts already has an in-process Map (cachedRead) in front of the display
 * reads, which makes REPEAT reads on ONE warm instance instant. Fluid Compute runs
 * many instances, each with its own Map, so a navigation onto a COLD instance
 * re-pages the whole book and a tab walk across a few cold instances can burn a
 * real slice of Dentally's 3,600/hour rate budget. This module adds a SHARED L2
 * (the dentally_display_cache table, migration 0084) that the per-instance Map sits
 * in front of: the first instance to compute a read writes it to L2; every other
 * instance -- cold or warm -- reads it back and calls Dentally ZERO times until the
 * row expires.
 *
 * THREE INVARIANTS, enforced by the design and pinned by display-cache.test.ts:
 *
 *  - TENANCY. Every entry is keyed by (clientId + cache_key), in the L1 map key AND
 *    the L2 row AND the L2 WHERE clause. A read issued for client A can never be
 *    answered with client B's blob: a different clientId is a different row the
 *    query never selects, and a different L1 key the map never returns. A clientId
 *    that cannot be resolved unambiguously (null) is L1-only and never written to
 *    the shared L2, so an unknown-tenant read can never land in a shared bucket.
 *
 *  - DISPLAY ONLY. Nothing in here is booking-availability, sync, or a
 *    write-confirmation read: those never call this module (they use the raw
 *    DentallyClient, or pass their own client). This is a pure store; the boundary
 *    lives at the call sites in read.ts.
 *
 *  - FAIL OPEN. Every store method treats an error as a miss / no-op and never
 *    throws. A cache is a performance optimisation, never a correctness dependency:
 *    a missing table (0084 not applied), a permissions error or a transient blip
 *    just means the caller computes the value live, exactly as it does today.
 */

const TABLE = "dentally_display_cache";

/** One stored entry as it comes back from the shared store. */
export interface StoredEntry {
  value: unknown;
  /** Absolute epoch-ms at which this entry stops being served. */
  expiresAt: number;
}

/**
 * The cross-instance backing store. Injectable so tests can construct several
 * DisplayCache "instances" that share ONE store, simulating the Fluid Compute fleet.
 * Every method FAILS OPEN.
 */
export interface DisplayCacheStore {
  get(clientId: string, cacheKey: string, nowMs: number): Promise<StoredEntry | null>;
  set(clientId: string, cacheKey: string, value: unknown, expiresAtMs: number): Promise<void>;
  /** Delete every row for this client whose cache_key starts with ANY of `prefixes`. */
  deleteByPrefix(clientId: string, prefixes: readonly string[]): Promise<void>;
}

/**
 * The exact transform a value undergoes on its way through a jsonb column: JSON out,
 * JSON back. Exported so the type-integrity tests can assert, per cached shape, that
 * `jsonRoundTrip(value)` deep-equals `value` -- i.e. the shape survives L2. A field
 * that would NOT survive (a real Date, which becomes an ISO string; an `undefined`,
 * which vanishes) makes that test fail, which is the signal to serialise it
 * explicitly rather than let it deserialise to the wrong type on another instance.
 */
export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// L1 key construction. The tenant is encoded INTO the L1 key as a JSON tuple
// [clientId, key], so the client id is an inseparable part of the key -- dropping it
// would let one client read another's L1 entry, which the tenancy test catches. A
// JSON tuple (rather than a delimiter-joined string) is collision-proof even though a
// cache key can carry arbitrary user text: the patient-search key holds the typed
// query, so any plain separator could be forged, and a control-char separator is
// banned by the source-hygiene lint. A null clientId (ambiguous / unknown site set)
// gets its own bucket ([null, key]) and is never promoted to the shared L2.
function l1KeyOf(clientId: string | null, key: string): string {
  return JSON.stringify([clientId, key]);
}
function l1KeyParse(lk: string): { clientId: string | null; key: string } {
  const [clientId, key] = JSON.parse(lk) as [string | null, string];
  return { clientId, key };
}

interface L1Entry {
  value: unknown;
  expiresAt: number;
}

const MISS = Symbol("display-cache-miss");

export interface DisplayCache {
  /** L1 -> L2 -> compute. Caches the computed value in both layers. */
  cachedRead<T>(clientId: string | null, key: string, fn: () => Promise<T>, ttlMs: number): Promise<T>;
  /** Two-phase read for callers with bespoke compute (the diary Safe helpers): the
   *  lookup half. Returns MISS-as-undefined only for values that are themselves not
   *  undefined, so it is safe for the object/array shapes stored here. */
  getCached<T>(clientId: string | null, key: string): Promise<T | undefined>;
  /** Two-phase write half. Writes L1 always; L2 only when clientId is resolved. */
  setCached(clientId: string | null, key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Bust every entry (L1 + L2) for this client that the predicate / prefixes match. */
  invalidate(
    clientId: string | null,
    opts: { prefixes: readonly string[]; l1Predicate: (key: string) => boolean },
  ): Promise<void>;
  /** Introspection for tests. */
  l1Size(): number;
}

/**
 * Build a display cache over a backing store. The L1 map lives here (one per
 * process), the L2 lives in `store`. `now` and `l1Max` are injectable for tests.
 */
export function createDisplayCache(deps: {
  store: DisplayCacheStore;
  now?: () => number;
  l1Max?: number;
}): DisplayCache {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const l1Max = deps.l1Max ?? 300;
  const l1 = new Map<string, L1Entry>();

  function l1Set(lk: string, entry: L1Entry): void {
    l1.set(lk, entry);
    if (l1.size > l1Max) {
      // Bound memory: drop the oldest quarter by expiry.
      const victims = [...l1.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, Math.ceil(l1Max / 4));
      for (const [k] of victims) l1.delete(k);
    }
  }

  // The shared lookup: L1 then L2, honouring absolute expiry at both layers. Returns
  // MISS (not undefined) so a caller can never confuse "not cached" with "cached
  // undefined" -- though nothing stored here is ever undefined.
  async function lookup(clientId: string | null, key: string): Promise<unknown | typeof MISS> {
    const nowMs = now();
    const lk = l1KeyOf(clientId, key);
    const hit = l1.get(lk);
    if (hit && hit.expiresAt > nowMs) return hit.value;
    if (hit) l1.delete(lk); // expired
    if (clientId == null) return MISS; // ambiguous tenant: never share via L2
    const entry = await store.get(clientId, key, nowMs);
    if (entry && entry.expiresAt > nowMs) {
      l1Set(lk, { value: entry.value, expiresAt: entry.expiresAt });
      return entry.value;
    }
    return MISS;
  }

  async function setCached(
    clientId: string | null,
    key: string,
    value: unknown,
    ttlMs: number,
  ): Promise<void> {
    const expiresAt = now() + ttlMs;
    l1Set(l1KeyOf(clientId, key), { value, expiresAt });
    if (clientId == null) return; // ambiguous tenant: L1 only, never the shared L2
    await store.set(clientId, key, value, expiresAt);
  }

  return {
    async cachedRead<T>(
      clientId: string | null,
      key: string,
      fn: () => Promise<T>,
      ttlMs: number,
    ): Promise<T> {
      const cached = await lookup(clientId, key);
      if (cached !== MISS) return cached as T;
      const value = await fn();
      await setCached(clientId, key, value, ttlMs);
      return value;
    },

    async getCached<T>(clientId: string | null, key: string): Promise<T | undefined> {
      const cached = await lookup(clientId, key);
      return cached === MISS ? undefined : (cached as T);
    },

    setCached,

    async invalidate(
      clientId: string | null,
      { prefixes, l1Predicate }: { prefixes: readonly string[]; l1Predicate: (key: string) => boolean },
    ): Promise<void> {
      // L1: drop this client's entries whose ORIGINAL key matches the predicate
      // (site-intersection precise, so an unrelated site's window is not evicted).
      for (const lk of [...l1.keys()]) {
        const parsed = l1KeyParse(lk);
        if (parsed.clientId !== clientId) continue;
        if (l1Predicate(parsed.key)) l1.delete(lk);
      }
      // L2: a client-scoped prefix delete. It over-invalidates WITHIN the client
      // (every window of that read family, not just the intersecting site set),
      // which is safe -- it forces a recompute, never a wrong answer -- and avoids
      // trying to express the site-intersection predicate in SQL.
      if (clientId != null) await store.deleteByPrefix(clientId, prefixes);
    },

    l1Size() {
      return l1.size;
    },
  };
}

/**
 * The production store: the dentally_display_cache table via the service-role
 * client. Every method fails open (an error is a miss / no-op), so the cache never
 * becomes a correctness dependency and the code works whether or not 0084 is applied.
 */
export function supabaseDisplayCacheStore(): DisplayCacheStore {
  return {
    async get(clientId, cacheKey, nowMs) {
      try {
        const { data, error } = await serviceClient()
          .from(TABLE)
          .select("value, expires_at")
          .eq("client_id", clientId)
          .eq("cache_key", cacheKey)
          .gt("expires_at", new Date(nowMs).toISOString())
          .maybeSingle();
        if (error || !data) return null;
        const expiresAt = Date.parse(data.expires_at as string);
        if (!Number.isFinite(expiresAt)) return null;
        return { value: data.value, expiresAt };
      } catch {
        return null;
      }
    },

    async set(clientId, cacheKey, value, expiresAtMs) {
      try {
        await serviceClient()
          .from(TABLE)
          .upsert(
            {
              client_id: clientId,
              cache_key: cacheKey,
              value: value as never,
              computed_at: new Date().toISOString(),
              expires_at: new Date(expiresAtMs).toISOString(),
            },
            { onConflict: "client_id,cache_key" },
          );
      } catch {
        /* fail open */
      }
    },

    async deleteByPrefix(clientId, prefixes) {
      try {
        const client = serviceClient();
        for (const prefix of prefixes) {
          await client.from(TABLE).delete().eq("client_id", clientId).like("cache_key", `${prefix}%`);
        }
      } catch {
        /* fail open */
      }
    },
  };
}

/**
 * An in-memory store that faithfully models jsonb (every stored value is JSON
 * round-tripped on the way in, exactly as the column would do it) and counts its
 * calls. For tests: construct two DisplayCache instances over ONE of these to
 * simulate two serverless instances sharing the table.
 */
export function inMemoryDisplayCacheStore(): DisplayCacheStore & {
  rows: Map<string, { value: unknown; expiresAt: number }>;
  getCalls: number;
  setCalls: number;
} {
  const rows = new Map<string, { value: unknown; expiresAt: number }>();
  const rowKey = (clientId: string, cacheKey: string) => JSON.stringify([clientId, cacheKey]);
  const store = {
    rows,
    getCalls: 0,
    setCalls: 0,
    async get(clientId: string, cacheKey: string, nowMs: number) {
      store.getCalls += 1;
      const row = rows.get(rowKey(clientId, cacheKey));
      if (!row || row.expiresAt <= nowMs) return null;
      // Model jsonb: hand back a freshly-parsed copy, never the live object.
      return { value: jsonRoundTrip(row.value), expiresAt: row.expiresAt };
    },
    async set(clientId: string, cacheKey: string, value: unknown, expiresAtMs: number) {
      store.setCalls += 1;
      rows.set(rowKey(clientId, cacheKey), { value: jsonRoundTrip(value), expiresAt: expiresAtMs });
    },
    async deleteByPrefix(clientId: string, prefixes: readonly string[]) {
      for (const key of [...rows.keys()]) {
        const [c, ck] = JSON.parse(key) as [string, string];
        if (c !== clientId) continue;
        if (prefixes.some((p) => ck.startsWith(p))) rows.delete(key);
      }
    },
  };
  return store;
}
