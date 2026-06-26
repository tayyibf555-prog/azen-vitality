import { describe, it, expect } from "vitest";
import { toE164, normaliseEmail } from "./phone";

describe("toE164", () => {
  it("normalises every common UK format to the same E.164 string", () => {
    const want = "+447700900123";
    for (const input of [
      "07700900123",
      "07700 900123",
      "+44 7700 900123",
      "+447700900123",
      "(07700) 900123",
      "0044 7700 900123",
      "447700900123",
    ]) {
      expect(toE164(input)).toBe(want);
    }
  });

  it("gives the SAME key for a typed national number and Twilio's E.164 (the threading fix)", () => {
    expect(toE164("07700 900123")).toBe(toE164("+447700900123"));
  });

  it("rejects junk so it never reaches Twilio", () => {
    expect(toE164("not a number")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("+")).toBeNull();
    expect(toE164("12")).toBeNull(); // too short
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
  });
});

describe("normaliseEmail", () => {
  it("lowercases + trims a valid email", () => {
    expect(normaliseEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("rejects malformed / injection-y values", () => {
    expect(normaliseEmail("no-at-sign")).toBeNull();
    expect(normaliseEmail("a,b@c.d")).toBeNull(); // comma would break a PostgREST .or()
    expect(normaliseEmail("x@y")).toBeNull(); // no TLD
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
});
