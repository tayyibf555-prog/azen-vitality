import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityCheckupLanding } from "./vitality-checkup-landing";

// Render smoke tests for the bespoke checkup server component (rendered via the shared
// StandardTreatmentLanding): the analytics markers, the per-variant accented headline +
// CTA, the real catalogue price, the LABELLED placeholder slots, and crucially the
// compliance omission of ALL finance wording (checkup catalogue financeAvailable is
// false), plus the usual no-fabricated-proof checks.

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityCheckupLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "checkup",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityCheckupLanding", () => {
  it("emits every section marker the tracker observes, plus tagged CTAs", () => {
    const html = render("a");
    for (const section of [
      "hero",
      "pain_points",
      "treatment",
      "helps",
      "stories",
      "before_after",
      "why",
      "pricing",
      "faq",
    ]) {
      expect(html).toContain(`data-lp-section="${section}"`);
    }
    expect(html).toContain("data-lp-cta");
    expect(html).toContain('href="#consultation"');
    expect(html).toContain('id="consultation"');
  });

  it("uses the platform logo and authors inline SVG line-icons", () => {
    const html = render("a");
    expect(html).toContain('src="/copilot-logo.png"');
    expect(html).toContain("<svg");
    expect(html).toContain("It has been a while");
    expect(html).toContain("Catching decay early");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">a checkup</span>');
    expect(a).toContain("Book my checkup");

    const b = render("b");
    expect(b).toContain('<span class="acc">£60</span>');
    expect(b).toContain("Book a checkup appointment");
  });

  it("shows the real catalogue price, a finance-free note and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£60");
    expect(html).toContain("the real catalogue price"); // the finance-free price note
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("carries NO finance copy anywhere (checkup has no finance)", () => {
    // NB: scan for finance-specific wording, not a bare "0%" (that substring also
    // occurs inside CSS lengths like "100%").
    const html = render("a").toLowerCase();
    expect(html).not.toContain("finance");
    expect(html).not.toContain("0% finance");
    expect(html).not.toContain("0 percent");
    expect(html).not.toContain("interest-free");
    expect(html).not.toContain("spread the cost");
  });

  it("renders LABELLED placeholder slots and keeps the practice-photo consent line", () => {
    const html = render("a");
    expect(html).toContain("A friendly, familiar face here");
    expect(html).toContain("added with consent");
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
  });
});
