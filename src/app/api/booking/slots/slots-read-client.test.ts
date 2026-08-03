// REGRESSION: the PUBLIC availability read must not depend on the Dentally
// WRITE gate.
//
// WHAT HAPPENED. /api/booking/slots used to read through dentallyAgentClient().
// That helper answers with DENTALLY_WRITE_* only while isDentallyWriteEnabled()
// and otherwise falls back to DENTALLY_API_KEY — which is NOT what the rest of
// the app reads with (dentallyReadKey() prefers DENTALLY_PROD_READONLY_API_KEY).
// So removing DENTALLY_WRITE_ENABLED from production swapped the credential
// underneath a pure READ, and the public booking calendar answered 502 on every
// site while the identical availability read still succeeded through the read
// key.
//
// NOTHING IS MODULE-MOCKED HERE, deliberately. The whole defect lived in which
// client the route built from the environment, so a test that stubs the client
// away cannot see it. This drives the REAL route through the REAL
// dentallyFromEnv()/DentallyClient and asserts the credential that actually goes
// out on the wire: the request URL and the Authorization header. A test that
// only asserted `200` would pass under the old wiring too, because with the gate
// ON the old wiring worked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "./route";

const READ_BASE = "https://read.example.test";
const WRITE_BASE = "https://write.example.test";
const READ_KEY = "read-only-key";
const LEGACY_KEY = "legacy-mock-era-key";
const WRITE_KEY = "write-key";

const ENV_KEYS = [
  "DENTALLY_BASE_URL",
  "DENTALLY_API_KEY",
  "DENTALLY_PROD_READONLY_API_KEY",
  "DENTALLY_WRITE_ENABLED",
  "DENTALLY_WRITE_API_KEY",
  "DENTALLY_WRITE_BASE_URL",
] as const;

let saved: Record<string, string | undefined> = {};
let realFetch: typeof globalThis.fetch;

/** Every outgoing request the route made, as {url, authorization}. */
let sent: Array<{ url: string; authorization: string }> = [];

const DAY_MS = 86_400_000;
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  sent = [];
  realFetch = globalThis.fetch;

  // The read pair is GOOD; the legacy fallback pair carries a different key.
  // This mirrors production exactly: DENTALLY_BASE_URL and
  // DENTALLY_PROD_READONLY_API_KEY are what every other live read uses, while
  // DENTALLY_API_KEY is a stale mock-era credential real Dentally rejects.
  process.env.DENTALLY_BASE_URL = READ_BASE;
  process.env.DENTALLY_PROD_READONLY_API_KEY = READ_KEY;
  process.env.DENTALLY_API_KEY = LEGACY_KEY;
  process.env.DENTALLY_WRITE_API_KEY = WRITE_KEY;
  process.env.DENTALLY_WRITE_BASE_URL = WRITE_BASE;

  globalThis.fetch = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    sent.push({ url, authorization: init?.headers?.Authorization ?? "" });
    const body = url.includes("/v1/practitioners")
      ? { practitioners: [{ id: 7, active: true, site_id: "3286d822-68c5-48ff-b1a2-065780dfcd15" }] }
      : { availability: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Drive the route. `from` varies per case so the route's own 30s in-module
 *  cache (keyed site+range) can never answer one case with another's read. */
function get(site: string, from: string): Promise<Response> {
  const qs = new URLSearchParams({ client: "vitality", site, from, to: from });
  return GET(new Request(`http://localhost/api/booking/slots?${qs.toString()}`));
}

describe("GET /api/booking/slots reads through the READ client, whatever the write gate says", () => {
  it("uses the read base URL and the read key when the write gate is OFF", async () => {
    delete process.env.DENTALLY_WRITE_ENABLED;

    const res = await get("site-cc", ymd(1));

    expect(res.status).toBe(200);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(req.url.startsWith(READ_BASE)).toBe(true);
      expect(req.authorization).toBe(`Bearer ${READ_KEY}`);
    }
  });

  it("STILL uses the read base URL and the read key when the write gate is ON", async () => {
    // The exact assertion the old wiring failed: with writes enabled it read
    // through WRITE_BASE/WRITE_KEY, which is what coupled the calendar to the
    // gate in the first place.
    process.env.DENTALLY_WRITE_ENABLED = "true";

    const res = await get("site-rv", ymd(2));

    expect(res.status).toBe(200);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(req.url.startsWith(READ_BASE)).toBe(true);
      expect(req.url.startsWith(WRITE_BASE)).toBe(false);
      expect(req.authorization).toBe(`Bearer ${READ_KEY}`);
    }
  });

  it("never falls back to DENTALLY_API_KEY while the read key is set", async () => {
    // The production failure mode: the gate went off, the read fell back to the
    // legacy key, and real Dentally rejected it.
    delete process.env.DENTALLY_WRITE_ENABLED;

    await get("site-ng", ymd(3));

    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(req.authorization).not.toBe(`Bearer ${LEGACY_KEY}`);
      expect(req.authorization).not.toBe(`Bearer ${WRITE_KEY}`);
    }
  });

  it("flipping the gate does not change one byte of the outgoing read", async () => {
    delete process.env.DENTALLY_WRITE_ENABLED;
    await get("site-cc", ymd(4));
    const gateOff = [...sent];

    sent = [];
    process.env.DENTALLY_WRITE_ENABLED = "true";
    await get("site-cc", ymd(5));
    const gateOn = [...sent];

    expect(gateOff.length).toBe(gateOn.length);
    // Compare everything except the date range, which differs by construction.
    const strip = (r: { url: string; authorization: string }) => ({
      origin: new URL(r.url).origin,
      path: new URL(r.url).pathname,
      authorization: r.authorization,
    });
    expect(gateOn.map(strip)).toEqual(gateOff.map(strip));
  });
});
