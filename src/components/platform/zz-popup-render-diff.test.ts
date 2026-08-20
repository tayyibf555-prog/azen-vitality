import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CopilotConversation } from "./copilot-conversation";
import { CopilotConversation as Baseline } from "./zz-baseline-copilot-conversation";

// Structural render diff of the bottom-docked pop-up: branch vs f0f9a72.
// useEffect does not run under renderToStaticMarkup, so this is the mounted
// empty state exactly as both versions paint it on first frame.
describe("the co-pilot pop-up renders unchanged from f0f9a72", () => {
  for (const props of [
    { clientSlug: "vitality" },
    { clientSlug: "vitality", autoFocus: true },
    { clientSlug: "vitality", onClose: () => {} },
    { clientSlug: "vitality", autoFocus: true, onClose: () => {} },
  ]) {
    it(`is byte-identical for ${JSON.stringify(Object.keys(props))}`, () => {
      const now = renderToStaticMarkup(createElement(CopilotConversation, props));
      const then = renderToStaticMarkup(createElement(Baseline, props));
      expect(now).toBe(then);
    });
  }
});
