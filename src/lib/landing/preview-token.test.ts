import { describe, it, expect } from "vitest";
import { mintPreviewToken, verifyPreviewToken } from "./preview-token";

const KEY = "test-preview-key";

describe("landing preview token", () => {
  it("mints a token that verifies for the same page id", () => {
    const token = mintPreviewToken("page-123", KEY);
    expect(token).toBeTruthy();
    expect(verifyPreviewToken(token, "page-123", KEY)).toBe(true);
  });

  it("does not verify a token against a DIFFERENT page id", () => {
    const token = mintPreviewToken("page-123", KEY);
    expect(verifyPreviewToken(token, "page-999", KEY)).toBe(false);
  });

  it("rejects a wrong or empty token", () => {
    expect(verifyPreviewToken("garbage", "page-123", KEY)).toBe(false);
    expect(verifyPreviewToken("", "page-123", KEY)).toBe(false);
    expect(verifyPreviewToken(null, "page-123", KEY)).toBe(false);
  });

  it("returns null / false when no server key is configured (no preview)", () => {
    expect(mintPreviewToken("page-123", undefined)).toBeNull();
    expect(verifyPreviewToken("anything", "page-123", undefined)).toBe(false);
  });
});
