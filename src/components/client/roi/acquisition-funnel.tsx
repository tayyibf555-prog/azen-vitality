import { SectionCard } from "@/components/primitives";
import type { FunnelStage } from "@/lib/roi/types";
import { count, percent } from "./format";

// The acquisition funnel, stage by stage, in the numbers-first language: the
// bars are retired and each stage reads as a hairline row with its count as a
// quiet numeral and the conversion from the stage above as plain English. The
// footer states the whole-funnel conversion in one sentence.
export function AcquisitionFunnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.count ?? 0;
  const last = stages[stages.length - 1]?.count ?? 0;
  const overallPct = top > 0 ? Math.round((last / top) * 100) : null;

  return (
    <SectionCard
      title="Acquisition funnel"
      description="How enquiries narrow down to new patients over the last 30 days."
      bodyClassName="pt-1"
    >
      <div>
        {stages.map((stage, i) => {
          const isFirst = i === 0;
          const isLast = i === stages.length - 1;
          return (
            <div
              key={stage.key}
              className="flex items-baseline justify-between gap-3 border-b border-line py-3 last:border-0"
            >
              <span className="text-[13px] font-medium text-navy">{stage.label}</span>
              <span className="flex items-baseline gap-2.5">
                <span
                  className={
                    isLast
                      ? "text-[17px] font-bold tabular-nums tracking-[-0.2px] text-status-green"
                      : "text-[17px] font-bold tabular-nums tracking-[-0.2px] text-navy"
                  }
                >
                  {count(stage.count)}
                </span>
                {!isFirst ? (
                  <span className="text-xs font-medium tabular-nums text-muted">
                    {percent(stage.conversionFromPrev)} of previous
                  </span>
                ) : (
                  <span className="text-xs font-medium text-muted">enquiries in</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {overallPct !== null ? (
        <p className="mt-3 text-xs text-muted">
          End to end, <span className="font-medium tabular-nums text-navy">{overallPct}%</span> of
          enquiries became new patients.
        </p>
      ) : null}
    </SectionCard>
  );
}
