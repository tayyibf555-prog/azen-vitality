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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hero,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Legacy flag from the gradient-hero design; headers are flat now. */
  hero?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-display text-navy">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-[13px] font-normal text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
