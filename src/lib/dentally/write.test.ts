import { describe, it, expect, vi, afterEach } from "vitest";

// Capture which target the agent client is configured for (the DentallyClient just
// stores its opts).
vi.mock("./client", () => ({
  DentallyClient: class {
    constructor(public opts: { apiKey: string; baseUrl: string; readOnly?: boolean }) {}
  },
}));

import { isDentallyWriteEnabled, dentallyAgentClient, targetsRealDentally } from "./write";

type Configured = { opts: { apiKey: string; baseUrl: string; readOnly?: boolean } };

afterEach(() => vi.unstubAllEnvs());

describe("Dentally write gate (default OFF)", () => {
  it("is DISABLED by default, so the agent client uses the existing read/mock config", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "read-key");
    vi.stubEnv("DENTALLY_BASE_URL", "http://localhost:3000/api/mock-dentally");
    expect(isDentallyWriteEnabled()).toBe(false);
    const c = dentallyAgentClient() as unknown as Configured;
    // Writable against the MOCK, which is a genuine write path (the agent books
    // into /api/mock-dentally in dev and that must keep working).
    expect(c.opts).toEqual({
      apiKey: "read-key",
      baseUrl: "http://localhost:3000/api/mock-dentally",
      readOnly: false,
    });
  });

  it("stays DISABLED when the flag is 'true' but no write key is set", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "true");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    expect(isDentallyWriteEnabled()).toBe(false);
  });

  it("stays DISABLED when a write key is set but the flag is not 'true'", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "write-key");
    expect(isDentallyWriteEnabled()).toBe(false);
  });

  it("stays DISABLED when the flag + key are set but no write base URL (never silently hits production)", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "true");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_WRITE_BASE_URL", "");
    expect(isDentallyWriteEnabled()).toBe(false);
  });

  it("ENABLES only with the flag 'true' AND a write key, targeting the write instance", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "true");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_WRITE_BASE_URL", "https://api.sandbox.dentally.co");
    expect(isDentallyWriteEnabled()).toBe(true);
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts).toEqual({
      apiKey: "write-key",
      baseUrl: "https://api.sandbox.dentally.co",
      readOnly: false,
    });
  });
});

// THE BELT. The DISABLED branch of dentallyAgentClient used to return a fully
// writable client whose base URL falls back to https://api.dentally.co whenever
// DENTALLY_BASE_URL is unset — "writes are disabled" built a client pointed at the
// live practice book, armed. These pin the two halves of the fix: the host test
// itself, and that the disabled branch latches shut whenever it says true.
describe("targetsRealDentally", () => {
  it("is TRUE for real Dentally and every dentally.co subdomain", () => {
    expect(targetsRealDentally("https://api.dentally.co")).toBe(true);
    expect(targetsRealDentally("https://api.sandbox.dentally.co")).toBe(true);
    expect(targetsRealDentally("https://api.dentally.co/v1")).toBe(true);
    expect(targetsRealDentally("HTTPS://API.DENTALLY.CO")).toBe(true);
  });

  it("is FALSE for the local mock, so mock writes keep working", () => {
    expect(targetsRealDentally("http://localhost:3000/api/mock-dentally")).toBe(false);
    expect(targetsRealDentally("https://azen-vitality.vercel.app/api/mock-dentally")).toBe(false);
  });

  it("matches the HOSTNAME, not a substring of the URL", () => {
    // A path that merely contains the string must not read as real Dentally...
    expect(targetsRealDentally("http://localhost:3000/api/mock/dentally.co")).toBe(false);
    // ...and a host that merely starts with it must not read as the mock.
    expect(targetsRealDentally("https://dentally.co.evil.test")).toBe(false);
    expect(targetsRealDentally("https://notdentally.co")).toBe(false);
  });

  it("treats an unparseable base URL as REAL (the safe answer)", () => {
    expect(targetsRealDentally("")).toBe(true);
    expect(targetsRealDentally("api.dentally.co")).toBe(true); // no scheme
    expect(targetsRealDentally("¯\\_(ツ)_/¯")).toBe(true);
  });
});

describe("the disabled branch can never hold a writable client pointed at real Dentally", () => {
  it("LATCHES SHUT when DENTALLY_BASE_URL is unset (the fallback is production)", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "prod-key");
    vi.stubEnv("DENTALLY_BASE_URL", undefined);
    expect(isDentallyWriteEnabled()).toBe(false);
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts.baseUrl).toBe("https://api.dentally.co");
    expect(c.opts.readOnly).toBe(true);
  });

  it("LATCHES SHUT when DENTALLY_BASE_URL is set but EMPTY (?? does not catch it)", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "prod-key");
    vi.stubEnv("DENTALLY_BASE_URL", "");
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts.baseUrl).toBe(""); // ?? only replaces null/undefined
    expect(c.opts.readOnly).toBe(true); // unparseable is treated as real
  });

  it("LATCHES SHUT when DENTALLY_BASE_URL points at real Dentally", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "prod-key");
    vi.stubEnv("DENTALLY_BASE_URL", "https://api.dentally.co");
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts.readOnly).toBe(true);
  });

  it("stays WRITABLE against the mock, so local agent booking is unaffected", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "mock-key");
    vi.stubEnv("DENTALLY_BASE_URL", "http://localhost:3000/api/mock-dentally");
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts.readOnly).toBe(false);
  });
});
