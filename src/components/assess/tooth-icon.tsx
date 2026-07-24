// A tooth glyph, drawn here because lucide-react ships none and the answer
// options need one (a gem/diamond reads as jewellery, not dentistry).
//
// The outline is the hand-authored tooth from the Invisalign landing page
// (src/components/landing/bespoke/vitality-invisalign-landing.tsx, PAIN_ICONS[0]),
// scaled 1.26x about its own centre so it fills the 24x24 box the way a lucide
// icon does instead of sitting small and high in one corner. Everything else --
// viewBox, fill:none, stroke:currentColor, round caps and joins, a size/strokeWidth
// prop pair -- matches lucide exactly, so this drops into OPTION_ICONS beside them
// without breaking that map's "one stroke weight, one visual language" rule.

/** The subset of lucide's props the option maps actually pass. */
export interface ToothIconProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
}

export function ToothIcon({ size = 24, strokeWidth = 2, className }: ToothIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.35 2.87C6.08 2.87 4.19 4.63 4.19 7.53c0 2.27 1.01 3.65 1.76 6.05.63 2.14.63 6.55 2.27 7.06 1.51.5 1.64-3.15 2.27-5.29.38-1.26.76-1.89 1.51-1.89s1.13.63 1.51 1.89c.63 2.14.76 5.8 2.27 5.29 1.64-.5 1.64-4.91 2.27-7.06.76-2.39 1.76-3.78 1.76-6.05 0-2.9-1.89-4.66-4.16-4.66-2.02 0-2.9 1.13-4.79 1.13S10.36 2.87 8.35 2.87Z" />
    </svg>
  );
}
