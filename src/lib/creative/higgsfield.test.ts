import { describe, it, expect, afterEach } from "vitest";
import {
  higgsfieldConfigured,
  generateBrandedCreative,
  aspectRatioForFormat,
  HIGGSFIELD_BASE_URL,
} from "./higgsfield";

const KEY = "HIGGSFIELD_API_KEY";

afterEach(() => {
  delete process.env[KEY];
});

describe("higgsfield seam (ships dormant)", () => {
  it("is not configured without the key", () => {
    delete process.env[KEY];
    expect(higgsfieldConfigured()).toBe(false);
  });

  it("is configured when the key is present", () => {
    process.env[KEY] = "test-key";
    expect(higgsfieldConfigured()).toBe(true);
  });

  it("throws a NOT CONFIGURED error when the key is absent", async () => {
    delete process.env[KEY];
    await expect(
      generateBrandedCreative({ prompt: "x", brand: { name: "Vitality", colours: ["#000"] }, format: "reel" }),
    ).rejects.toThrow(/not configured/i);
  });

  it("throws a NOT YET WIRED error when the key is present (dormant seam, never fabricates)", async () => {
    process.env[KEY] = "test-key";
    await expect(
      generateBrandedCreative({ prompt: "x", brand: { name: "Vitality", colours: ["#000"] }, format: "reel" }),
    ).rejects.toThrow(/not yet wired/i);
  });

  it("maps creative formats to Meta aspect ratios", () => {
    expect(aspectRatioForFormat("reel")).toBe("9:16");
    expect(aspectRatioForFormat("image")).toBe("1:1");
    expect(aspectRatioForFormat("carousel")).toBe("1:1");
    expect(aspectRatioForFormat("video")).toBe("4:5");
  });

  it("exposes the verified base URL for a future engineer", () => {
    expect(HIGGSFIELD_BASE_URL).toBe("https://platform.higgsfield.ai");
  });
});
