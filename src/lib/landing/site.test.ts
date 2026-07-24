import { describe, it, expect } from "vitest";
import { resolveEffectiveSite } from "./site";

// Pure over the real SITES fixture (src/lib/mock/clients.ts): getClient/getSites
// are treated as pure data accessors elsewhere in this codebase (see the
// landing-lead route tests), so this suite exercises resolveEffectiveSite against
// the REAL vitality sites (site-cc, site-rv, site-ng) rather than mocking them.

describe("resolveEffectiveSite", () => {
  it("honours a requested site that belongs to the client", () => {
    expect(resolveEffectiveSite("vitality", "site-rv", "site-cc")).toBe("site-rv");
    expect(resolveEffectiveSite("vitality", "site-ng", "site-cc")).toBe("site-ng");
  });

  it("falls back to the page's own site when nothing is requested", () => {
    expect(resolveEffectiveSite("vitality", undefined, "site-cc")).toBe("site-cc");
    expect(resolveEffectiveSite("vitality", null, "site-cc")).toBe("site-cc");
  });

  it("ignores an unknown site id and falls back to the page's own site", () => {
    expect(resolveEffectiveSite("vitality", "not-a-real-site", "site-cc")).toBe("site-cc");
  });

  it("ignores an empty-string request", () => {
    expect(resolveEffectiveSite("vitality", "", "site-cc")).toBe("site-cc");
  });

  it("rejects a real site id that belongs to a DIFFERENT client (forged id)", () => {
    // "site-cc" is a genuine site id, just not one of "some-other-client"'s, so it
    // must not validate merely because it exists somewhere in the system.
    expect(resolveEffectiveSite("some-other-client", "site-cc", "site-rv")).toBe("site-rv");
  });

  it("returns null when neither a valid request nor a page site exist", () => {
    expect(resolveEffectiveSite("vitality", "bogus", null)).toBeNull();
    expect(resolveEffectiveSite("unknown-client", undefined, null)).toBeNull();
  });
});
