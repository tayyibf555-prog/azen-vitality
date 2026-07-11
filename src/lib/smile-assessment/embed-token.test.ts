import { describe, it, expect } from "vitest";
import { mintSubmitToken, verifySubmitToken } from "./embed-token";

const KEY = "test-submit-key";
const NOW = new Date("2026-07-11T14:30:00Z");

describe("smile assessment page token", () => {
  it("mints and verifies for the same client within the hour", () => {
    const t = mintSubmitToken("vitality", NOW, KEY);
    expect(t).toBeTruthy();
    expect(verifySubmitToken(t, "vitality", NOW, KEY)).toBe(true);
  });

  it("accepts the PREVIOUS hour's token (form open across the boundary)", () => {
    const earlier = new Date(NOW.getTime() - 3_600_000);
    const t = mintSubmitToken("vitality", earlier, KEY);
    expect(verifySubmitToken(t, "vitality", NOW, KEY)).toBe(true);
  });

  it("rejects a token older than two hour-buckets", () => {
    const stale = new Date(NOW.getTime() - 2 * 3_600_000 - 1);
    const t = mintSubmitToken("vitality", stale, KEY);
    expect(verifySubmitToken(t, "vitality", NOW, KEY)).toBe(false);
  });

  it("rejects a token for a different client, a forged value, and length mismatches", () => {
    const t = mintSubmitToken("vitality", NOW, KEY);
    expect(verifySubmitToken(t, "other-practice", NOW, KEY)).toBe(false);
    expect(verifySubmitToken("f".repeat(64), "vitality", NOW, KEY)).toBe(false);
    expect(verifySubmitToken("short", "vitality", NOW, KEY)).toBe(false);
  });

  it("fails closed when no key is configured", () => {
    expect(mintSubmitToken("vitality", NOW, undefined)).toBeNull();
    expect(verifySubmitToken("anything", "vitality", NOW, undefined)).toBe(false);
  });
});
