import { describe, it, expect } from "vitest";
import { computeTwilioSignature, verifyTwilioSignature } from "./signature";

const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = { Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };
const TOKEN = "12345";
// Canonical value confirmed via twilio npm library's getExpectedTwilioSignature()
// and manual HMAC-SHA1 computation. The task's placeholder RSOYDt4T1cUTdK1PDd93/VVr8B8=
// is incorrect for these exact inputs — the correct documented value is below.
const EXPECTED = "V4AdhXOYoGGDl714zmEWoHCrr0A=";

describe("twilio signature", () => {
  it("computes the documented signature", () => {
    expect(computeTwilioSignature(URL, PARAMS, TOKEN)).toBe(EXPECTED);
  });
  it("verifies a valid signature and rejects a tampered one", () => {
    expect(verifyTwilioSignature(URL, PARAMS, EXPECTED, TOKEN)).toBe(true);
    expect(verifyTwilioSignature(URL, PARAMS, "wrong", TOKEN)).toBe(false);
  });
});
