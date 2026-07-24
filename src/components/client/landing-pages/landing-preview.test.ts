import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { LandingPreview } from "./landing-preview";

describe("LandingPreview", () => {
  const url = "/go/vitality/invisalign?preview=tok";
  const html = renderToStaticMarkup(
    createElement(LandingPreview, { url, title: "Invisalign", isDraft: false }),
  );

  it("embeds the page in an iframe pointed at the given url", () => {
    expect(html).toMatch(/src="[^"]*v=a"/);
    expect(html).toContain("iframe");
  });

  it("sandboxes the iframe WITHOUT allow-scripts, so the page's tracker never fires and a preview cannot count as a visit", () => {
    expect(html).toMatch(/sandbox="allow-same-origin"/);
    expect(html).not.toContain("allow-scripts");
  });

  it("offers an open-in-new-tab link to the same url", () => {
    expect(html).toMatch(/<a [^>]*href="[^"]*v=a"[^>]*target="_blank"/);
    expect(html).toContain("Open in browser");
  });

  it("flags a draft page as a private link", () => {
    const draftHtml = renderToStaticMarkup(
      createElement(LandingPreview, { url, title: "Invisalign", isDraft: true }),
    );
    expect(draftHtml).toContain("Draft, private link");
  });
});
