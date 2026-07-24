import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BeforeAfterSlider } from "./before-after-slider";

// Unit test for the before/after comparison slider client island. The project's
// vitest only picks up .test.ts (never .tsx), so we render the component via
// createElement + renderToStaticMarkup and assert the static markup contract that
// makes it accessible and layout-shift free:
//   - AFTER is the base image, BEFORE is layered on top and clipped from 50% to start
//   - a keyboard/assistive range input carries the value with a clear aria-label
//   - both image srcs + alts render, plus the Before/After labels and optional caption.

function render(props?: Partial<Parameters<typeof BeforeAfterSlider>[0]>): string {
  return renderToStaticMarkup(
    createElement(BeforeAfterSlider, {
      beforeSrc: "/x/before.png",
      afterSrc: "/x/after.png",
      beforeAlt: "before illustration",
      afterAlt: "after illustration",
      caption: "Drag to compare. Illustrative model, not a patient photo.",
      ...props,
    }),
  );
}

describe("BeforeAfterSlider", () => {
  it("renders both images with their alts, after as the base and before clipped", () => {
    const html = render();
    expect(html).toContain('src="/x/after.png"');
    expect(html).toContain('src="/x/before.png"');
    expect(html).toContain('alt="before illustration"');
    expect(html).toContain('alt="after illustration"');
    // The before image is clipped; at the starting split (50) it insets the right 50%.
    expect(html).toContain("ba-before");
    expect(html).toMatch(/clip-path:\s*inset\(0 50% 0 0\)/);
  });

  it("exposes an accessible range input with min/max and a descriptive label", () => {
    const html = render();
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Drag to compare before and after"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="100"');
    // Controlled value starts centred.
    expect(html).toContain('value="50"');
  });

  it("renders the default Before/After labels and the caption", () => {
    const html = render();
    expect(html).toContain(">Before<");
    expect(html).toContain(">After<");
    expect(html).toContain("Drag to compare. Illustrative model, not a patient photo.");
  });

  it("honours custom labels and omits the caption when none is given", () => {
    const html = render({ beforeLabel: "Now", afterLabel: "Clean", caption: undefined });
    expect(html).toContain(">Now<");
    expect(html).toContain(">Clean<");
    expect(html).not.toContain("<figcaption");
  });
});
