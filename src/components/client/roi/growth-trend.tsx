import { SectionCard } from "@/components/primitives";
import type { TrendPoint } from "@/lib/roi/types";
import { count, money } from "./format";

// Six-month growth trend in the numbers-first language: the paired bars are
// retired. The latest month reads as a headline numeral with a plain-English
// delta against the start of the window, and the full series sits underneath as
// a hairline table (month, spend, attributed revenue, new patients).
export function GrowthTrend({ trend }: { trend: TrendPoint[] }) {
  const first = trend[0];
  const latest = trend[trend.length - 1];
  const deltaPct =
    first && latest && first.revenueGbp > 0
      ? Math.round(((latest.revenueGbp - first.revenueGbp) / first.revenueGbp) * 100)
      : null;

  return (
    <SectionCard
      title="Growth trend"
      description="Spend against attributed revenue over the last six months, with new patients."
      bodyClassName="pt-1"
    >
      {latest ? (
        <div className="py-3">
          <p className="text-[26px] font-bold tabular-nums tracking-[-0.4px] text-navy">
            {money(latest.revenueGbp)}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">
            Attributed revenue in {latest.month}
            {deltaPct !== null && deltaPct !== 0 ? (
              <>
                ,{" "}
                <span className={deltaPct > 0 ? "font-medium text-status-green" : "font-medium text-status-red"}>
                  {deltaPct > 0 ? "up" : "down"} <span className="tabular-nums">{Math.abs(deltaPct)}%</span>
                </span>{" "}
                on {first.month}
              </>
            ) : deltaPct === 0 ? (
              <>, level with {first.month}</>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2 pr-3 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Month</th>
              <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
                Spend
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
                Revenue
              </th>
              <th className="py-2 pl-3 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
                New patients
              </th>
            </tr>
          </thead>
          <tbody>
            {trend.map((point) => (
              <tr key={point.month} className="border-b border-line last:border-0">
                <td className="py-2.5 pr-3 font-medium text-navy">{point.month}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">{money(point.spendGbp)}</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-navy">
                  {money(point.revenueGbp)}
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-ink">{count(point.newPatients)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
