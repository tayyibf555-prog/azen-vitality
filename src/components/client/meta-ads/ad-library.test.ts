import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdLibrary } from "./ad-library";
import { winningSignal, runtimeDuration, keywordLabel, ctaLabel } from "./format";
import type { StoredWinningAd } from "@/lib/meta-ads/winning-repository";

// RENDER PINS for the winning-ads library after the swap from the curated mock to
// the REAL store (migration 0088). vitest collects only src/**/*.test.ts in the node
// environment, so this renders the ("use client") component with react-dom/server:
// effects never fire in a static render, so the thumbnail's onError fallback is not
// exercised here and every assertion is about MARKUP. These lock the three things
// that must stay true: a populated grid shows real advertisers + honest signals + a
// real outbound link, an empty store says so and shows NO fabricated ads, and the
// sourcing note keeps the competitor-vs-your-own-performance distinction visible.

function ad(over: Partial<StoredWinningAd> = {}): StoredWinningAd {
  return {
    id: "wa-1",
    niche: "uk-dental",
    keyword: "dental-implants",
    dedupKey: "c:123",
    collationId: "123",
    adArchiveId: "999",
    collationCount: 4,
    variantCount: 4,
    pageName: "Banning Dental & Skin Clinique",
    pageId: "p1",
    title: "Rethink your smile",
    bodyText: "One photo is all it takes to make you rethink your smile.",
    ctaText: "Book Now",
    ctaType: "BOOK_TRAVEL",
    linkUrl: "https://example.com",
    displayFormat: "IMAGE",
    publisherPlatform: ["FACEBOOK", "INSTAGRAM"],
    imageUrl: "https://scontent.example.com/pic.jpg?oe=1234ABCD",
    currency: "GBP",
    startDate: "2025-01-01T00:00:00.000Z",
    endDate: null,
    isActive: true,
    runtimeDays: 180,
    categories: [],
    adLibraryUrl: "https://www.facebook.com/ads/library/?id=999",
    winningScore: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function render(ads: StoredWinningAd[], imageGenConfigured = true): string {
  return renderToStaticMarkup(
    createElement(AdLibrary, { winningAds: ads, clientSlug: "vitality", imageGenConfigured }),
  );
}

describe("AdLibrary — populated", () => {
  const html = render([
    ad(),
    ad({
      id: "wa-2",
      keyword: "teeth-whitening",
      pageName: "Bright Smile Dental",
      title: "A brighter smile",
      bodyText: "Professional whitening, gentler than shop-bought kits.",
      ctaText: null,
      ctaType: null,
      imageUrl: null,
      displayFormat: "VIDEO",
      isActive: false,
      runtimeDays: 96,
      variantCount: 1,
      adLibraryUrl: null,
      winningScore: 70,
    }),
  ]);

  it("shows the real advertiser (page_name), not a mock one", () => {
    expect(html).toContain("Banning Dental &amp; Skin Clinique");
    expect(html).toContain("Bright Smile Dental");
    // The mock library's advertisers must be gone.
    expect(html).not.toContain("SmileCare Studio");
    expect(html).not.toContain("The Implant Clinic");
  });

  it("states the honest winning signal (runtime + variants)", () => {
    expect(html).toContain("Running 6 months, 4 variants");
    // Ended, single-variant ad drops the variant clause and uses the past tense.
    expect(html).toContain("Ran 3 months");
    expect(html).not.toContain("Ran 3 months, 1 variants");
  });

  it("renders the ad copy (title + body) and the CTA", () => {
    expect(html).toContain("Rethink your smile");
    expect(html).toContain("One photo is all it takes");
    expect(html).toContain("Book Now");
    // The derived treatment tag is humanised.
    expect(html).toContain("Dental implants");
    expect(html).toContain("Teeth whitening");
  });

  it("links the card out to the real Ad Library entry, in a new tab, safely", () => {
    expect(html).toContain('href="https://www.facebook.com/ads/library/?id=999"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain("View on Meta Ad Library");
  });

  it("shows the creative thumbnail when present and falls back to an icon tile when absent", () => {
    // The ad with an image renders it.
    expect(html).toContain('src="https://scontent.example.com/pic.jpg?oe=1234ABCD"');
    // The image-less ad renders no <img> for itself but still shows the card (icon tile is an <svg>).
    const noImage = render([ad({ imageUrl: null, adLibraryUrl: null })]);
    expect(noImage).not.toContain("<img");
    expect(noImage).toContain("<svg");
    expect(noImage).toContain("Rethink your smile");
  });
});

describe("AdLibrary — empty store (ingest has not run)", () => {
  const html = render([]);

  it("says the library is empty and shows NO fabricated ads", () => {
    expect(html).toContain("The winning-ads library is empty");
    expect(html).toContain("has not been ingested yet");
    expect(html).toContain("No sample ads are shown in their place");
    // No card, no outbound Ad Library link, no advertiser.
    expect(html).not.toContain("View on Meta Ad Library");
    expect(html).not.toContain("Banning Dental");
    expect(html).not.toContain("Bright Smile Dental");
  });
});

describe("AdLibrary — sourcing note", () => {
  it("keeps the public-library / not-your-own-performance distinction visible in every state", () => {
    for (const html of [render([ad()]), render([])]) {
      expect(html).toContain("public Meta Ad Library results");
      expect(html).toContain("not your own account performance");
      expect(html).toContain("appear once your Meta account is connected");
    }
  });
});

describe("winning-ads display helpers", () => {
  it("runtimeDuration bins days into human, non-precise buckets", () => {
    expect(runtimeDuration(0)).toBe("less than a day");
    expect(runtimeDuration(1)).toBe("1 day");
    expect(runtimeDuration(5)).toBe("5 days");
    expect(runtimeDuration(28)).toBe("4 weeks");
    expect(runtimeDuration(180)).toBe("6 months");
    expect(runtimeDuration(441)).toBe("over a year");
    expect(runtimeDuration(1502)).toBe("4 years");
  });

  it("winningSignal composes verb + duration + variants", () => {
    expect(winningSignal({ runtimeDays: 180, variantCount: 4, isActive: true })).toBe(
      "Running 6 months, 4 variants",
    );
    expect(winningSignal({ runtimeDays: 96, variantCount: 1, isActive: false })).toBe("Ran 3 months");
  });

  it("keywordLabel maps known tags and title-cases the rest", () => {
    expect(keywordLabel("dental-implants")).toBe("Dental implants");
    expect(keywordLabel("clear-aligners")).toBe("Clear aligners");
    expect(keywordLabel("mystery-treatment")).toBe("Mystery treatment");
  });

  it("ctaLabel prefers the ad's own button text, else humanises the type, else null", () => {
    expect(ctaLabel("Book Now", "BOOK_TRAVEL")).toBe("Book Now");
    expect(ctaLabel(null, "GET_QUOTE")).toBe("Get quote");
    expect(ctaLabel("", "")).toBeNull();
  });
});

// ===========================================================================
// THE RECREATE TRIGGER.
//
// vitest renders this component statically, so what is pinned here is the MARKUP
// the owner lands on: the button exists on every card, it is honest about what it
// does before it is pressed, and the missing-key case narrows the promise without
// removing the button. The outcome states (working / refused / saved) live behind
// a fetch and are covered by the route's own test file.
// ===========================================================================

describe("AdLibrary — the recreate trigger", () => {
  it("puts a Recreate for Vitality button on every card", () => {
    const html = render([ad(), ad({ id: "wa-2", pageName: "Bright Smile Dental" })]);
    // Counted on the per-card aria-label, so the section explainer above the grid
    // (which also says "Recreate for Vitality") cannot inflate the number.
    expect(html.split("aria-label=\"Recreate this ad for Vitality").length - 1).toBe(2);
    expect(html).toContain("Recreate for Vitality");
    // It is a real, enabled button, not a link and not a disabled placeholder.
    expect(html).toContain('type="button"');
    expect(html).not.toContain("disabled=\"\"");
  });

  it("says, before it is pressed, that it writes original copy and never publishes", () => {
    const html = render([ad()]);
    expect(html).toContain("completely original ad");
    expect(html).toContain("Nothing is ever published");
    expect(html).toContain("UK advertising rules for dentists");
    // And that it borrows the structure, not the words.
    expect(html).toContain("never reuses an advertiser");
  });

  it("with no image key: the button stays live, and the note says what is missing", () => {
    const html = render([ad()], false);
    // Counted on the per-card aria-label, not the section explainer, so a button
    // that quietly stopped rendering could not hide behind the copy above the grid.
    expect(html.split(`aria-label="Recreate this ad for Vitality`).length - 1).toBe(1);
    // And it is live: not hidden, not disabled. A missing key narrows what you get,
    // it never takes the button away.
    expect(html).not.toContain("hidden=\"\"");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("writes your own compliant ad copy only");
  });

  it("with an image key: the same live button, and no missing-key note", () => {
    const html = render([ad()], true);
    expect(html.split(`aria-label="Recreate this ad for Vitality`).length - 1).toBe(1);
    expect(html).not.toContain("hidden=\"\"");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).not.toContain("OPENAI_API_KEY");
  });

  it("shows no recreate button, and no explainer, when the library is empty", () => {
    const html = render([]);
    expect(html).not.toContain("Recreate for Vitality");
    expect(html).not.toContain("Nothing is ever published");
  });

  it("keeps the Ad Library link reachable now that the card is not one big link", () => {
    const html = render([ad()]);
    expect(html).toContain('href="https://www.facebook.com/ads/library/?id=999"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    // A button inside an anchor is invalid markup, so the card itself must not be one.
    // A button inside an anchor is invalid markup, so the card itself must not be
    // one big link any more: no anchor in this page may contain a button.
    for (const anchor of html.split("<a ").slice(1)) {
      const body = anchor.slice(0, anchor.indexOf("</a>"));
      expect(body).not.toContain("<button");
    }
  });
});
