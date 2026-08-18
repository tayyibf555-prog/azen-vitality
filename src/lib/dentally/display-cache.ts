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
 * STALE-WHILE-REVALIDATE (cachedRead only). Once a row exists, an EXPIRED row is
 * still served -- immediately, verbatim, with its own honest "updated at" stamp --
 * while a single background refresh (scheduled so it survives the response return)
 * re-warms it. So no user ever waits on a re-page: the only synchronous compute is
 * the TRUE cold load, when no row exists at all. A pre-warm cron keeps a row present
 * for every active client so even that first load is rare. SWR is confined to
 * cachedRead; getCached (the two-phase Safe reads) stays fresh-only, because those
 * callers must recompute rather than ever draw a stale diary/availability picture.
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
  /** Absolute epoch-ms at which this entry stops being FRESH. Past this instant the
   *  row is STALE, not gone: `get` still returns it so the cache can stale-while-
   *  revalidate (serve it immediately, refresh behind the response). */
  expiresAt: number;
}

/**
 * The cross-instance backing store. Injectable so tests can construct several
 * DisplayCache "instances" that share ONE store, simulating the Fluid Compute fleet.
 * Every method FAILS OPEN.
 *
 * FRESHNESS IS THE CACHE'S JOB, NOT THE STORE'S. `get` returns a row whenever one is
 * PRESENT, regardless of its expiry, and hands back its `expiresAt` untouched; the
 * DisplayCache above compares that against `now` to decide fresh / stale / miss. This
 * is what makes stale-while-revalidate possible: an expired row is still readable, so
 * it can be served instantly while a refresh runs. (Before SWR the store filtered
 * expired rows out at the query, which collapsed "stale" into "miss".) A row only
 * leaves the store by being overwritten (`set`) or invalidated (`deleteByPrefix`).
 */
export interface DisplayCacheStore {
  /** The stored row for (clientId, cacheKey) if one EXISTS, of any age, else null. */
  get(clientId: string, cacheKey: string): Promise<StoredEntry | null>;
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
 * process), the L2 lives in `store`. `now`, `l1Max` and `scheduleBackground` are
 * injectable for tests.
 *
 * `scheduleBackground` runs a stale-while-revalidate refresh AFTER the current read
 * has already returned its stale value. The default is a detached run, which is fine
 * for a plain Node process; the production wiring (read.ts) injects one backed by
 * next/after / waitUntil so the refresh SURVIVES the serverless response return
 * instead of being killed the instant the response is flushed (a bare floating
 * promise is not guaranteed to run past the response on Fluid Compute).
 */
export function createDisplayCache(deps: {
  store: DisplayCacheStore;
  now?: () => number;
  l1Max?: number;
  scheduleBackground?: (task: () => Promise<void>) => void;
}): DisplayCache {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const l1Max = deps.l1Max ?? 300;
  const scheduleBackground =
    deps.scheduleBackground ?? ((task: () => Promise<void>) => void task().catch(() => {}));
  const l1 = new Map<string, L1Entry>();

  // Keys with a stale-while-revalidate refresh already in flight ON THIS INSTANCE.
  // A burst of stale reads for one key must schedule exactly ONE refresh, not one
  // per read — otherwise a cold-ish key would fan a page walk out per navigation.
  const refreshing = new Set<string>();

  // A per-client invalidation generation. `invalidate` (a CONFIRMED write bust)
  // bumps it; a background refresh captures it at schedule time and REFUSES to
  // promote its result if it changed while the refresh was in flight. That is what
  // stops a refresh that read Dentally BEFORE the write from writing its now-stale
  // value back AFTER the invalidation deleted the row — i.e. resurrecting stale.
  // Over-vetoing (any bust for the client cancels any in-flight refresh for it) is
  // safe: the vetoed value simply recomputes on the next read.
  const generation = new Map<string | null, number>();
  const generationOf = (clientId: string | null): number => generation.get(clientId) ?? 0;
  const bumpGeneration = (clientId: string | null): void =>
    void generation.set(clientId, generationOf(clientId) + 1);

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

  // FRESH-ONLY lookup: L1 then L2, honouring absolute expiry at both layers. Returns
  // MISS (not undefined) so a caller can never confuse "not cached" with "cached
  // undefined" -- though nothing stored here is ever undefined. An EXPIRED row is a
  // MISS here: this is the path getCached uses, and the two-phase Safe reads that
  // call getCached must recompute synchronously rather than ever serve stale, so
  // this path deliberately does NOT stale-while-revalidate.
  async function lookupFresh(clientId: string | null, key: string): Promise<unknown | typeof MISS> {
    const nowMs = now();
    const lk = l1KeyOf(clientId, key);
    const hit = l1.get(lk);
    if (hit && hit.expiresAt > nowMs) return hit.value;
    if (hit) l1.delete(lk); // expired
    if (clientId == null) return MISS; // ambiguous tenant: never share via L2
    const entry = await store.get(clientId, key);
    if (entry && entry.expiresAt > nowMs) {
      l1Set(lk, { value: entry.value, expiresAt: entry.expiresAt });
      return entry.value;
    }
    return MISS;
  }

  // STALE-WHILE-REVALIDATE lookup, for cachedRead only. Classifies into:
  //   fresh -> serve, no refresh (today's behaviour for a live entry);
  //   stale -> serve immediately AND the caller fires a background refresh;
  //   miss  -> nothing present, the caller computes synchronously (true cold load).
  // The served stale blob is returned VERBATIM, so it still carries whatever
  // "updated at" stamp it was built with -- an honest, if older, timestamp.
  async function lookupSwr(
    clientId: string | null,
    key: string,
  ): Promise<{ state: "fresh" | "stale"; value: unknown } | { state: "miss" }> {
    const nowMs = now();
    const lk = l1KeyOf(clientId, key);
    const hit = l1.get(lk);
    if (hit && hit.expiresAt > nowMs) return { state: "fresh", value: hit.value };
    if (clientId == null) {
      // Ambiguous tenant: L1 only, never the shared L2. An expired L1 entry is the
      // only possible stale source; otherwise a true miss.
      return hit ? { state: "stale", value: hit.value } : { state: "miss" };
    }
    const entry = await store.get(clientId, key);
    if (entry && entry.expiresAt > nowMs) {
      l1Set(lk, { value: entry.value, expiresAt: entry.expiresAt });
      return { state: "fresh", value: entry.value };
    }
    // Neither layer is fresh. Prefer the L2 row as the stale source when present: it
    // is the cross-instance-shared, most-recently-promoted blob. Fall back to an
    // expired L1 entry, then to a genuine miss. The expired L1 entry is left in place
    // (not deleted) so a refresh storm cannot form -- `refreshing` bounds refreshes
    // to one per key -- and l1Set's eviction reclaims it in time.
    if (entry) return { state: "stale", value: entry.value };
    if (hit) return { state: "stale", value: hit.value };
    return { state: "miss" };
  }

  // Fire a single background refresh for a stale key. Deduped per key on this
  // instance; tenancy-preserving (writes back under the SAME clientId+key); and
  // invalidation-ordered (a confirmed write during the refresh vetoes its promote).
  function scheduleRefresh<T>(
    clientId: string | null,
    key: string,
    fn: () => Promise<T>,
    ttlMs: number,
  ): void {
    const lk = l1KeyOf(clientId, key);
    if (refreshing.has(lk)) return; // a refresh for this key is already in flight
    refreshing.add(lk);
    const genAtStart = generationOf(clientId);
    scheduleBackground(async () => {
      try {
        const value = await fn();
        // Promote ONLY if no invalidation for this client landed since we started.
        // A concurrent bust means our value may predate the write that triggered it;
        // writing it back would resurrect exactly what the bust removed.
        if (generationOf(clientId) === genAtStart) {
          await setCached(clientId, key, value, ttlMs);
        }
      } catch {
        // A failed refresh does NOT promote and does NOT clobber the stale row: the
        // next read serves the same stale value and retries. Same "only a clean read
        // is promoted" rule the two-phase Safe reads apply, here for the refresh.
      } finally {
        refreshing.delete(lk);
      }
    });
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
      const found = await lookupSwr(clientId, key);
      if (found.state === "fresh") return found.value as T;
      if (found.state === "stale") {
        // Serve the stale blob NOW; refresh behind the response so no user waits on
        // a re-page. This is the whole point: a cold/expired instance answers from
        // another instance's last result instantly and re-warms it in the background.
        scheduleRefresh(clientId, key, fn, ttlMs);
        return found.value as T;
      }
      // True cold: nothing to serve, so compute synchronously and promote.
      const value = await fn();
      await setCached(clientId, key, value, ttlMs);
      return value;
    },

    async getCached<T>(clientId: string | null, key: string): Promise<T | undefined> {
      // FRESH-only, never SWR: the two-phase Safe reads own their own recompute and
      // must not be handed a stale blob (a stale diary/availability read would draw a
      // confident wrong day). Expired here reads as a miss, so the caller recomputes.
      const cached = await lookupFresh(clientId, key);
      return cached === MISS ? undefined : (cached as T);
    },

    setCached,

    async invalidate(
      clientId: string | null,
      { prefixes, l1Predicate }: { prefixes: readonly string[]; l1Predicate: (key: string) => boolean },
    ): Promise<void> {
      // Order pin: bump the generation FIRST, so any SWR refresh for this client that
      // is already in flight will fail its promote check and cannot resurrect the row
      // this bust is about to delete. A refresh scheduled AFTER the bump captures the
      // new generation and promotes normally.
      bumpGeneration(clientId);
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
    async get(clientId, cacheKey) {
      try {
        // NO expiry filter: return the row whenever one exists, of ANY age, and hand
        // back its expires_at so the cache can stale-while-revalidate. Filtering
        // expired rows out here would make a stale row indistinguishable from a
        // missing one and defeat SWR (an expired row could then never be served).
        const { data, error } = await serviceClient()
          .from(TABLE)
          .select("value, expires_at")
          .eq("client_id", clientId)
          .eq("cache_key", cacheKey)
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
    async get(clientId: string, cacheKey: string) {
      store.getCalls += 1;
      const row = rows.get(rowKey(clientId, cacheKey));
      if (!row) return null;
      // Present regardless of expiry (the cache decides freshness against `now`, and
      // needs the stale row to serve-while-revalidating). Model jsonb: hand back a
      // freshly-parsed copy, never the live object.
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
