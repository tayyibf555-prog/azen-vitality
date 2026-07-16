import { describe, it, expect } from "vitest";
import { assignVariant, variantCookieName, variantCookiePath } from "./assignment";

describe("assignVariant", () => {
  it("honours an existing valid cookie without re-setting it (sticky)", () => {
    expect(assignVariant("a", 0.99)).toEqual({ variant: "a", setCookie: false });
    expect(assignVariant("b", 0.01)).toEqual({ variant: "b", setCookie: false });
  });

  it("assigns a fresh 50/50 bucket and flags it to be set", () => {
    expect(assignVariant(null, 0.2)).toEqual({ variant: "a", setCookie: true });
    expect(assignVariant(undefined, 0.8)).toEqual({ variant: "b", setCookie: true });
    // Boundary: 0.5 rolls to b.
    expect(assignVariant(null, 0.5)).toEqual({ variant: "b", setCookie: true });
  });

  it("re-buckets an invalid/garbage cookie value", () => {
    expect(assignVariant("xyz", 0.1)).toEqual({ variant: "a", setCookie: true });
    expect(assignVariant("", 0.9)).toEqual({ variant: "b", setCookie: true });
  });

  it("a forced winner overrides the cookie and is never re-set", () => {
    expect(assignVariant("a", 0.1, "b")).toEqual({ variant: "b", setCookie: false });
    expect(assignVariant(null, 0.1, "a")).toEqual({ variant: "a", setCookie: false });
  });

  it("ignores an invalid forced value and falls through to normal assignment", () => {
    // @ts-expect-error deliberately invalid forced value
    expect(assignVariant("a", 0.9, "c")).toEqual({ variant: "a", setCookie: false });
  });

  it("builds a page-scoped cookie name and path", () => {
    expect(variantCookieName("abc-123")).toBe("lpv_abc-123");
    expect(variantCookiePath("vitality", "invisalign-9f2a")).toBe("/go/vitality/invisalign-9f2a");
  });
});
