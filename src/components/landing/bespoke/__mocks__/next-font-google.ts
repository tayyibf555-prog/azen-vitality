// TEST-ONLY stub for `next/font/google`.
//
// The real `next/font/google` module is an empty build-time placeholder: Next's SWC
// font loader rewrites the import + call during `next build`/`next dev`. Outside that
// pipeline (i.e. under vitest/node) it exports nothing, so calling e.g. `Fraunces(...)`
// throws. vitest.config.ts aliases `next/font/google` to this file so the bespoke
// landing components (which import a self-hosted font) render in the unit tests.
//
// This file is referenced ONLY by the vitest alias. It is never imported by app code
// and never used by `next build` (which uses the real loader), so it has zero effect
// on the shipped pages.

type FontResult = {
  className: string;
  variable: string;
  style: { fontFamily: string };
};

function stubFont(): FontResult {
  return {
    className: "vd-font-stub",
    variable: "vd-font-stub",
    style: { fontFamily: "stub, serif" },
  };
}

// Named exports for every face the app instantiates via next/font/google.
export const Fraunces = stubFont;
export const Plus_Jakarta_Sans = stubFont;
