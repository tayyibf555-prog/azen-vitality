import { VENEERS_LANDING_COPY } from "@/lib/landing/bespoke/copy";
import { StandardTreatmentLanding, type BespokeLandingBaseProps } from "./vitality-treatment-landing";

// The bespoke Vitality Dental veneers landing page. A thin per-slug wrapper that
// supplies its compliance-scanned corpus (copy.ts) plus its authored line-icons to the
// shared StandardTreatmentLanding renderer. No design lives here; see
// vitality-treatment-landing.tsx. Veneers HAVE finance (catalogue financeAvailable is
// true), so the shared renderer shows the 0% finance chip from the corpus.

// Authored line-icons for the "sound familiar" pain-points grid, paired by index with
// VENEERS_LANDING_COPY.painPoints.items: worn edge, half-shaded shade, chipped panel,
// gap between teeth, small peg tooth, sparkle.
const PAIN_ICONS: React.ReactNode[] = [
  <>
    <path d="M4 10q2-3 4 0t4 0 4 0 4 0" />
    <path d="M4 15.5h16" />
  </>,
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 0 0 16Z" />
  </>,
  <>
    <path d="M5 8.5A3.5 3.5 0 0 1 8.5 5H14l5 5v5.5A3.5 3.5 0 0 1 15.5 19h-7A3.5 3.5 0 0 1 5 15.5Z" />
    <path d="M14 5v5h5" />
  </>,
  <>
    <rect x="4" y="6" width="5" height="12" rx="1.6" />
    <rect x="15" y="6" width="5" height="12" rx="1.6" />
    <path d="M10.6 12h2.8" />
    <path d="M11.6 10.6 10.2 12l1.4 1.4" />
    <path d="M12.4 10.6 13.8 12l-1.4 1.4" />
  </>,
  <>
    <rect x="4" y="6" width="4" height="12" rx="1.3" />
    <rect x="16" y="6" width="4" height="12" rx="1.3" />
    <rect x="10" y="12" width="4" height="6" rx="1.3" />
    <path d="M12 10.5V7" />
    <path d="M10.5 8.5 12 7l1.5 1.5" />
  </>,
  <>
    <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7Z" />
    <path d="M18.4 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
  </>,
];

// Authored line-icons for the "what it helps with" grid, paired by index with
// VENEERS_LANDING_COPY.helps.items: layered covers, half-shaded shade, chipped panel,
// gap between teeth, sparkle, check circle.
const HELP_ICONS: React.ReactNode[] = [
  <>
    <rect x="5" y="5" width="11" height="14" rx="2.4" />
    <rect x="8" y="5" width="11" height="14" rx="2.4" />
  </>,
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 0 0 16Z" />
  </>,
  <>
    <path d="M5 8.5A3.5 3.5 0 0 1 8.5 5H14l5 5v5.5A3.5 3.5 0 0 1 15.5 19h-7A3.5 3.5 0 0 1 5 15.5Z" />
    <path d="M14 5v5h5" />
  </>,
  <>
    <rect x="4" y="6" width="5" height="12" rx="1.6" />
    <rect x="15" y="6" width="5" height="12" rx="1.6" />
    <path d="M10.6 12h2.8" />
    <path d="M11.6 10.6 10.2 12l1.4 1.4" />
    <path d="M12.4 10.6 13.8 12l-1.4 1.4" />
  </>,
  <>
    <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7Z" />
    <path d="M18.4 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
  </>,
];

export function VitalityVeneersLanding(props: BespokeLandingBaseProps) {
  return (
    <StandardTreatmentLanding
      {...props}
      copy={VENEERS_LANDING_COPY}
      painPointIcons={PAIN_ICONS}
      helpIcons={HELP_ICONS}
    />
  );
}
