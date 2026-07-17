import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn, num } from "@/lib/utils";

/**
 * A quiet big-numeral text stat (the locked flat language); the boxed KPI card
 * is gone. Numerals are the ONLY place 700 weight is allowed; labels sit small
 * and medium underneath. The `icon` prop is accepted for call-site
 * compatibility but no longer rendered (decorative accent, removed by the
 * accent-discipline rule). `emphasis` renders the numeral a step larger.
 *
 * `dot` prefixes the numeral with a 7px status dot (a bg-* utility class), the
 * mock's day-stat idiom: place a set of these in a `flex flex-wrap gap-x-7
 * gap-y-4` row (not a grid) to get the inline dot-prefixed stats row.
 */
export function StatCard({
  label,
  value,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  icon,
  dot,
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
  /** A bg-* utility (e.g. "bg-status-amber") that tints a 7px dot before the numeral. */
  dot?: string;
  /** Positive or negative percentage change. `goodWhenUp` flips colour logic. */
  delta?: { value: number; goodWhenUp?: boolean };
  hint?: string;
  /** Render the numeral a step larger (the row's one headline figure). */
  emphasis?: boolean;
  className?: string;
}) {
  const up = delta ? delta.value >= 0 : false;
  const good = delta ? (delta.goodWhenUp ?? true) === up : false;

  return (
    <div className={className}>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-bold tabular-nums tracking-[-0.4px] text-navy",
            emphasis ? "text-[26px]" : "text-[22px]",
          )}
        >
          {dot ? (
            <i aria-hidden className={cn("mr-2 inline-block h-[7px] w-[7px] rounded-full align-[3px]", dot)} />
          ) : null}
          {typeof value === "number" ? num(value) : value}
        </span>
        {delta ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium tabular-nums",
              good ? "text-status-green" : "text-status-red",
            )}
          >
            {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(delta.value)}%
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[11px] font-medium text-muted">{label}</p>
      {hint ? <p className="mt-0.5 text-[11px] font-normal text-faint">{hint}</p> : null}
    </div>
  );
}
