import { CHECKUP_LANDING_COPY } from "@/lib/landing/bespoke/copy";
import { StandardTreatmentLanding, type BespokeLandingBaseProps } from "./vitality-treatment-landing";

// The bespoke Vitality Dental routine-checkup landing page. A thin per-slug wrapper
// that supplies its compliance-scanned corpus (copy.ts) plus its authored line-icons to
// the shared StandardTreatmentLanding renderer. No design lives here; see
// vitality-treatment-landing.tsx. Checkup has NO finance (catalogue financeAvailable is
// false), so the corpus supplies a finance-free price note and the shared renderer
// omits the finance chip entirely.

// Authored line-icons for the "sound familiar" pain-points grid, paired by index with
// CHECKUP_LANDING_COPY.painPoints.items: clock, question mark, location pin, clipboard,
// shield-check, calendar.
const PAIN_ICONS: React.ReactNode[] = [
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.4V12l3.2 2" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M9.6 9.4a2.4 2.4 0 0 1 4.4 1.3c0 1.6-2 1.8-2 3.3" />
    <path d="M12 16.6v.01" />
  </>,
  <>
    <path d="M12 21.5s6.8-5.4 6.8-10.7a6.8 6.8 0 1 0-13.6 0c0 5.3 6.8 10.7 6.8 10.7Z" />
    <circle cx="12" cy="10.6" r="2.5" />
  </>,
  <>
    <rect x="5" y="4" width="14" height="17" rx="2.2" />
    <path d="M9 3.5h6v3H9Z" />
    <path d="M8.5 11h7M8.5 14.5h7" />
  </>,
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
  <>
    <rect x="4" y="5.5" width="16" height="14" rx="2.4" />
    <path d="M4 9.5h16M8 3.6v4M16 3.6v4" />
    <path d="M9.5 13.6l1.6 1.6 3.4-3.6" />
  </>,
];

// Authored line-icons for the "what it helps with" grid, paired by index with
// CHECKUP_LANDING_COPY.helps.items: magnifier, health cross, worn edge, smile, clipboard
// check, refresh.
const HELP_ICONS: React.ReactNode[] = [
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l4.5 4.5" />
    <path d="M10.5 8v5M8 10.5h5" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </>,
  <>
    <path d="M4 10q2-3 4 0t4 0 4 0 4 0" />
    <path d="M4 15.5h16" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8 13.5a4.2 4.2 0 0 0 8 0" />
    <path d="M9.2 9.6h.01M14.8 9.6h.01" />
  </>,
  <>
    <rect x="5" y="4" width="14" height="17" rx="2.2" />
    <path d="M9 3.5h6v3H9Z" />
    <path d="M8.5 12l1.4 1.4 2.6-2.6" />
    <path d="M8.5 16.5h7" />
  </>,
  <>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4.5V9h-4.5" />
  </>,
];

export function VitalityCheckupLanding(props: BespokeLandingBaseProps) {
  return (
    <StandardTreatmentLanding
      {...props}
      copy={CHECKUP_LANDING_COPY}
      painPointIcons={PAIN_ICONS}
      helpIcons={HELP_ICONS}
    />
  );
}
