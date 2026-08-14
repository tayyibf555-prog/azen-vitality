import { describe, it, expect } from "vitest";
import { mintPatientToken, verifyPatientToken } from "./patient-token";

// Purpose-scoped patient link token: it must round-trip the (site, patient) pair for
// each purpose, reject any tampering or forgery, AND refuse to let a token minted for
// one purpose verify against another. The key is passed explicitly so the tests do
// not depend on process env.

const KEY = "test-signing-key";
const SITE = "site-cc";
const REF = "patient:abc123";

describe("patient-token", () => {
  it("round-trips a valid 'mh' token back to its payload", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, KEY);
    expect(token).toBeTruthy();
    expect(verifyPatientToken(token, "mh", KEY)).toEqual({ siteId: SITE, patientRef: REF });
  });

  it("round-trips a valid 'fp17' token back to its payload", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "fp17" }, KEY);
    expect(token).toBeTruthy();
    expect(verifyPatientToken(token, "fp17", KEY)).toEqual({ siteId: SITE, patientRef: REF });
  });

  it("rejects a token minted for 'mh' when verified as 'fp17'", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, KEY)!;
    expect(verifyPatientToken(token, "fp17", KEY)).toBeNull();
    // Sanity: it still verifies for its own purpose.
    expect(verifyPatientToken(token, "mh", KEY)).toEqual({ siteId: SITE, patientRef: REF });
  });

  it("rejects a token minted for 'fp17' when verified as 'mh'", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "fp17" }, KEY)!;
    expect(verifyPatientToken(token, "mh", KEY)).toBeNull();
    expect(verifyPatientToken(token, "fp17", KEY)).toEqual({ siteId: SITE, patientRef: REF });
  });

  it("rejects a token with a tampered payload", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, KEY)!;
    const [payloadB64, sig] = token.split(".");
    // Swap the payload for a different patient but keep the old sig.
    const forgedPayload = Buffer.from(JSON.stringify({ siteId: SITE, patientRef: "patient:victim", purpose: "mh" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyPatientToken(`${forgedPayload}.${sig}`, "mh", KEY)).toBeNull();
    // Sanity: the untouched token still verifies.
    expect(verifyPatientToken(`${payloadB64}.${sig}`, "mh", KEY)).toEqual({ siteId: SITE, patientRef: REF });
  });

  it("rejects a token whose payload purpose is swapped without re-signing", () => {
    // Attacker takes a valid 'mh' token, rewrites the payload's purpose to 'fp17',
    // and presents it to the fp17 endpoint. Both the prefix AND the signed payload
    // reject this.
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, KEY)!;
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forgedPayload = Buffer.from(JSON.stringify({ siteId: SITE, patientRef: REF, purpose: "fp17" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyPatientToken(`${forgedPayload}.${sig}`, "fp17", KEY)).toBeNull();
  });

  it("rejects a token with a tampered signature", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, KEY)!;
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyPatientToken(flipped, "mh", KEY)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, "other-key")!;
    expect(verifyPatientToken(token, "mh", KEY)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyPatientToken("", "mh", KEY)).toBeNull();
    expect(verifyPatientToken("no-dot-here", "mh", KEY)).toBeNull();
    expect(verifyPatientToken(".onlysig", "mh", KEY)).toBeNull();
    expect(verifyPatientToken(null, "mh", KEY)).toBeNull();
  });

  it("returns null when no key is configured (dev)", () => {
    expect(mintPatientToken({ siteId: SITE, patientRef: REF, purpose: "mh" }, undefined)).toBeNull();
    expect(verifyPatientToken("anything.here", "mh", undefined)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(mintPatientToken({ siteId: "", patientRef: REF, purpose: "mh" }, KEY)).toBeNull();
    expect(mintPatientToken({ siteId: SITE, patientRef: "", purpose: "mh" }, KEY)).toBeNull();
  });
});
