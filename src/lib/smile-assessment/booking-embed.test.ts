// THE GATE ON THE EMBEDDED BOOKING CALENDAR (C1).
//
// Every rule in booking-embed.ts guards something that cannot be taken back: a
// held slot, a patient record created in Dentally, an appointment in a real
// practice diary. So each one is broken here deliberately, and the comment above
// each test says what SHIPS if the rule is removed rather than what the assertion
// checks - a test whose mutation is "the expectation changes" is testing itself.

import { describe, it, expect } from "vitest";
import { bookingEmbed, bookingSiteFromUrl, type BookingEmbed } from "./booking-embed";

const BLOCK = { headline: "Book your appointment now", blurb: "Pick a time that suits you." };
const SITE = { id: "site-ng", name: "Vitality Dental N15" };
/** Exactly what submit/route.ts mints when online-booking is on. */
const URL_FOR_SITE = "/book/vitality?site=site-ng";

function embed(over: Partial<Parameters<typeof bookingEmbed>[0]> = {}): BookingEmbed {
  return bookingEmbed({ bookingUrl: URL_FOR_SITE, block: BLOCK, site: SITE, ...over });
}

/* ---------------------------------------------------------------------------
 * 1. Reading the site out of the URL the server minted.
 * ------------------------------------------------------------------------- */

describe("the site a booking URL names", () => {
  it("reads the parameter submit/route.ts actually writes", () => {
    // Vacuity guard: if that route's format ever changes, this is the first thing
    // that goes red rather than the last.
    expect(bookingSiteFromUrl("/book/vitality?site=site-ng")).toBe("site-ng");
  });

  it("finds it wherever it sits in the query, and stops at a fragment", () => {
    expect(bookingSiteFromUrl("/book/v?utm_source=meta&site=site-rv")).toBe("site-rv");
    expect(bookingSiteFromUrl("/book/v?site=site-rv&utm=x")).toBe("site-rv");
    expect(bookingSiteFromUrl("/book/v?site=site-rv#times")).toBe("site-rv");
  });

  it("does not answer for a URL that names no site at all", () => {
    // MUTATION: return something for these and bookingEmbed's site comparison has
    // nothing to compare against, so the "is this the campaign's own diary" check
    // silently stops running.
    expect(bookingSiteFromUrl("/book/vitality")).toBeNull();
    expect(bookingSiteFromUrl("/book/vitality?")).toBeNull();
    expect(bookingSiteFromUrl("/book/vitality?site=")).toBeNull();
    expect(bookingSiteFromUrl("/book/vitality?site=%20%20")).toBeNull();
    expect(bookingSiteFromUrl("/book/vitality?offsite=site-ng")).toBeNull();
    expect(bookingSiteFromUrl(undefined)).toBeNull();
    expect(bookingSiteFromUrl(null)).toBeNull();
    expect(bookingSiteFromUrl(42 as unknown as string)).toBeNull();
  });

  it("refuses a malformed escape rather than guessing what it meant", () => {
    expect(bookingSiteFromUrl("/book/vitality?site=%E0%A4%A")).toBeNull();
  });

  it("takes the FIRST site parameter, like every server-side parser here", () => {
    // MUTATION: take the last one and a URL carrying two means one thing to this
    // check and another to the API that re-validates it - which is the shape of a
    // parameter-smuggling bug, not a cosmetic one.
    expect(bookingSiteFromUrl("/book/v?site=site-ng&site=site-rv")).toBe("site-ng");
  });
});

/* ---------------------------------------------------------------------------
 * 2. The four refusals.
 * ------------------------------------------------------------------------- */

describe("what has to be true before a calendar may be mounted", () => {
  it("is ready when the owner authored a booking block and everything lines up", () => {
    // Vacuity guard for every refusal below: if this went "off", they would all
    // pass while proving nothing.
    expect(embed()).toEqual({
      status: "ready",
      siteId: "site-ng",
      siteName: "Vitality Dental N15",
      headline: BLOCK.headline,
      blurb: BLOCK.blurb,
    });
  });

  // MUTATION: default the words and every funnel on the platform grows a booking
  // button its owner never asked for, on a result screen they already wrote.
  it("offers nothing when the result screen carries no booking block", () => {
    expect(embed({ block: null })).toEqual({ status: "off" });
    expect(embed({ block: undefined })).toEqual({ status: "off" });
    expect(embed({ block: { headline: "  ", blurb: "x" } })).toEqual({ status: "off" });
    expect(embed({ block: { headline: "x", blurb: "   " } })).toEqual({ status: "off" });
  });

  // MUTATION: drop this and the owner's online-booking kill switch stops reaching
  // the funnel. submit/route.ts omits bookingUrl entirely when the switch is off,
  // so its absence IS the switch, resolved server-side where it cannot be argued
  // with from a browser.
  it("offers nothing when the practice has online booking switched off", () => {
    expect(embed({ bookingUrl: undefined })).toEqual({ status: "off" });
    expect(embed({ bookingUrl: null })).toEqual({ status: "off" });
    expect(embed({ bookingUrl: "" })).toEqual({ status: "off" });
  });

  // MUTATION: fall back to the site we were handed, the way /book falls back to
  // sites[0], and a multi-site practice books a patient who answered a campaign
  // for one branch into the diary of another.
  it("refuses when the campaign's site is not the site the server named", () => {
    expect(embed({ site: { id: "site-rv", name: "Vitality Dental Enfield" } })).toEqual({
      status: "off",
    });
    expect(embed({ bookingUrl: "/book/vitality?site=site-rv" })).toEqual({ status: "off" });
  });

  it("refuses when the page supplied no site at all, rather than picking one", () => {
    expect(embed({ site: null })).toEqual({ status: "off" });
    expect(embed({ site: undefined })).toEqual({ status: "off" });
    expect(embed({ site: { id: "site-ng", name: "  " } })).toEqual({ status: "off" });
    expect(embed({ site: { id: "  ", name: "Vitality Dental N15" } })).toEqual({ status: "off" });
  });
});

/* ---------------------------------------------------------------------------
 * 3. PREVIEW MODE. The one that writes appointments if it is wrong.
 * ------------------------------------------------------------------------- */

describe("preview mode can never reach a calendar", () => {
  // MUTATION: drop the previewMode branch and an owner clicking through their own
  // funnel in the builder's iframe (?preview=1, campaigns-panel.tsx) reaches a live
  // calendar: POST /api/booking/hold takes a real slot out of the practice's diary
  // and POST /api/booking/create registers a patient and books it. Neither call
  // knows it came from a preview, and neither can.
  it("never returns a mountable target while previewing", () => {
    const previewed = embed({ previewMode: true });
    expect(previewed.status).toBe("preview");
    // The structural half: there is no site on a preview result, and
    // <BookingCalendar> cannot be built without one.
    expect(previewed).not.toHaveProperty("siteId");
    expect(previewed).not.toHaveProperty("siteName");
  });

  it("still shows the owner the button and its words, so the preview is honest", () => {
    expect(embed({ previewMode: true })).toEqual({
      status: "preview",
      headline: BLOCK.headline,
      blurb: BLOCK.blurb,
    });
  });

  // MUTATION: test previewMode FIRST and the preview draws a booking button on a
  // funnel where a live patient would get none - a preview lying about the funnel
  // it previews, in the direction that makes an owner publish it.
  it("shows nothing at all when a live patient would also see nothing", () => {
    expect(embed({ previewMode: true, bookingUrl: undefined })).toEqual({ status: "off" });
    expect(embed({ previewMode: true, block: null })).toEqual({ status: "off" });
    expect(embed({ previewMode: true, site: { id: "site-rv", name: "Elsewhere" } })).toEqual({
      status: "off",
    });
  });

  it("treats only an explicit true as previewing", () => {
    expect(embed({ previewMode: false }).status).toBe("ready");
    expect(embed({ previewMode: undefined }).status).toBe("ready");
  });
});

/* ---------------------------------------------------------------------------
 * 4. Purity.
 * ------------------------------------------------------------------------- */

describe("the gate is a function of its arguments and nothing else", () => {
  it("trims what it returns, and returns the campaign's site verbatim", () => {
    const got = bookingEmbed({
      bookingUrl: "/book/vitality?site=site-ng",
      block: { headline: "  Book now  ", blurb: "  Live times.  " },
      site: { id: "site-ng", name: "  Vitality Dental N15  " },
    });
    expect(got).toEqual({
      status: "ready",
      siteId: "site-ng",
      siteName: "Vitality Dental N15",
      headline: "Book now",
      blurb: "Live times.",
    });
  });

  it("mutates nothing it is handed", () => {
    const block = { ...BLOCK };
    const site = { ...SITE };
    bookingEmbed({ bookingUrl: URL_FOR_SITE, block, site });
    expect(block).toEqual(BLOCK);
    expect(site).toEqual(SITE);
  });
});
