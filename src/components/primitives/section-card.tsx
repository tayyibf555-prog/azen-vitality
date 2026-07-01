import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-[15px] bg-card shadow-float ring-1 ring-line/60", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <div className="space-y-1">
            {title ? <h3 className="text-base text-navy">{title}</h3> : null}
            {description ? <p className="text-xs text-muted">{description}</p> : null}
          </div>
          {actions}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
