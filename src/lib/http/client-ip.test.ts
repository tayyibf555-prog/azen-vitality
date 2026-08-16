// THE RATE-LIMIT KEY. Every public endpoint's per-IP ceiling is only as real as
// this function: read the wrong hop and the cap caps nothing, because the caller
// chooses the key.

import { describe, it, expect } from "vitest";
import { clientIp, UNKNOWN_CLIENT_IP } from "./client-ip";

function req(headers: Record<string, string>): Request {
  return new Request("https://app.test/anything", { headers });
}

describe("the address a per-IP budget is spent against", () => {
  // MUTATION: take the leftmost x-forwarded-for hop. The browser writes that one,
  // so one flooder mints a fresh allowance per request by changing a header.
  it("keys two spoofed prefixes from one real client to the SAME address", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(req({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).toBe("9.9.9.9");
  });

  // MUTATION: collapse everything to one key "to be safe". Then one abusive client
  // exhausts the allowance for every honest visitor behind the same CDN prefix.
  it("still separates two real clients behind one spoofed prefix", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("1.1.1.1");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 2.2.2.2" }))).toBe("2.2.2.2");
  });

  // MUTATION: check x-forwarded-for first. x-real-ip is the platform's own header
  // and the only one a caller cannot write.
  it("prefers the platform-set x-real-ip over anything forwarded", () => {
    expect(clientIp(req({ "x-real-ip": "192.0.2.10", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe(
      "192.0.2.10",
    );
  });

  it("reads a single-hop x-forwarded-for as that hop", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores empty hops and surrounding whitespace", () => {
    expect(clientIp(req({ "x-forwarded-for": " 1.2.3.4 ,  , 198.51.100.7 ,  " }))).toBe(
      "198.51.100.7",
    );
  });

  it("ignores an x-real-ip that is only whitespace and falls through", () => {
    expect(clientIp(req({ "x-real-ip": "   ", "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
  });

  // MUTATION: return a fresh value per request when there is no header. That hands
  // an unlimited budget to the one caller we know least about.
  it("falls back to a single shared bucket when there is no address at all", () => {
    expect(clientIp(req({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(req({ "x-forwarded-for": " , , " }))).toBe(UNKNOWN_CLIENT_IP);
  });
});
