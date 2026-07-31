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
// which is why it read as unrelated pieces rather than one instrument. It now
// runs four, and nothing else:
//
//   FIGURE  22px bold, tabular    the money and the totals that lead a panel
//   DATA    12.5px bold, tabular  every other numeral, and patient names
//   META    11px medium           row labels, reasons, prose
//   LABEL   10px semibold caps    panel and column headings
//
// The page title is the single exception at 15px, and it is a line, not a hero.
// ---------------------------------------------------------------------------

/** The two rendered numeral sizes. Nothing on this screen sits between them. */
export type FigureSize = "data" | "figure";

const FIGURE_SIZES: Record<FigureSize, string> = {
  data: "text-[12.5px] tracking-[-0.2px]",
  figure: "text-[22px] tracking-[-0.6px]",
};

/** A panel heading: small, quiet, hairline under it. Numbers are the content. */
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
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">{children}</h3>
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
      <span className="mt-[1px] block truncate text-[10.5px] font-medium text-muted">{label}</span>
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
