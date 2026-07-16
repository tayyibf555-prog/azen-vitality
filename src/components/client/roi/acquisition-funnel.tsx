import { SectionCard } from "@/components/primitives";
import type { FunnelStage } from "@/lib/roi/types";
import { count, percent } from "./format";

// The acquisition funnel, stage by stage. Bars are scaled to each stage's count
// relative to the first (widest) stage, so the narrowing is visible at a glance.
// Each later stage shows the conversion from the stage above it.
export function AcquisitionFunnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.count ?? 1;

  return (
    <SectionCard
      title="Acquisition funnel"
      description="How enquiries narrow down to new patients over the last 30 days."
    >
      <ol className="space-y-3">
        {stages.map((stage, i) => {
          const width = Math.max(8, Math.round((stage.count / top) * 100));
          const isFirst = i === 0;
          const isLast = i === stages.length - 1;
          return (
            <li key={stage.key}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-navy">{stage.label}</span>
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="font-semibold tabular-nums text-navy">{count(stage.count)}</span>
                  {!isFirst ? (
                    <span className="text-xs font-medium tabular-nums text-muted">
                      {percent(stage.conversionFromPrev)} from previous
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="h-7 w-full overflow-hidden rounded-md bg-card-muted">
                <div
                  className={
                    isLast
                      ? "h-full rounded-md bg-success/85"
                      : "h-full rounded-md bg-blue-dark/85"
                  }
                  style={{ width: `${width}%` }}
                  role="presentation"
                />
              </div>
            </li>
          );
        })}
      </ol>
    </SectionCard>
  );
}
