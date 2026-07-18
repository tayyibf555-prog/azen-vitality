import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// NeverBounce pre-send email validation (the exact email mirror of lookup.test.ts).
//
// Proves the behaviours the send path relies on:
//   - DORMANT (default): no cache read, no API call, always valid. DOUBLE-GATED -
//     neither the key alone nor the flag alone activates it.
//   - CACHE HIT: the verdict is served from email_lookup and the paid API is NEVER
//     re-called.
//   - VERDICTS: invalid/disposable are valid=false (blockable); valid/catchall/
//     unknown are valid=true; all are cached so we never re-pay to learn them.
//   - FAIL OPEN: any API error (non-2xx, thrown, or a non-"success" status envelope)
//     returns valid=true, so an outage degrades the cost saving rather than halting
//     genuine sends.
//   - NORMALISATION: case/whitespace variants of one address share one cache row.
//
// The only mocked dependency is the supabase service client under the cache; the
// NeverBounce HTTP call is injected via fetchImpl so we can assert it is/isn't made.

interface CacheRow {
  email: string;
  valid: boolean;
  verdict: string | null;
  checked_at: string;
}

const store = vi.hoisted(() => ({ rows: [] as CacheRow[], reads: 0, writes: 0 }));

vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "email_lookup") throw new Error(`unexpected table: ${table}`);
    let eqEmail: string | undefined;
    const builder = {
      select() {
        return builder;
      },
      eq(_col: string, val: string) {
        eqEmail = val;
        return builder;
      },
      async maybeSingle() {
        store.reads += 1;
        const found = store.rows.find((r) => r.email === eqEmail);
        return { data: found ?? null, error: null };
      },
      async upsert(row: CacheRow) {
        store.writes += 1;
        const idx = store.rows.findIndex((r) => r.email === row.email);
        if (idx >= 0) store.rows[idx] = row;
        else store.rows.push(row);
        return { error: null };
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { validateEmail, emailLookupEnabled } from "./email-lookup";

const EMAIL = "patient@example.com";

/** A NeverBounce v4 single-check response with the given result + envelope status. */
function nbResponse(result: string | null, status = "success") {
  return {
    ok: true,
    status: 200,
    async json() {
      return { status, result };
    },
    async text() {
      return "";
    },
  } as unknown as Response;
}

/** Switch the feature on (BOTH gates), mirroring a configured prod. */
function enable() {
  vi.stubEnv("NEVERBOUNCE_API_KEY", "secret_test");
  vi.stubEnv("EMAIL_LOOKUP_ENABLED", "true");
}

beforeEach(() => {
  store.rows.length = 0;
  store.reads = 0;
  store.writes = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("emailLookupEnabled double gate", () => {
  it("is OFF when neither the key nor the flag is set", () => {
    expect(emailLookupEnabled()).toBe(false);
  });

  it("is OFF with the key alone (a key must NOT activate it)", () => {
    vi.stubEnv("NEVERBOUNCE_API_KEY", "secret_test");
    expect(emailLookupEnabled()).toBe(false);
  });

  it("is OFF with the flag alone (no key = nothing to call)", () => {
    vi.stubEnv("EMAIL_LOOKUP_ENABLED", "true");
    expect(emailLookupEnabled()).toBe(false);
  });

  it("is ON only when BOTH are set", () => {
    enable();
    expect(emailLookupEnabled()).toBe(true);
  });
});

describe("validateEmail", () => {
  it("is DORMANT when disabled: no cache read, no API call, always valid", async () => {
    // Key present but flag unset -> still off (double gate).
    vi.stubEnv("NEVERBOUNCE_API_KEY", "secret_test");
    const fetchImpl = vi.fn();
    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ valid: true, verdict: null, source: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).toBe(0); // did not even touch the cache
  });

  it("serves a CACHE HIT without calling the API", async () => {
    enable();
    store.rows.push({ email: EMAIL, valid: true, verdict: "valid", checked_at: new Date().toISOString() });
    const fetchImpl = vi.fn();

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ valid: true, verdict: "valid", source: "cache" });
    expect(fetchImpl).not.toHaveBeenCalled(); // the whole point: never re-pay
  });

  it("caches an INVALID verdict as valid=false", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("invalid"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: false, verdict: "invalid", source: "api" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Verdict is cached, so a repeat send is free.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ email: EMAIL, valid: false, verdict: "invalid" });
  });

  it("caches a DISPOSABLE verdict as valid=false", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("disposable"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: false, verdict: "disposable", source: "api" });
    expect(store.rows[0]).toMatchObject({ email: EMAIL, valid: false, verdict: "disposable" });
  });

  it("passes a CATCHALL verdict (fail-open posture, valid=true)", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("catchall"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, verdict: "catchall", source: "api" });
    expect(store.rows[0]).toMatchObject({ email: EMAIL, valid: true, verdict: "catchall" });
  });

  it("passes an UNKNOWN verdict (fail-open posture, valid=true)", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("unknown"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, verdict: "unknown", source: "api" });
  });

  it("returns valid=true for a real mailbox and caches it", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("valid"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, verdict: "valid", source: "api" });
    expect(store.rows[0]).toMatchObject({ email: EMAIL, valid: true });
  });

  it("FAILS OPEN when the API throws", async () => {
    enable();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ valid: true, verdict: null, source: "api-error" });
    expect(store.writes).toBe(0); // never cache a fail-open guess
  });

  it("FAILS OPEN on a non-2xx response", async () => {
    enable();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, async json() { return {}; }, async text() { return "err"; } }) as unknown as Response);

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, source: "api-error" });
    expect(store.writes).toBe(0);
  });

  it("FAILS OPEN on a non-\"success\" status envelope (e.g. auth_failure)", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse(null, "auth_failure"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, verdict: null, source: "api-error" });
    expect(store.writes).toBe(0); // an API-level error is not a delivery verdict
  });

  it("re-validates a STALE cache row (older than the 90-day TTL)", async () => {
    enable();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    store.rows.push({ email: EMAIL, valid: false, verdict: "invalid", checked_at: old });
    const fetchImpl = vi.fn(async () => nbResponse("valid"));

    const res = await validateEmail(EMAIL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // stale -> re-called
    expect(res).toMatchObject({ valid: true, verdict: "valid", source: "api" });
  });

  it("returns valid=true for an empty/unparseable address without any lookup", async () => {
    enable();
    const fetchImpl = vi.fn();
    const res = await validateEmail("", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ valid: true, source: "no-address" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("NORMALISES: case/whitespace variants hit the SAME cache row (one paid call)", async () => {
    enable();
    const fetchImpl = vi.fn(async () => nbResponse("valid"));

    // First call with a messy form performs the paid lookup and caches by the
    // normalised address.
    const first = await validateEmail("  Patient@Example.COM ", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(first).toMatchObject({ valid: true, source: "api" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].email).toBe(EMAIL); // stored lowercased + trimmed

    // A second call in a different case is served from that same row - no re-call.
    const second = await validateEmail("PATIENT@EXAMPLE.COM", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(second).toMatchObject({ valid: true, source: "cache" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the first form paid
  });
});
