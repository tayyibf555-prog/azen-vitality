import { Fraunces } from "next/font/google";

// Self-hosted display face for the bespoke .vd-landing pages, paired with the app's
// existing body face (Plus Jakarta Sans, already exposed globally as --font-jakarta by
// the root layout). next/font downloads + self-hosts Fraunces at BUILD time (no runtime
// request to Google) and generates a size-adjust fallback so the swap is layout-shift
// free.
//
// Loaded as a variable font (no pinned weight) with the optical-sizing axis on, so the
// serif tightens its contrast at large display sizes. We only ever set font-weight
// 600-700 on headings in the stylesheet. The `variable` is consumed as var(--font-fraunces)
// inside the scoped .vd-landing CSS, and applied by adding `fraunces.variable` to the
// single .vd-landing wrapper — so the face is scoped to these pages and nothing else.
export const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-fraunces",
});
