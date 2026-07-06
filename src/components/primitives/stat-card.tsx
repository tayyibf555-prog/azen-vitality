import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn, num } from "@/lib/utils";

export function StatCard({
  label,
  value,
  icon: Icon,
  delta,
  hint,
  emphasis,
  className,
}: {
  label: string;
  /** A number is auto-formatted with thousands separators (1234 -> "1,234"). Pass a
   *  pre-formatted string for currency (gbp()) or any non-numeric value. */
  value: string | number;
  icon?: LucideIcon;
  /** Positive or negative percentage change. `goodWhenUp` flips colour logic. */
  delta?: { value: number; goodWhenUp?: boolean };
  hint?: string;
  /** Render as the solid-blue headline KPI (one per row). */
  emphasis?: boolean;
  className?: string;
}) {
  const up = delta ? delta.value >= 0 : false;
  const good = delta ? (delta.goodWhenUp ?? true) === up : false;

  return (
    <div
      className={cn(
        "rounded-[15px] p-4",
        emphasis
          ? "chrome-hero text-white shadow-hero"
          : "bg-card text-navy shadow-float ring-1 ring-line/60",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-xs font-semibold uppercase tracking-wide",
            emphasis ? "text-white/80" : "text-muted",
          )}
        >
          {label}
        </span>
        {Icon ? (
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-[9px]",
              emphasis ? "bg-white/20 text-white" : "bg-blue-royal/10 text-blue-royal",
            )}
          >
            <Icon size={15} />
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className={cn("text-2xl font-extrabold tracking-tight", emphasis ? "text-white" : "text-navy")}>
          {typeof value === "number" ? num(value) : value}
        </span>
        {delta ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-semibold",
              emphasis ? (good ? "text-[#c7f0d6]" : "text-[#f7c1c1]") : good ? "text-success" : "text-danger",
            )}
          >
            {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(delta.value)}%
          </span>
        ) : null}
      </div>
      {hint ? <p className={cn("mt-1 text-xs", emphasis ? "text-white/70" : "text-muted")}>{hint}</p> : null}
    </div>
  );
}
