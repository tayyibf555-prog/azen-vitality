// Outreach must be a first-class, gated system: registered in the drain source map
// (so its outbox drains through the one gated choke point) and in the system catalog
// (so the kill switch is fail-closed for it, and the owner can switch it on). This
// guards against a future edit dropping either registration.
import { describe, it, expect } from "vitest";
import { DRAIN_SOURCE_TO_SLUG, SYSTEM_SLUGS, SYSTEM_BY_SLUG, isControllableSystem } from "@/lib/systems/catalog";
import * as outreachRepo from "@/lib/outreach/repository";

describe("outreach drain-source registration", () => {
  it("maps the outreach drain source to the outreach slug", () => {
    expect(DRAIN_SOURCE_TO_SLUG.outreach).toBe("outreach");
  });

  it("exports the full OutboxSource contract the shared drain calls", () => {
    for (const fn of ["listQueuedOutbox", "claimOutbox", "recordOutboxSent", "markOutboxFailed", "markOutboxBlocked"] as const) {
      expect(typeof outreachRepo[fn], `outreach.${fn}`).toBe("function");
    }
  });
});

describe("outreach system-catalog registration", () => {
  it("is a controllable system, so the kill switch is fail-closed for it", () => {
    expect(SYSTEM_SLUGS).toContain("outreach");
    expect(isControllableSystem("outreach")).toBe(true);
    expect(SYSTEM_BY_SLUG.get("outreach")?.label).toBeTruthy();
  });
});
