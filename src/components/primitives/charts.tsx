import type { MetricPoint } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Tiny inline sparkline. No chart library, keeps the bundle lean. */
export function Sparkline({
  points,
  className,
  stroke = "var(--blue-dark)",
  fill = "var(--blue-light)",
  width = 120,
  height = 36,
}: {
  points: number[];
  className?: string;
  stroke?: string;
  fill?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = height - ((p - min) / span) * (height - 4) - 2;
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)} width={width} height={height}>
      <path d={area} fill={fill} opacity={0.18} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Compact bar chart for a series of labelled points. */
export function BarChart({
  data,
  className,
  height = 160,
  format = (v) => String(v),
}: {
  data: MetricPoint[];
  className?: string;
  height?: number;
  format?: (v: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value)) || 1;
  return (
    <div className={cn("flex items-end gap-2", className)} style={{ height }}>
      {data.map((d) => {
        const h = Math.max(4, (d.value / max) * (height - 28));
        return (
          <div key={d.label} className="group flex flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[10px] font-semibold text-navy opacity-0 transition-opacity group-hover:opacity-100">
              {format(d.value)}
            </span>
            <div
              className="w-full rounded-t-[6px] transition-opacity group-hover:opacity-90"
              style={{ height: h, backgroundImage: "linear-gradient(180deg, #4a97d4, #16559a)" }}
            />
            <span className="text-[10px] text-muted">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal progress meter (0..1) with a label, for recovery rates etc. */
export function ProgressMeter({
  value,
  tone = "var(--blue-dark)",
  className,
}: {
  value: number; // 0..1
  tone?: string;
  className?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-card-muted", className)}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}
