import { describe, it, expect, vi, afterEach } from "vitest";

// Capture which target the agent client is configured for (the DentallyClient just
// stores its opts).
vi.mock("./client", () => ({
  DentallyClient: class {
    constructor(public opts: { apiKey: string; baseUrl: string }) {}
  },
}));

import { isDentallyWriteEnabled, dentallyAgentClient } from "./write";

type Configured = { opts: { apiKey: string; baseUrl: string } };

afterEach(() => vi.unstubAllEnvs());

describe("Dentally write gate (default OFF)", () => {
  it("is DISABLED by default, so the agent client uses the existing read/mock config", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "");
    vi.stubEnv("DENTALLY_API_KEY", "read-key");
    vi.stubEnv("DENTALLY_BASE_URL", "http://localhost:3000/api/mock-dentally");
    expect(isDentallyWriteEnabled()).toBe(false);
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts).toEqual({ apiKey: "read-key", baseUrl: "http://localhost:3000/api/mock-dentally" });
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

  it("ENABLES only with the flag 'true' AND a write key, targeting the write instance", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "true");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_WRITE_BASE_URL", "https://api.sandbox.dentally.co");
    expect(isDentallyWriteEnabled()).toBe(true);
    const c = dentallyAgentClient() as unknown as Configured;
    expect(c.opts).toEqual({ apiKey: "write-key", baseUrl: "https://api.sandbox.dentally.co" });
  });
});
