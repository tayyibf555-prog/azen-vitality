import { WHITENING_LANDING_COPY } from "@/lib/landing/bespoke/copy";
import { StandardTreatmentLanding, type BespokeLandingBaseProps } from "./vitality-treatment-landing";

// The bespoke Vitality Dental teeth-whitening landing page. A thin per-slug wrapper
// that supplies its compliance-scanned corpus (copy.ts) plus its authored line-icons
// to the shared StandardTreatmentLanding renderer. No design lives here; see
// vitality-treatment-landing.tsx for the layout, the A/B parity notes and the tracking
// markers. Whitening HAS finance (catalogue financeAvailable is true), so the shared
// renderer shows the 0% finance chip from the corpus.

// A clean single-tooth glyph, reused across a couple of the whitening line-icons.
const TOOTH =
  "M12 4.2c-2.3-1.6-5-1.7-6.4-.2-1.6 1.7-1.3 4.6-.6 7.2.5 1.9.8 3.4 1.1 5.1.3 1.7.6 3.4 1.6 3.4 1.2 0 1.2-2.2 1.5-3.9.2-1.2.5-2.1 1.2-2.1s1 .9 1.2 2.1c.3 1.7.3 3.9 1.5 3.9 1 0 1.3-1.7 1.6-3.4.3-1.7.6-3.2 1.1-5.1.7-2.6 1-5.5-.6-7.2-1.4-1.5-4.1-1.4-6.4.2Z";

// Authored line-icons for the "sound familiar" pain-points grid, paired by index with
// WHITENING_LANDING_COPY.painPoints.items: mug, camera, no-change circle, shopping bag,
// calendar, hourglass.
const PAIN_ICONS: React.ReactNode[] = [
  <>
    <path d="M5 8h10v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" />
    <path d="M15 9.5h2.2a2 2 0 0 1 0 4H15" />
    <path d="M8 3.6c-.6.8-.6 1.5 0 2.3M11 3.6c-.6.8-.6 1.5 0 2.3" />
  </>,
  <>
    <rect x="3" y="7" width="18" height="12" rx="2.4" />
    <circle cx="12" cy="13" r="3.2" />
    <path d="M8.5 7l1.3-2h4.4l1.3 2" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M6.5 6.5l11 11" />
  </>,
  <>
    <path d="M6 8h12l-1 11H7Z" />
    <path d="M9 8a3 3 0 0 1 6 0" />
  </>,
  <>
    <rect x="4" y="5.5" width="16" height="14" rx="2.4" />
    <path d="M4 9.5h16M8 3.6v4M16 3.6v4" />
    <path d="M11 13l1 1 2.5-2.5" />
  </>,
  <>
    <path d="M7 4h10M7 20h10" />
    <path d="M7 4c0 4 5 5 5 8s-5 4-5 8" />
    <path d="M17 4c0 4-5 5-5 8s5 4 5 8" />
  </>,
];

// Authored line-icons for the "what it helps with" grid, paired by index with
// WHITENING_LANDING_COPY.helps.items: tooth + sparkle, sun, calendar, smile, shield-check,
// refresh.
const HELP_ICONS: React.ReactNode[] = [
  <>
    <path d={TOOTH} />
    <path d="M16.6 4.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z" />
  </>,
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </>,
  <>
    <rect x="4" y="5.5" width="16" height="14" rx="2.4" />
    <path d="M4 9.5h16M8 3.6v4M16 3.6v4" />
    <path d="M9.5 13.6l1.6 1.6 3.4-3.6" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8 13.5a4.2 4.2 0 0 0 8 0" />
    <path d="M9.2 9.6h.01M14.8 9.6h.01" />
  </>,
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
  <>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4.5V9h-4.5" />
  </>,
];

export function VitalityWhiteningLanding(props: BespokeLandingBaseProps) {
  return (
    <StandardTreatmentLanding
      {...props}
      copy={WHITENING_LANDING_COPY}
      painPointIcons={PAIN_ICONS}
      helpIcons={HELP_ICONS}
    />
  );
}
