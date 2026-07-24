import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RevealOnScroll } from "./reveal-on-scroll";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

// The reveal controller is a client island, but its no-JS baseline is the important
// contract: content must be visible when JavaScript has not run. The project's vitest
// only picks up .test.ts (never .tsx), so we render via createElement + renderToStaticMarkup
// (which never runs effects — exactly the SSR / no-JS condition) and assert:
//   - it renders its children (SSR output contains them), and
//   - the SSR markup never carries the `vd-js` / `is-revealed` classes, because the
//     stylesheet only hides [data-reveal] under `.vd-landing.vd-js`. That class is added
//     by the mount effect (client only), so no-JS users are never left with hidden content.

describe("RevealOnScroll", () => {
  it("renders its children (visible in server markup, before any JS runs)", () => {
    const html = renderToStaticMarkup(
      createElement(
        RevealOnScroll,
        null,
        createElement("section", { "data-reveal": "" }, "Revealable section body"),
      ),
    );
    expect(html).toContain("Revealable section body");
  });

  it("does not add the .vd-js gate (or is-revealed) in server markup — the no-JS guard", () => {
    const html = renderToStaticMarkup(
      createElement(
        RevealOnScroll,
        null,
        createElement("div", { "data-reveal": "" }, "Content that must stay visible"),
      ),
    );
    expect(html).toContain("Content that must stay visible");
    // The mount effect (not run here) is the ONLY thing that adds these classes.
    expect(html).not.toContain("vd-js");
    expect(html).not.toContain("is-revealed");
  });

  it("the stylesheet gates every hidden reveal state behind the .vd-js root class", () => {
    // The hide state is written as `.vd-landing.vd-js ... [data-reveal] ... { opacity:0 }`.
    // If JS never runs, `.vd-js` is absent and the hide rules never match, so content is
    // visible by default. Guard: there is no reveal opacity:0 rule that is NOT gated by vd-js.
    const rules = VITALITY_INVISALIGN_CSS.split("}");
    const ungatedHidden = rules.filter(
      (rule) => rule.includes("[data-reveal]") && /opacity\s*:\s*0\b/.test(rule) && !rule.includes(".vd-js"),
    );
    expect(ungatedHidden).toEqual([]);
    // And the gate is actually used.
    expect(VITALITY_INVISALIGN_CSS).toContain(".vd-js");
  });
});
