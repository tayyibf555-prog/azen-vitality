import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  hero,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Render as a blue gradient hero band (dashboards, flagship pages). */
  hero?: boolean;
  className?: string;
}) {
  if (hero) {
    return (
      <div
        className={cn(
          "chrome-hero flex flex-wrap items-center justify-between gap-4 rounded-card px-6 py-5 text-white shadow-hero",
          className,
        )}
      >
        <div className="space-y-1">
          <h1 className="text-2xl text-white">{title}</h1>
          {description ? <p className="max-w-2xl text-sm text-white/85">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="space-y-1">
        <h1 className="text-2xl text-navy">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
