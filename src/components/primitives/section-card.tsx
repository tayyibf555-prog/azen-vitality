import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  plain,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Render as a plain section (no card chrome): section title + hairline under
   *  the header, whitespace instead of a box. The aesthetic-shell Home uses this
   *  so cards are reserved for genuinely card-shaped things. */
  plain?: boolean;
}) {
  if (plain) {
    return (
      <section className={className}>
        {(title || actions) && (
          <header className="flex items-center justify-between gap-4 border-b border-line pb-3">
            <div className="space-y-1">
              {title ? <h3 className="text-title text-navy">{title}</h3> : null}
              {description ? <p className="text-caption text-muted">{description}</p> : null}
            </div>
            {actions}
          </header>
        )}
        <div className={cn("pt-4", bodyClassName)}>{children}</div>
      </section>
    );
  }

  return (
    <section className={cn("rounded-card bg-card shadow-card ring-1 ring-line/60", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="space-y-1">
            {title ? <h3 className="text-base text-navy">{title}</h3> : null}
            {description ? <p className="text-xs text-muted">{description}</p> : null}
          </div>
          {actions}
        </header>
      )}
      <div className={cn("p-6", bodyClassName)}>{children}</div>
    </section>
  );
}
