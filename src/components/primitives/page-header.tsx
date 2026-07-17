import { cn } from "@/lib/utils";

/**
 * Page header in the locked flat language: display title (24px/600, negative
 * tracking) + quiet description, actions on the right. The old blue-gradient
 * `hero` band is retired; the flag is accepted so call sites need no edits,
 * but every header renders flat (the numbers band is a page's one blue moment).
 */
export function PageHeader({
  title,
  description,
  actions,
  stats,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hero,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /**
   * The module's inline dot-numeral stats, right-aligned on the header row and
   * wrapping below the title only on narrow widths (the one header shape used
   * everywhere). Pass a set of <StatCard> figures; keep them label + value (no
   * hint) so the cluster stays a tidy two-line block beside the title.
   */
  stats?: React.ReactNode;
  /** Legacy flag from the gradient-hero design; headers are flat now. */
  hero?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-x-8 gap-y-4 lg:flex-row lg:flex-wrap lg:items-start lg:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-display text-navy">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-[13px] font-normal text-muted">{description}</p> : null}
      </div>
      {stats || actions ? (
        <div className="flex flex-col items-start gap-3 lg:items-end">
          {stats ? <div className="flex flex-wrap items-start gap-x-6 gap-y-3 lg:justify-end">{stats}</div> : null}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
