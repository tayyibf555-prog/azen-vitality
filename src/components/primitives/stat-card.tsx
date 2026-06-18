import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  icon: Icon,
  delta,
  hint,
  className,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  /** Positive or negative percentage change. `goodWhenUp` flips colour logic. */
  delta?: { value: number; goodWhenUp?: boolean };
  hint?: string;
  className?: string;
}) {
  const up = delta ? delta.value >= 0 : false;
  const good = delta ? (delta.goodWhenUp ?? true) === up : false;

  return (
    <div className={cn("rounded-xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(10,14,26,0.04)]", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {Icon ? (
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
            <Icon size={15} />
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-2xl font-extrabold tracking-tight text-navy">{value}</span>
        {delta ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-semibold",
              good ? "text-success" : "text-danger",
            )}
          >
            {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(delta.value)}%
          </span>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
