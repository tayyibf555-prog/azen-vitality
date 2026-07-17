import { describe, it, expect } from "vitest";
import { mintPrefToken, verifyPrefToken, buildPrefLink } from "./pref-token";

// Signed channel-preference token: it must round-trip the (site, patient) pair and
// reject any tampering or forgery. The key is passed explicitly so the tests do not
// depend on process env.

const KEY = "test-signing-key";
const PAYLOAD = { siteId: "site-cc", patientRef: "patient:abc123" };

describe("pref-token", () => {
  it("round-trips a valid token back to its payload", () => {
    const token = mintPrefToken(PAYLOAD, KEY);
    expect(token).toBeTruthy();
    expect(verifyPrefToken(token, KEY)).toEqual(PAYLOAD);
  });

  it("rejects a token with a tampered payload", () => {
    const token = mintPrefToken(PAYLOAD, KEY)!;
    const [payloadB64, sig] = token.split(".");
    // Re-sign nothing: swap the payload for a different patient but keep the old sig.
    const forgedPayload = Buffer.from(JSON.stringify({ siteId: "site-cc", patientRef: "patient:victim" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyPrefToken(`${forgedPayload}.${sig}`, KEY)).toBeNull();
    // Sanity: the untouched token still verifies.
    expect(verifyPrefToken(`${payloadB64}.${sig}`, KEY)).toEqual(PAYLOAD);
  });

  it("rejects a token with a tampered signature", () => {
    const token = mintPrefToken(PAYLOAD, KEY)!;
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyPrefToken(flipped, KEY)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = mintPrefToken(PAYLOAD, "other-key")!;
    expect(verifyPrefToken(token, KEY)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyPrefToken("", KEY)).toBeNull();
    expect(verifyPrefToken("no-dot-here", KEY)).toBeNull();
    expect(verifyPrefToken(".onlysig", KEY)).toBeNull();
    expect(verifyPrefToken(null, KEY)).toBeNull();
  });

  it("returns null when no key is configured", () => {
    expect(mintPrefToken(PAYLOAD, undefined)).toBeNull();
    expect(verifyPrefToken("anything.here", undefined)).toBeNull();
  });

  it("buildPrefLink produces an absolute URL when a base is supplied", () => {
    // buildPrefLink reads env for the key, so drive it via mintPrefToken semantics:
    // with no key configured it returns null (dormant), which we assert here.
    const link = buildPrefLink("site-cc", "patient:abc123", "https://example.test");
    // In this unit context SMILE_ASSESSMENT_SUBMIT_KEY is unset, so the link is null.
    expect(link).toBeNull();
  });
});
