import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The "there is nothing here" block.
 *
 * TWO SIZES, because an empty state is read in two quite different places and
 * the same box cannot serve both:
 *
 *   the default   a whole page, or a whole tab, whose only content is absence.
 *                 A generous dashed box is right there: it fills the space the
 *                 content would have filled and says the space is meant to be
 *                 empty rather than still loading.
 *
 *   compact       a block EMBEDDED under other content, where the reader has
 *                 already read something and the emptiness is one section of a
 *                 page and not the page. At full size that box is ~190px of
 *                 dashed nothing hanging off the bottom of a working screen,
 *                 which reads as broken rather than as clear.
 *
 * Compact changes the box and nothing else: the icon, the heading and the
 * sentence are the same, because the words are what the reader needs and they
 * cost almost none of the height. The dashed border is kept at both sizes - it
 * is what distinguishes "nothing here" from "content that happens to be short".
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
  /** Embedded under other content: same words, a third of the height. */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[10px] border border-dashed border-line-strong text-center",
        compact ? "px-4 py-5" : "px-6 py-12",
        className,
      )}
    >
      {Icon ? (
        <span
          className={cn(
            "flex items-center justify-center rounded-[10px] bg-tile text-side-ink",
            compact ? "mb-2 h-8 w-8" : "mb-4 h-12 w-12",
          )}
        >
          <Icon size={compact ? 15 : 20} />
        </span>
      ) : null}
      {/* NOT cn(). tailwind-merge has no idea .text-title is a size - it is a
          house class in globals.css, not a Tailwind utility - so it files it
          under text-COLOUR and drops the text-navy sitting beside it. The
          heading then inherits its colour and happens to look right, which is
          the worst kind of wrong. Written out, both classes survive. */}
      <h3 className={compact ? "text-title font-semibold text-navy" : "text-sm font-semibold text-navy"}>
        {title}
      </h3>
      {description ? (
        <p
          className={cn(
            "max-w-md font-normal text-muted",
            compact ? "mt-0.5 text-[12px] leading-[1.4]" : "mt-1 text-[13px]",
          )}
        >
          {description}
        </p>
      ) : null}
      {children ? <div className={compact ? "mt-3" : "mt-5"}>{children}</div> : null}
    </div>
  );
}
