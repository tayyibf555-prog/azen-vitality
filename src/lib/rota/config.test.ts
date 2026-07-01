import { describe, it, expect } from "vitest";
import { normaliseConfig, DEFAULT_ROTA_CONFIG } from "./config";

describe("normaliseConfig", () => {
  it("returns the defaults for missing or malformed input", () => {
    expect(normaliseConfig(undefined)).toEqual(DEFAULT_ROTA_CONFIG);
    expect(normaliseConfig(null)).toEqual(DEFAULT_ROTA_CONFIG);
    expect(normaliseConfig("nonsense")).toEqual(DEFAULT_ROTA_CONFIG);
    expect(normaliseConfig({})).toEqual(DEFAULT_ROTA_CONFIG);
  });

  it("keeps valid positive integers", () => {
    const cfg = normaliseConfig({
      rolesNeeded: { dentist: 2, nurse: 1 },
      notifyLeadDays: 10,
      generateWeeksAhead: 3,
    });
    expect(cfg.rolesNeeded).toEqual({ dentist: 2, nurse: 1 });
    expect(cfg.notifyLeadDays).toBe(10);
    expect(cfg.generateWeeksAhead).toBe(3);
  });

  it("truncates fractional integers that stay >= 1", () => {
    const cfg = normaliseConfig({ notifyLeadDays: 7.9, generateWeeksAhead: 2.4 });
    expect(cfg.notifyLeadDays).toBe(7);
    expect(cfg.generateWeeksAhead).toBe(2);
  });

  it("REGRESSION: a fraction that truncates to 0 falls back, never silently 0", () => {
    // 0.5 passes n > 0 but Math.trunc(0.5) === 0; must not store 0 (empty rota).
    const cfg = normaliseConfig({ generateWeeksAhead: 0.5, notifyLeadDays: 0.9 });
    expect(cfg.generateWeeksAhead).toBe(DEFAULT_ROTA_CONFIG.generateWeeksAhead);
    expect(cfg.notifyLeadDays).toBe(DEFAULT_ROTA_CONFIG.notifyLeadDays);
    expect(cfg.generateWeeksAhead).toBeGreaterThan(0);
  });

  it("drops zero, negative, and fractional-to-zero role counts", () => {
    const cfg = normaliseConfig({ rolesNeeded: { dentist: 1, nurse: 0, reception: -2, hygienist: 0.5 } });
    expect(cfg.rolesNeeded).toEqual({ dentist: 1 });
  });

  it("falls back to default roles when none survive validation", () => {
    const cfg = normaliseConfig({ rolesNeeded: { dentist: 0, nurse: -1 } });
    expect(cfg.rolesNeeded).toEqual(DEFAULT_ROTA_CONFIG.rolesNeeded);
  });
});
