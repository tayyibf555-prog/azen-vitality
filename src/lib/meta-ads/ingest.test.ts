import { describe, it, expect } from "vitest";
import {
  ingestAds,
  winningScore,
  deriveKeyword,
  isKeepable,
  hasTemplatePlaceholder,
  dedupKeyFor,
  runtimeDaysFor,
  parseAdDate,
  groupToWinningAd,
  RUNTIME_SATURATION_DAYS,
  VARIANT_SATURATION,
  IRRELEVANT_CTA_TYPES,
  type ApifyAdItem,
} from "./ingest";

// A fixed "now" so every runtime is deterministic.
const NOW = new Date("2026-08-21T00:00:00Z");

/** Minimal raw-ad builder; overrides merge over a keepable default. */
function ad(overrides: Partial<ApifyAdItem> & { snapshot?: Partial<ApifyAdItem["snapshot"]> } = {}): ApifyAdItem {
  const { snapshot, ...rest } = overrides;
  return {
    ad_archive_id: "arch-1",
    page_name: "A Dental Practice",
    page_id: "page-1",
    start_date_formatted: "2026-08-01 08:00:00",
    end_date_formatted: "2026-08-21 07:00:00",
    is_active: true,
    collation_count: 1,
    collation_id: "col-1",
    currency: "GBP",
    publisher_platform: ["FACEBOOK"],
    ad_library_url: "https://www.facebook.com/ads/library/?id=arch-1",
    categories: ["UNKNOWN"],
    ...rest,
    snapshot: {
      page_name: "A Dental Practice",
      cta_text: "Book now",
      cta_type: "BOOK_NOW",
      display_format: "IMAGE",
      link_url: "https://example.com",
      title: "New patients welcome",
      body: { text: "Book your dental implant consultation with our friendly team this week." },
      images: [{ resized_image_url: "https://cdn/img.jpg" }],
      videos: [],
      ...(snapshot as object),
    },
  };
}

// The two anchor fixtures the score design is pinned to. ------------------------

describe("winningScore anchors: a six-month implant ad is high, a two-day ad is low", () => {
  it("the six-month single-variant implant ad scores high", () => {
    const s = winningScore({ runtimeDays: 182, variantCount: 1 });
    // Six months saturates the runtime term (the whole weight of it): 100 * 0.7 = 70.
    expect(s).toBe(70);
    expect(s).toBeGreaterThanOrEqual(65);
  });

  it("the two-day single-variant ad scores low", () => {
    const s = winningScore({ runtimeDays: 2, variantCount: 1 });
    expect(s).toBeLessThanOrEqual(5);
  });

  it("the six-month ad outscores the two-day ad by a wide margin", () => {
    const long = winningScore({ runtimeDays: 182, variantCount: 1 });
    const short = winningScore({ runtimeDays: 2, variantCount: 1 });
    expect(long - short).toBeGreaterThan(60);
  });

  it("end-to-end through the pipeline: implant beats the fresh ad", () => {
    const implant = ad({
      collation_id: "implant-col",
      ad_archive_id: "implant",
      start_date_formatted: "2026-02-20 08:00:00", // ~182 days before NOW
      snapshot: { body: { text: "Full jaw dental implants, fixed price, book your implant consultation." } },
    });
    const fresh = ad({
      collation_id: "fresh-col",
      ad_archive_id: "fresh",
      start_date_formatted: "2026-08-19 08:00:00", // 2 days before NOW
      snapshot: { body: { text: "Teeth whitening offer this week, book your whitening appointment now." } },
    });
    const [first, second] = ingestAds([fresh, implant], { now: NOW });
    expect(first.adArchiveId).toBe("implant");
    expect(first.winningScore).toBeGreaterThan(second.winningScore);
    expect(second.adArchiveId).toBe("fresh");
    expect(second.winningScore).toBeLessThanOrEqual(5);
  });
});

// Score properties. --------------------------------------------------------------

describe("winningScore is bounded, monotonic and saturating", () => {
  it("is clamped to 0..100 even for extreme inputs", () => {
    expect(winningScore({ runtimeDays: -50, variantCount: -3 })).toBe(0);
    expect(winningScore({ runtimeDays: 99999, variantCount: 9999 })).toBe(100);
  });

  it("rises with runtime, holding variants fixed", () => {
    const a = winningScore({ runtimeDays: 30, variantCount: 1 });
    const b = winningScore({ runtimeDays: 90, variantCount: 1 });
    const c = winningScore({ runtimeDays: 180, variantCount: 1 });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("rises with variant count, holding runtime fixed", () => {
    const one = winningScore({ runtimeDays: 90, variantCount: 1 });
    const many = winningScore({ runtimeDays: 90, variantCount: 8 });
    expect(many).toBeGreaterThan(one);
  });

  it("runtime saturates at six months: a year-long ad ties a six-month ad", () => {
    expect(winningScore({ runtimeDays: RUNTIME_SATURATION_DAYS, variantCount: 1 })).toBe(
      winningScore({ runtimeDays: 365, variantCount: 1 }),
    );
  });

  it("variants saturate: beyond the cap adds nothing", () => {
    expect(winningScore({ runtimeDays: 90, variantCount: VARIANT_SATURATION })).toBe(
      winningScore({ runtimeDays: 90, variantCount: VARIANT_SATURATION + 20 }),
    );
  });
});

// Filtering. ---------------------------------------------------------------------

describe("isKeepable drops the pollution and keeps real ads", () => {
  it("keeps a normal ad with real copy and a lead CTA", () => {
    expect(isKeepable(ad())).toBe(true);
  });

  it("drops a dynamic-catalogue template ad ({{...}} copy)", () => {
    expect(hasTemplatePlaceholder("{{product.brand}}")).toBe(true);
    expect(isKeepable(ad({ snapshot: { body: { text: "{{product.brand}} {{product.name}}" } } }))).toBe(false);
  });

  it("drops an ad with no real copy", () => {
    expect(isKeepable(ad({ snapshot: { body: { text: "" } } }))).toBe(false);
    expect(isKeepable(ad({ snapshot: { body: { text: "buy now" } } }))).toBe(false); // < MIN_BODY_LENGTH
  });

  it("drops group-join and other brand/community CTAs", () => {
    for (const cta of IRRELEVANT_CTA_TYPES) {
      expect(isKeepable(ad({ snapshot: { cta_type: cta, body: { text: "Join our lovely community of dental patients today." } } }))).toBe(false);
    }
  });

  it("keeps the dental-tourism lead CTAs (BOOK_TRAVEL / GET_QUOTE) — they are real competitor ads", () => {
    expect(isKeepable(ad({ snapshot: { cta_type: "BOOK_TRAVEL", body: { text: "Affordable dental implants in Turkey, request your free quote today." } } }))).toBe(true);
    expect(isKeepable(ad({ snapshot: { cta_type: "GET_QUOTE", body: { text: "Veneers and crowns abroad, get your personalised quote and plan now." } } }))).toBe(true);
  });

  it("ingestAds filters junk out of the ranked result entirely", () => {
    const good = ad({ collation_id: "good", snapshot: { body: { text: "Straighten your teeth with clear aligners, book a free consultation." } } });
    const template = ad({ collation_id: "tmpl", snapshot: { body: { text: "{{product.name}}" } } });
    const groupJoin = ad({ collation_id: "grp", snapshot: { cta_type: "JOIN_GROUP", body: { text: "Join our dental implant patient support group with 35k members." } } });
    const ranked = ingestAds([good, template, groupJoin], { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].collationId).toBe("good");
  });
});

// Dedup. -------------------------------------------------------------------------

describe("dedup collapses variants of one creative into a single entry", () => {
  it("groups by collation id and counts the variants", () => {
    const variants = [1, 2, 3].map((n) =>
      ad({
        ad_archive_id: `v${n}`,
        collation_id: "same-creative",
        collation_count: 3,
        start_date_formatted: n === 1 ? "2026-05-01 08:00:00" : "2026-08-10 08:00:00",
      }),
    );
    const ranked = ingestAds(variants, { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].variantCount).toBe(3);
    // Runtime spans from the EARLIEST variant's start (the concept's real lifespan).
    expect(ranked[0].runtimeDays).toBe(runtimeDaysFor(variants[0], NOW).runtimeDays);
  });

  it("variant count is the max of the collation count and the rows actually seen", () => {
    // Two rows share a group but claim collation_count 5: trust the larger signal.
    const rows = [
      ad({ ad_archive_id: "a", collation_id: "g", collation_count: 5 }),
      ad({ ad_archive_id: "b", collation_id: "g", collation_count: 5 }),
    ];
    expect(ingestAds(rows, { now: NOW })[0].variantCount).toBe(5);
  });

  it("falls back to page+body when there is no collation id", () => {
    const a = ad({ ad_archive_id: "a", collation_id: null, page_id: "p9", snapshot: { body: { text: "Identical dental copy here for both rows of this ad." } } });
    const b = ad({ ad_archive_id: "b", collation_id: null, page_id: "p9", snapshot: { body: { text: "Identical dental copy here for both rows of this ad." } } });
    expect(dedupKeyFor(a)).toBe(dedupKeyFor(b));
    expect(ingestAds([a, b], { now: NOW })).toHaveLength(1);
  });
});

// Keyword classifier. ------------------------------------------------------------

describe("deriveKeyword tags the treatment from the copy", () => {
  it.each([
    ["Full jaw dental implants, fixed price", "dental-implants"],
    ["Straighten your smile with Invisalign clear aligners", "clear-aligners"],
    ["Composite bonding and veneers for a new smile", "veneers"],
    ["Professional teeth whitening this month", "teeth-whitening"],
    ["Comfortable new dentures fitted", "dentures"],
    ["Book your routine dental check up and examination", "checkup"],
    ["We love animals and sunshine", "general-dentistry"],
  ])("%s -> %s", (text, expected) => {
    expect(deriveKeyword(text)).toBe(expected);
  });
});

// Dates + runtime. ---------------------------------------------------------------

describe("runtime uses now for active ads and the end date for finished ones", () => {
  it("parses the scraper's space-separated UTC timestamps", () => {
    expect(parseAdDate("2026-02-12 08:00:00")?.toISOString()).toBe("2026-02-12T08:00:00.000Z");
    expect(parseAdDate("")).toBeNull();
    expect(parseAdDate(null)).toBeNull();
  });

  it("an active ad runs until now, not its (scrape-date) end field", () => {
    const active = ad({ is_active: true, start_date_formatted: "2026-06-21 00:00:00", end_date_formatted: "2026-07-01 00:00:00" });
    expect(runtimeDaysFor(active, NOW).runtimeDays).toBe(61); // 21 Jun -> 21 Aug
  });

  it("a finished ad runs to its end date", () => {
    const done = ad({ is_active: false, start_date_formatted: "2026-06-01 00:00:00", end_date_formatted: "2026-06-11 00:00:00" });
    expect(runtimeDaysFor(done, NOW).runtimeDays).toBe(10);
  });

  it("a missing start date yields a zero runtime, never a negative or a guess", () => {
    expect(runtimeDaysFor(ad({ start_date_formatted: null }), NOW).runtimeDays).toBe(0);
  });
});

// Mapping fidelity. --------------------------------------------------------------

describe("groupToWinningAd maps the representative creative onto the row shape", () => {
  it("carries the copy, cta, platform, image and library url through", () => {
    const w = groupToWinningAd([ad()], "uk-dental", NOW);
    expect(w.niche).toBe("uk-dental");
    expect(w.bodyText).toContain("implant consultation");
    expect(w.ctaText).toBe("Book now");
    expect(w.publisherPlatform).toEqual(["FACEBOOK"]);
    expect(w.imageUrl).toBe("https://cdn/img.jpg");
    expect(w.adLibraryUrl).toContain("ads/library");
    expect(w.isActive).toBe(true);
    expect(w.endDate).toBeNull(); // active -> open-ended
  });

  it("prefers a video preview image when there is no still image", () => {
    const w = groupToWinningAd(
      [ad({ snapshot: { images: [], videos: [{ video_preview_image_url: "https://cdn/thumb.jpg" }] } })],
      "uk-dental",
      NOW,
    );
    expect(w.imageUrl).toBe("https://cdn/thumb.jpg");
  });
});
