import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Twilio Lookup pre-send validation.
//
// Proves the four behaviours the send path relies on:
//   - DISABLED (default): no cache read, no API call, always valid (dormant).
//   - CACHE HIT: the verdict is served from phone_lookup and the paid API is
//     NEVER re-called.
//   - VERDICTS: a landline/invalid number is valid=false (blockable); a mobile is
//     valid=true; both are cached so we never re-pay to learn them.
//   - FAIL OPEN: any Lookup API error (non-2xx or thrown) returns valid=true, so an
//     outage degrades the cost saving rather than halting genuine sends.
//
// The only mocked dependency is the supabase service client under the cache; the
// Lookup HTTP call is injected via fetchImpl so we can assert it is/ isn't made.

interface CacheRow {
  phone: string;
  valid: boolean;
  line_type: string | null;
  checked_at: string;
}

const store = vi.hoisted(() => ({ rows: [] as CacheRow[], reads: 0, writes: 0 }));

vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "phone_lookup") throw new Error(`unexpected table: ${table}`);
    let eqPhone: string | undefined;
    const builder = {
      select() {
        return builder;
      },
      eq(_col: string, val: string) {
        eqPhone = val;
        return builder;
      },
      async maybeSingle() {
        store.reads += 1;
        const found = store.rows.find((r) => r.phone === eqPhone);
        return { data: found ?? null, error: null };
      },
      async upsert(row: CacheRow) {
        store.writes += 1;
        const idx = store.rows.findIndex((r) => r.phone === row.phone);
        if (idx >= 0) store.rows[idx] = row;
        else store.rows.push(row);
        return { error: null };
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { validateMobile } from "./lookup";

const PHONE = "+447700900123";

/** A Twilio Lookup v2 success response with the given line type. */
function lookupResponse(lineType: string | null, valid = true) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        valid,
        line_type_intelligence: lineType === null ? null : { type: lineType },
      };
    },
    async text() {
      return "";
    },
  } as unknown as Response;
}

beforeEach(() => {
  store.rows.length = 0;
  store.reads = 0;
  store.writes = 0;
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validateMobile", () => {
  it("is DORMANT when disabled: no cache read, no API call, always valid", async () => {
    // TWILIO_LOOKUP_ENABLED not set -> feature off.
    const fetchImpl = vi.fn();
    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ valid: true, lineType: null, source: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).toBe(0); // did not even touch the cache
  });

  it("serves a CACHE HIT without calling the API", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    store.rows.push({ phone: PHONE, valid: true, line_type: "mobile", checked_at: new Date().toISOString() });
    const fetchImpl = vi.fn();

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ valid: true, lineType: "mobile", source: "cache" });
    expect(fetchImpl).not.toHaveBeenCalled(); // the whole point: never re-pay
  });

  it("caches an invalid LANDLINE verdict as valid=false", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const fetchImpl = vi.fn(async () => lookupResponse("landline"));

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: false, lineType: "landline", source: "api" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Verdict is cached, so a repeat send is free.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ phone: PHONE, valid: false, line_type: "landline" });
  });

  it("returns valid=true for a real mobile and caches it", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const fetchImpl = vi.fn(async () => lookupResponse("mobile"));

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, lineType: "mobile", source: "api" });
    expect(store.rows[0]).toMatchObject({ phone: PHONE, valid: true });
  });

  it("FAILS OPEN when the API throws", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ valid: true, lineType: null, source: "api-error" });
    expect(store.writes).toBe(0); // never cache a fail-open guess
  });

  it("FAILS OPEN on a non-2xx response", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, async json() { return {}; }, async text() { return "err"; } }) as unknown as Response);

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toMatchObject({ valid: true, source: "api-error" });
  });

  it("re-validates a STALE cache row (older than the 90-day TTL)", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    store.rows.push({ phone: PHONE, valid: false, line_type: "landline", checked_at: old });
    const fetchImpl = vi.fn(async () => lookupResponse("mobile"));

    const res = await validateMobile(PHONE, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // stale -> re-called
    expect(res).toMatchObject({ valid: true, lineType: "mobile", source: "api" });
  });

  it("returns valid=true for an empty number without any lookup", async () => {
    vi.stubEnv("TWILIO_LOOKUP_ENABLED", "true");
    const fetchImpl = vi.fn();
    const res = await validateMobile("", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ valid: true, source: "no-number" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
