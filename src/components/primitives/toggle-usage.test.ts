import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ===========================================================================
// THE SWITCH PRIMITIVE, AND WHO USES IT.
//
// This file exists to CLAIM a hunk that nobody claimed. Campaign 6 extracted the
// onboarding form builder's private toggle into `@/components/primitives/toggle`
// so the permissions grid could use the same control — a −46/+3 change in an
// unrelated module, sitting in a workforce campaign's diff with no report
// attached to it. It compiled, linted and tested green, and "compiles and nobody
// mentioned it" is exactly how a refactor becomes an unexplained regression six
// weeks later.
//
// So the consolidation is pinned: the two screens that were converted use the
// shared control, the shared control keeps the accessibility properties that
// justified extracting it, and the two screens that were NOT converted are named
// here as a closed list rather than left as a silent inconsistency.
// ===========================================================================

const PRIMITIVES_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(PRIMITIVES_DIR, "..", "..");

function source(relPath: string): string {
  return readFileSync(join(SRC, relPath), "utf8");
}

/** The screens the extraction converted. Both must use the shared control. */
const CONVERTED = [
  "components/client/onboarding/form-builder.tsx",
  "components/client/permissions/permissions-view.tsx",
];

/**
 * The switches that are still private, named so their absence from the list
 * above is a fact on the record rather than an oversight. Neither was in this
 * campaign's scope, and converting a screen nobody asked about is how an
 * unrelated module ends up in a workforce diff — which is the very thing this
 * file exists to stop happening silently.
 */
const STILL_PRIVATE = [
  "components/client/systems/systems-view.tsx",
  "components/client/rota/rota-staff-panel.tsx",
];

describe("the shared Toggle is the one switch, where it was adopted", () => {
  it.each(CONVERTED)("%s imports Toggle from the primitives and defines none of its own", (file) => {
    const src = source(file);
    expect(src).toMatch(/import \{[^}]*\bToggle\b[^}]*\} from "@\/components\/primitives"/);
    // No private re-implementation left behind beside the import.
    expect(src).not.toMatch(/function Toggle\(/);
  });

  it("keeps the accessibility properties that were the reason to extract it", () => {
    // A permissions grid is a wall of otherwise unlabelled controls: the visible
    // label is the column header, which a screen reader will not associate with
    // the cell. If these three go, the extraction has lost its point.
    const toggle = source("components/primitives/toggle.tsx");
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain("aria-checked={checked}");
    expect(toggle).toContain("aria-label={label}");
    // And the busy state the kill switch needed, so a write in flight cannot be
    // double-tapped.
    expect(toggle).toContain("disabled={locked}");
  });

  it("is exported from the primitives barrel, or the import above is a lie", () => {
    expect(source("components/primitives/index.ts")).toContain('export { Toggle');
  });

  it("names the switches that are still private, as a closed list", () => {
    for (const file of STILL_PRIVATE) {
      expect(source(file), `${file} no longer has a private switch — move it out of STILL_PRIVATE`)
        .toContain('role="switch"');
    }
  });
});
