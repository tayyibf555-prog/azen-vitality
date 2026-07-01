import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[15px] border border-dashed border-line-strong bg-card-muted/50 px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-royal/10 text-blue-royal">
          <Icon size={24} />
        </span>
      ) : null}
      <h3 className="text-lg text-navy">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}
