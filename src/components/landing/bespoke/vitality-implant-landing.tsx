import { IMPLANT_LANDING_COPY } from "@/lib/landing/bespoke/copy";
import { StandardTreatmentLanding, type BespokeLandingBaseProps } from "./vitality-treatment-landing";

// The bespoke Vitality Dental dental-implant landing page. A thin per-slug wrapper that
// supplies its compliance-scanned corpus (copy.ts) plus its authored line-icons to the
// shared StandardTreatmentLanding renderer. No design lives here; see
// vitality-treatment-landing.tsx. Implants HAVE finance (catalogue financeAvailable is
// true), so the shared renderer shows the 0% finance chip from the corpus. Claims stay
// modest: "a long lasting way to replace a missing tooth" (catalogue phrasing).

// A clean single-tooth glyph, reused for the natural-looking-crown line-icon.
const TOOTH =
  "M12 4.2c-2.3-1.6-5-1.7-6.4-.2-1.6 1.7-1.3 4.6-.6 7.2.5 1.9.8 3.4 1.1 5.1.3 1.7.6 3.4 1.6 3.4 1.2 0 1.2-2.2 1.5-3.9.2-1.2.5-2.1 1.2-2.1s1 .9 1.2 2.1c.3 1.7.3 3.9 1.5 3.9 1 0 1.3-1.7 1.6-3.4.3-1.7.6-3.2 1.1-5.1.7-2.6 1-5.5-.6-7.2-1.4-1.5-4.1-1.4-6.4.2Z";

// The implant fixture (a threaded screw with a point), the signature implant glyph.
const FIXTURE = (
  <>
    <path d="M12 3v10" />
    <path d="M9 6h6M9 8.5h6M9 11h6" />
    <path d="M12 13c-2 2-2 5 0 7 2-2 2-5 0-7Z" />
  </>
);

// A dashed gap between two teeth (a missing tooth), reused for the gap line-icons.
const MISSING_TOOTH = (
  <>
    <rect x="4" y="8" width="3.6" height="8" rx="1.2" />
    <rect x="16.4" y="8" width="3.6" height="8" rx="1.2" />
    <path d="M10 8v8M14 8v8" strokeDasharray="2 2" />
  </>
);

// A removable denture arch with a dashed base, reused for the denture line-icons.
const DENTURE = (
  <>
    <path d="M4 9a8 8 0 0 1 16 0" />
    <path d="M7 9v3M12 9v3M17 9v3" />
    <path d="M4 15h16" strokeDasharray="3 2" />
  </>
);

// Authored line-icons for the "sound familiar" pain-points grid, paired by index with
// IMPLANT_LANDING_COPY.painPoints.items: missing tooth, fork, denture, tooth, warning,
// fixture.
const PAIN_ICONS: React.ReactNode[] = [
  MISSING_TOOTH,
  <>
    <path d="M8 3v6M11 3v6M8 9h3M9.5 9v12" />
    <path d="M15 3c-1.4 0-2 2-2 4.5S14 12 15 12v9" />
  </>,
  DENTURE,
  <path d={TOOTH} />,
  <>
    <path d="M12 4 21 19H3Z" />
    <path d="M12 10v4M12 16.5v.01" />
  </>,
  FIXTURE,
];

// Authored line-icons for the "what it helps with" grid, paired by index with
// IMPLANT_LANDING_COPY.helps.items: missing tooth, smile, denture, fixture, tooth + check,
// shield-check.
const HELP_ICONS: React.ReactNode[] = [
  MISSING_TOOTH,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8 13.5a4.2 4.2 0 0 0 8 0" />
    <path d="M9.2 9.6h.01M14.8 9.6h.01" />
  </>,
  DENTURE,
  FIXTURE,
  <>
    <path d={TOOTH} />
    <path d="M9.3 11.4l1.8 1.8 3.5-3.7" />
  </>,
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
];

export function VitalityImplantLanding(props: BespokeLandingBaseProps) {
  return (
    <StandardTreatmentLanding
      {...props}
      copy={IMPLANT_LANDING_COPY}
      painPointIcons={PAIN_ICONS}
      helpIcons={HELP_ICONS}
    />
  );
}
