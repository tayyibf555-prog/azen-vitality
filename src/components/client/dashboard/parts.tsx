import { formatPenceGbp } from "@/lib/dashboard/money";
import type { Metric } from "@/lib/dashboard/view";
import { cn, num } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The small shared pieces of the practice dashboard.
//
// One rule governs every one of them: a figure that could not be sourced is
// NEVER rendered as a number. It renders as the word "Unavailable" carrying the
// reason, because on a takings screen a plausible zero gets believed and acted
// on, and a blank gets questioned.
//
// TYPE SCALE. The screen used to run fourteen font sizes between 9.5px and 40px,
// which is why it read as unrelated pieces rather than one instrument. A note
// here then claimed it ran "four, and nothing else" - which was not true of the
// code under it, and by the time anybody counted it was eleven sizes. A rule
// nothing can fail is not a rule, so this one is a census that names its own
// exceptions, and there is a test beside it:
//
//   FIGURE  22px bold, tabular    the money and the totals that lead a panel
//   STACK   20px bold, tabular    the six blue counts Dentally stacks (StackStat)
//   DATA    12.5px bold, tabular  every other numeral, and patient names
//   TITLE   .text-title (13px)    EVERY heading on the screen - see below
//   META    11px medium           row labels, reasons, prose, period captions
//   MICRO   10px medium           the quiet counters hanging off a heading or a
//                                 row: a day, a duration, a site, "N shown"
//
// Two sizes sit outside it and both are drawn rather than read: 9px for the
// invoiced axis ticks, the row initials and the caveat glyph, and the page
// title's own 15px line. Adding a size means changing this list.
//
// HEADINGS ARE SENTENCE CASE, in the house .text-title token rather than
// anything local. This screen carried fifteen 10px uppercase labels across six
// call sites, every one of them the same hand-copied class string, and three
// sibling <h2>s within one scroll wore three different treatments. PRODUCT.md
// asks for sentence-case headings while the other house token, .text-label, is
// uppercase BY DEFINITION - the two cannot both be honoured, and .text-title is
// the one that can. It costs 3px of height per heading and buys one heading
// treatment for the whole product: SectionCard's <h3> is already this token.
// ---------------------------------------------------------------------------

/** The two rendered numeral sizes. Nothing on this screen sits between them. */
export type FigureSize = "data" | "figure";

const FIGURE_SIZES: Record<FigureSize, string> = {
  data: "text-[12.5px] tracking-[-0.2px]",
  figure: "text-[22px] tracking-[-0.6px]",
};

/**
 * A panel heading: sentence case, hairline under it. Numbers are the content.
 *
 * Navy rather than muted, because the sub-headings inside a panel now share the
 * same size token and rank has to be carried by something. Colour carries it:
 * the panel's own name is ink, the sub-columns under it are muted.
 */
export function PanelTitle({
  children,
  right,
  className,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-2 border-b border-line pb-1", className)}>
      <h3 className="text-title text-navy">{children}</h3>
      {right ? <span className="text-[10px] font-medium text-faint">{right}</span> : null}
    </div>
  );
}

/**
 * The standing-in text for a figure we could not source.
 *
 * The reason travels with it (as a title, and reachable from the caveat row
 * under the band) rather than being swallowed, so nobody has to guess whether a
 * blank means "nothing happened" or "we could not read it".
 */
export function Unavailable({
  reason,
  className,
}: {
  reason: string | null;
  className?: string;
}) {
  return (
    <span
      title={reason ?? undefined}
      className={cn("text-[12.5px] font-medium text-faint", className)}
    >
      Unavailable
    </span>
  );
}

/** A whole-number metric rendered at one of the two sizes, or its reason. */
export function Count({
  metric,
  size = "data",
  className,
}: {
  metric: Metric;
  size?: FigureSize;
  className?: string;
}) {
  if (metric.value === null) return <Unavailable reason={metric.reason} className={className} />;
  return (
    <span className={cn("font-bold tabular-nums text-navy", FIGURE_SIZES[size], className)}>
      {num(metric.value)}
    </span>
  );
}

/** A money metric in whole pence, or its reason. */
export function Money({
  metric,
  size = "data",
  negative = false,
  className,
}: {
  metric: Metric;
  size?: FigureSize;
  /** Render the figure as money owed TO the practice, the way Dentally prints it. */
  negative?: boolean;
  className?: string;
}) {
  if (metric.value === null) return <Unavailable reason={metric.reason} className={className} />;
  const pence = negative ? -Math.abs(metric.value) : metric.value;
  return (
    <span className={cn("font-bold tabular-nums text-navy", FIGURE_SIZES[size], className)}>
      {formatPenceGbp(pence)}
    </span>
  );
}

/** A UDA figure. Two decimals, because a contract is measured to the hundredth. */
export function Uda({ metric, className }: { metric: Metric; className?: string }) {
  if (metric.value === null) return <Unavailable reason={metric.reason} className={className} />;
  return (
    <span className={cn("font-bold tabular-nums text-navy", FIGURE_SIZES.data, className)}>
      {metric.value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

/** A tiny label sitting under a numeral. Labels recede, numbers lead. */
export function FigureLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-medium text-muted">{children}</span>;
}

/**
 * A counted figure with its label stacked UNDERNEATH it, in blue.
 *
 * This is how Dentally prints the patient, treatment plan and UDA counts, and
 * reproducing it is the point: those six figures are the ones a practice manager
 * reads at a glance, and on our previous label-left-figure-right rows they were
 * 12.5px and lost against the money. Stacked, the numeral leads and the label
 * explains it, which is the correct order for a figure somebody is scanning for.
 *
 * Blue rather than navy because Dentally colours exactly these figures and no
 * others, which is what makes the column readable as counts rather than as more
 * money. blue-royal is the lead blue and stays well above AA at this size.
 *
 * Numerals stay tabular so a column of them aligns, and the practice has
 * five-digit counts (49,403 active patients), so nothing here may assume three.
 */
export function StackStat({
  metric,
  label,
  decimals = 0,
}: {
  metric: Metric;
  label: string;
  /** UDAs are measured to the hundredth, because a contract is. */
  decimals?: 0 | 2;
}) {
  return (
    <div className="min-w-0 py-[3px]">
      {metric.value === null ? (
        <Unavailable reason={metric.reason} className="block text-[13px]" />
      ) : (
        <b className="block truncate text-[20px] font-bold leading-[1.15] tracking-[-0.5px] tabular-nums text-blue-royal">
          {decimals === 2
            ? metric.value.toLocaleString("en-GB", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : num(metric.value)}
        </b>
      )}
      {/* 11px, the screen's META step. It was 10.5px, which is a size no other
          thing on the page used and which half-pixel-rounds differently per
          browser; the labels are single short words and truncate anyway. */}
      <span className="mt-[1px] block truncate text-[11px] font-medium text-muted">{label}</span>
    </div>
  );
}

/** A label-and-figure pair on one dense line, figure right aligned. */
export function Line({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[2px]">
      <span className="text-[11px] font-medium text-muted">
        {label}
        {hint ? <span className="ml-1 text-[10px] font-normal text-faint">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/**
 * A footnote under a panel, for anything the panel had to leave out.
 *
 * The band's four panels no longer use this: their caveats are collected into
 * the one row under the band. It remains for the appointment list's cap note,
 * which sits at the foot of the page where a full sentence costs nothing.
 */
export function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] font-normal leading-[1.45] text-faint">{children}</p>;
}
