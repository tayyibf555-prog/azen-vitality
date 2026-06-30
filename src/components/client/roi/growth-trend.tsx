import { SectionCard } from "@/components/primitives";
import type { TrendPoint } from "@/lib/roi/types";
import { compact, count, money } from "./format";

// Six-month growth trend: paired spend and revenue bars per month (scaled to the
// largest revenue so both stay comparable), with the new-patient count beneath.
// Built from plain divs, no charting dependency.
export function GrowthTrend({ trend }: { trend: TrendPoint[] }) {
  const maxRevenue = Math.max(...trend.map((t) => t.revenueGbp), 1);

  return (
    <SectionCard
      title="Growth trend"
      description="Spend against attributed revenue over the last six months, with new patients."
    >
      <div className="flex items-end justify-between gap-2 sm:gap-4" style={{ height: 200 }}>
        {trend.map((point) => {
          const revenueH = Math.max(4, Math.round((point.revenueGbp / maxRevenue) * 156));
          const spendH = Math.max(4, Math.round((point.spendGbp / maxRevenue) * 156));
          return (
            <div key={point.month} className="group flex flex-1 flex-col items-center gap-2">
              <div className="flex h-[156px] w-full items-end justify-center gap-1">
                <div
                  className="w-3 rounded-t-sm bg-blue-dark/30 transition-colors group-hover:bg-blue-dark/45 sm:w-4"
                  style={{ height: spendH }}
                  title={`Spend ${money(point.spendGbp)}`}
                  role="presentation"
                />
                <div
                  className="w-3 rounded-t-sm bg-blue-dark/85 transition-colors group-hover:bg-blue-dark sm:w-4"
                  style={{ height: revenueH }}
                  title={`Revenue ${money(point.revenueGbp)}`}
                  role="presentation"
                />
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs font-semibold text-navy">{point.month}</span>
                <span className="text-[10px] tabular-nums text-muted">
                  {count(point.newPatients)} new
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-blue-dark/30" aria-hidden />
          Spend
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-blue-dark/85" aria-hidden />
          Attributed revenue
        </span>
        <span className="ml-auto tabular-nums">
          {compact(trend[0]?.revenueGbp ?? 0)} to {compact(trend[trend.length - 1]?.revenueGbp ?? 0)}{" "}
          revenue over six months
        </span>
      </div>
    </SectionCard>
  );
}
