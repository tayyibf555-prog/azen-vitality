import { describe, it, expect } from "vitest";
import { signSession, verifySession, type PbSession } from "./session";

const SECRET = "test-secret-please-rotate";
const future = 10_000_000_000_000;

describe("session cookie", () => {
  const payload: PbSession = { credentialId: "cred-1", maxTier: 4, exp: future };

  it("round-trips a valid token", () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, SECRET)).toEqual(payload);
  });

  it("rejects a tampered token", () => {
    const token = signSession(payload, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = signSession(payload, "other-secret");
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signSession({ ...payload, exp: 1 }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects missing/garbage input", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("nope", SECRET)).toBeNull();
  });
});
