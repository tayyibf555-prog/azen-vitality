import { describe, it, expect } from "vitest";
import {
  SYSTEMS,
  SYSTEM_SLUGS,
  SYSTEM_BY_SLUG,
  DRAIN_SOURCE_TO_SLUG,
  isControllableSystem,
} from "./catalog";
import { CLIENT_NAV } from "@/lib/nav";

describe("systems catalog", () => {
  it("every system slug is a real CLIENT_NAV module", () => {
    const navSlugs = new Set(CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug)));
    for (const s of SYSTEMS) {
      expect(navSlugs.has(s.slug), `${s.slug} is not a known module slug`).toBe(true);
    }
  });

  it("has no duplicate slugs", () => {
    expect(SYSTEM_SLUGS.length).toBe(new Set(SYSTEM_SLUGS).size);
  });

  it("every system carries owner-facing copy for what halts", () => {
    for (const s of SYSTEMS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.halts.length).toBeGreaterThan(0);
      expect(s.group.length).toBeGreaterThan(0);
    }
  });

  it("maps every drain source to a controllable system slug", () => {
    for (const [source, slug] of Object.entries(DRAIN_SOURCE_TO_SLUG)) {
      expect(isControllableSystem(slug), `${source} -> ${slug} not controllable`).toBe(true);
    }
    // The drain has exactly these five outbox sources.
    expect(Object.keys(DRAIN_SOURCE_TO_SLUG).sort()).toEqual(
      ["coordinator", "noshow", "reactivation", "recall", "reviews"].sort(),
    );
    // The tricky remaps are correct.
    expect(DRAIN_SOURCE_TO_SLUG.noshow).toBe("no-show-defence");
    expect(DRAIN_SOURCE_TO_SLUG.coordinator).toBe("treatment-coordinator");
  });

  it("SYSTEM_BY_SLUG resolves and isControllableSystem rejects unknowns", () => {
    expect(SYSTEM_BY_SLUG.get("recall")?.label).toBe("Recall concierge");
    expect(isControllableSystem("recall")).toBe(true);
    expect(isControllableSystem("settings")).toBe(false); // owner tool, not a system
    expect(isControllableSystem("nope")).toBe(false);
  });
});
