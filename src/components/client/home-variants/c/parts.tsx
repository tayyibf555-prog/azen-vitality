"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { formatPenceGbp } from "@/lib/dashboard/money";
import type { Metric } from "@/lib/dashboard/view";
import type { WorkLink } from "@/lib/home-variants/c/work";
import { cn, num } from "@/lib/utils";

// ---------------------------------------------------------------------------
// VARIANT C: the small shared pieces of the working surface.
//
// Everything here is local to this variant. Nothing in the shared dashboard is
// touched, so the three variants can be compared without one changing another.
//
// TYPE. Sentence case throughout, and four sizes only:
//
//   HEAD    12px semibold navy, sentence case      panel headings
//   FIGURE  23px bold tabular navy                 the money that leads a panel
//   COUNT   19px bold tabular blue                 the counted figures
//   DATA    12.5px bold tabular navy               every other numeral
//   META    11px medium muted                      labels, rows, prose
//
// There is no uppercase letterspaced micro-cap anywhere on this screen. A screen
// of them is harder to scan and it is not denser: the same words in sentence
// case hold the same information and read at a glance.
//
// AFFORDANCE. A figure that leads somewhere is quiet until it is wanted. It sits
// in the same ink as its neighbours, and on hover or keyboard focus it underlines
// and reveals a small arrow in space that is already reserved, so nothing on the
// screen moves. What will happen is on the title and the accessible name before
// the click, and the click only ever NAVIGATES.
// ---------------------------------------------------------------------------

/** One ring, everywhere, so every interactive element is visibly focusable. */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40 focus-visible:ring-offset-1 focus-visible:ring-offset-white";

/**
 * A panel heading with its headline figure on the right, as Dentally sets it.
 *
 * Sentence case, 12px, navy: quiet enough that the figures lead, legible enough
 * to be read as a heading from a metre away.
 */
export function PanelHead({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1.5">
      <h3 className="text-[12px] font-semibold tracking-[-0.1px] text-navy">{children}</h3>
      {right ? <div className="flex shrink-0 items-baseline gap-1.5">{right}</div> : null}
    </div>
  );
}

/** A sub-heading inside a panel, for the paired columns. */
export function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="border-b border-line pb-1 text-[11px] font-semibold text-muted">{children}</h4>
  );
}

/**
 * The stand-in for a figure that could not be sourced.
 *
 * It is never a zero. The reason travels with it in two ways that cost the
 * screen nothing: the title for a pointer, and a visually hidden sentence for a
 * screen reader, attached to the figure it concerns rather than to a row of
 * chips across the foot of the page.
 */
export function Unavailable({
  reason,
  className,
}: {
  reason: string | null;
  className?: string;
}) {
  return (
    <span title={reason ?? undefined} className={cn("font-medium text-faint", className)}>
      Unavailable
      {reason ? <span className="sr-only">. {reason}</span> : null}
    </span>
  );
}

/**
 * A quiet note attached to a figure that IS available but is qualified.
 *
 * Invisible: no glyph, no chip, no colour. The sentence reaches a pointer through
 * the title on the figure's own wrapper and a screen reader through this span.
 * Every one of them is also listed, in full, in the notes under the band.
 */
export function FigureNote({ text }: { text: string }) {
  return <span className="sr-only"> {text}</span>;
}

/** A money figure at the panel-leading size, or the reason it is missing. */
export function Money({
  metric,
  negative = false,
  tone = "navy",
  note,
}: {
  metric: Metric;
  /** Print as money owed TO the practice, the way Dentally prints a balance. */
  negative?: boolean;
  tone?: "navy" | "red";
  note?: string;
}) {
  if (metric.value === null) {
    return <Unavailable reason={metric.reason} className="text-[23px] leading-[1.05]" />;
  }
  const pence = negative ? -Math.abs(metric.value) : metric.value;
  return (
    <span
      title={note}
      className={cn(
        "block truncate text-[23px] font-bold leading-[1.05] tabular-nums tracking-[-0.7px]",
        tone === "red" ? "text-status-red" : "text-navy",
      )}
    >
      {formatPenceGbp(pence)}
      {note ? <FigureNote text={note} /> : null}
    </span>
  );
}

/** A whole-number metric at the dense data size. */
export function Data({ metric, className }: { metric: Metric; className?: string }) {
  if (metric.value === null) {
    return <Unavailable reason={metric.reason} className={cn("text-[12.5px]", className)} />;
  }
  return (
    <span
      className={cn(
        "text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy",
        className,
      )}
    >
      {num(metric.value)}
    </span>
  );
}

/**
 * A large blue numeral with its label underneath, which is how Dentally prints
 * the patient, plan and UDA counts and how a practice manager scans them.
 *
 * When `href` is given the numeral becomes the way into the work: same ink, same
 * weight, an underline and an arrow only on hover or focus.
 */
export function StackStat({
  metric,
  label,
  decimals = 0,
  href,
  hrefTitle,
}: {
  metric: Metric;
  label: string;
  /** UDAs are measured to the hundredth, because an NHS contract is. */
  decimals?: 0 | 2;
  href?: string;
  hrefTitle?: string;
}) {
  const printed =
    metric.value === null
      ? null
      : decimals === 2
        ? metric.value.toLocaleString("en-GB", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : num(metric.value);

  const numeral =
    printed === null ? (
      <Unavailable reason={metric.reason} className="block text-[13px]" />
    ) : href ? (
      <Link
        href={href}
        title={hrefTitle}
        className={cn(
          "group/stat inline-flex max-w-full items-baseline gap-1 text-[19px] font-bold leading-[1.15] tracking-[-0.5px] tabular-nums text-blue-royal",
          "underline-offset-[3px] hover:underline",
          FOCUS,
        )}
      >
        <span className="truncate">{printed}</span>
        <ArrowRight
          aria-hidden
          size={12}
          className="shrink-0 opacity-0 transition-opacity group-hover/stat:opacity-100 group-focus-visible/stat:opacity-100"
        />
      </Link>
    ) : (
      <b className="block truncate text-[19px] font-bold leading-[1.15] tracking-[-0.5px] tabular-nums text-blue-royal">
        {printed}
      </b>
    );

  return (
    <div className="min-w-0 py-[3px]">
      {numeral}
      <span className="mt-[1px] block truncate text-[11px] font-medium text-muted">{label}</span>
    </div>
  );
}

/**
 * The work line at the foot of a panel: the one job the panel's figures imply,
 * and the page that does it.
 *
 * It renders NOTHING when there is no work, so a quiet panel is quiet rather
 * than carrying an empty chip that reads as broken. It is a link, never a
 * trigger: this screen sends nothing and writes nothing.
 */
export function WorkLine({ work }: { work: WorkLink | null }) {
  if (work === null) return null;
  return (
    <Link
      href={work.href}
      title={work.description}
      aria-label={work.description}
      className={cn(
        "group/work mt-auto flex items-center justify-between gap-2 rounded-[6px] border-t border-line px-1 pb-0.5 pt-2 transition-colors",
        "hover:bg-[#f2f6fc]",
        FOCUS,
      )}
    >
      <span className="min-w-0 truncate text-[11.5px] font-semibold text-blue-royal">
        {work.text}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-faint transition-colors group-hover/work:text-muted">
        {work.destination}
        <ArrowRight aria-hidden size={11} />
      </span>
    </Link>
  );
}
