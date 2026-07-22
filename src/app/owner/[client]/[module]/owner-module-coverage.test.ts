import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CLIENT_NAV } from "@/lib/nav";

// Guards against the drift that shipped placeholder Campaigns / Booking / Landing
// pages in the OWNER view. The client tree (/c/[client]/<module>) has a dedicated
// page per module, but the owner tree (/owner/[client]/[module]) resolves every
// module through ONE if-chain; a module added to the client tree but not this chain
// silently falls through to <ModulePlaceholder> ("this module is being built") even
// though its real view exists. This test fails the build if any BUILT (non
// placeholder) module is not wired into the owner route.
describe("owner module route covers every built module", () => {
  const src = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
  const handled = new Set([...src.matchAll(/module === "([^"]+)"/g)].map((m) => m[1]));

  const builtSlugs = CLIENT_NAV.flatMap((g) => g.items)
    .filter((i) => i.status !== "placeholder" && i.slug !== "")
    .map((i) => i.slug);

  it.each(builtSlugs)("renders a real view for '%s', not a placeholder", (slug) => {
    expect(handled.has(slug)).toBe(true);
  });

  it("genuinely-unbuilt (placeholder) modules are allowed to fall through", () => {
    // power-dialler is status:"placeholder" on purpose; it may (and should) hit the
    // ModulePlaceholder fallback rather than be wired to a real view.
    const placeholderSlugs = CLIENT_NAV.flatMap((g) => g.items)
      .filter((i) => i.status === "placeholder")
      .map((i) => i.slug);
    expect(placeholderSlugs).toContain("power-dialler");
  });
});
