import { cn } from "@/lib/utils";

/**
 * A content SECTION in the locked flat language (aesthetic-mock2): a small
 * 600-weight title, a hairline underneath, then content and whitespace, no
 * card box, no shadow, no boxes-in-boxes. The name is kept so every existing
 * call site sweeps to the new construction without edits; the legacy `plain`
 * prop is accepted (it is now the only rendering).
 */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  plain,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Legacy flag from the earlier boxed design; every section is plain now. */
  plain?: boolean;
}) {
  return (
    <section className={className}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
          <div className="min-w-0">
            {title ? <h3 className="text-title text-navy">{title}</h3> : null}
            {description ? <p className="mt-0.5 text-caption font-normal text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={cn("pt-4", bodyClassName)}>{children}</div>
    </section>
  );
}
