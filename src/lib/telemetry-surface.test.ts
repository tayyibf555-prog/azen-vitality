import { describe, it, expect } from "vitest";
import { surfaceFromPath, OVERVIEW_SURFACE } from "@/lib/telemetry-surface";

// The client-side privacy guarantee: a path reduces to its module FAMILY only, so a
// record id (or any deeper segment) can never leave the browser inside a surface.
describe("surfaceFromPath", () => {
  it("reduces a module path to its family", () => {
    expect(surfaceFromPath("/c/vitality/patients")).toBe("patients");
    expect(surfaceFromPath("/c/vitality/outreach")).toBe("outreach");
  });

  it("drops deeper segments (record ids never ride along)", () => {
    expect(surfaceFromPath("/c/vitality/patients/12345")).toBe("patients");
    expect(surfaceFromPath("/c/vitality/outreach/campaigns/abc-123")).toBe("outreach");
  });

  it("maps the client index to the overview surface", () => {
    expect(surfaceFromPath("/c/vitality")).toBe(OVERVIEW_SURFACE);
    expect(surfaceFromPath("/c/vitality/")).toBe(OVERVIEW_SURFACE);
  });

  it("lower-cases the family", () => {
    expect(surfaceFromPath("/c/vitality/Patients")).toBe("patients");
  });

  it("returns null for non-client-dashboard paths", () => {
    expect(surfaceFromPath("/login")).toBeNull();
    expect(surfaceFromPath("/owner/vitality/practice-brain")).toBeNull();
    expect(surfaceFromPath("/agency")).toBeNull();
    expect(surfaceFromPath("/")).toBeNull();
  });

  it("returns null for empty / missing input", () => {
    expect(surfaceFromPath("")).toBeNull();
    expect(surfaceFromPath(null)).toBeNull();
    expect(surfaceFromPath(undefined)).toBeNull();
  });
});
