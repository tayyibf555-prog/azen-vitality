import { cn } from "@/lib/utils";

/**
 * A control that exists on Dentally's charting screen and cannot act here.
 *
 * WHY THIS IS NOT `<button disabled>` WITH A `title`. The brief's rule is that no
 * affordance may be a disabled button with no explanation, and a disabled button
 * carrying a title attribute IS one:
 *   - `disabled` removes the control from the tab order, so a keyboard user can
 *     never reach the explanation at all;
 *   - hover on a disabled control is unreliable across engines, so the tooltip may
 *     never fire for a mouse user either;
 *   - `title` is not dependably announced by screen readers.
 * So the control stays FOCUSABLE with `aria-disabled="true"`, the reason is a
 * RENDERED sentence beneath it, and `aria-describedby` ties the two together. The
 * title attribute is kept as a bonus, never as the explanation.
 *
 * IT IS INERT BY CONSTRUCTION. There is no handler and no state, which is what keeps
 * plan-cards.tsx server-safe while still carrying a real explanation, and it is why
 * a click can never reach a Dentally write path from here.
 *
 * `id` is a required prop rather than a `useId()` because a hook would make every
 * caller a client component, and plan-cards is rendered directly by the server
 * component tab-chart.tsx.
 */
export function DisabledControl({
  id,
  label,
  reason,
  variant = "default",
  icon,
  className,
  reasonClassName,
  hideReason = false,
}: {
  /** Stable DOM id, kebab-case. The reason line takes `${id}-reason`. */
  id: string;
  label: React.ReactNode;
  /** The rendered sentence. Comes from CHART_COPY in lib/patient/tabs.ts, never from JSX. */
  reason: string;
  /** `round` is Dentally's blue + beneath the chart; `primary` its filled buttons. */
  variant?: "default" | "primary" | "round";
  icon?: React.ReactNode;
  className?: string;
  reasonClassName?: string;
  /**
   * Suppress only the per-control sentence, for a cluster of controls that share ONE
   * sentence rendered once beneath them. The control still points at that sentence
   * through aria-describedby, so nothing is lost for a screen reader; the caller is
   * responsible for rendering an element with the `${id}-reason` id.
   */
  hideReason?: boolean;
}) {
  const reasonId = `${id}-reason`;
  return (
    <div className={cn(variant === "round" ? "inline-flex items-center gap-2" : "space-y-1", className)}>
      <button
        type="button"
        id={id}
        aria-disabled="true"
        aria-describedby={reasonId}
        title={reason}
        className={cn(
          // `relative` IS NOT DECORATION AND MUST NOT BE TIDIED AWAY. The round variant's
          // label is an `sr-only` span, and Tailwind's sr-only is `position: absolute`.
          // With every ancestor up to <body> static, that span's containing block is the
          // initial containing block, so it escapes .app-frame's overflow:hidden and adds
          // its own offset to documentElement.scrollHeight — measured: one such span at
          // y=1194 gave the chart tab a 1195px document against a 1000px viewport, a
          // scrollbar no other tab has, and 15px less width for the arch. Making the
          // BUTTON the containing block resolves the span inside the clip. It changes no
          // layout (nothing else in here is absolutely positioned) and, critically, does
          // not touch the accessibility tree: the span is still rendered, still the
          // button's accessible name, still reachable.
          "relative inline-flex items-center gap-1.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30",
          // Muted, not greyed into invisibility: this is a real Dentally control and a
          // reader looking for it must still find it in its own position.
          variant === "round"
            ? "size-8 shrink-0 justify-center rounded-full bg-blue-dark/45 text-white"
            : variant === "primary"
              ? "rounded-lg bg-blue-dark/45 px-3.5 py-1.5 text-[13px] text-white"
              : "rounded-lg border border-line-strong bg-card-muted/60 px-3 py-1.5 text-[12.5px] text-muted",
        )}
      >
        {icon}
        {variant === "round" ? <span className="sr-only">{label}</span> : label}
      </button>
      {hideReason ? null : (
        <p id={reasonId} className={cn("text-[11px] leading-[1.45] text-faint", reasonClassName)}>
          {reason}
        </p>
      )}
    </div>
  );
}
