"use client";

import type { AppointmentsPanel } from "@/lib/dashboard/view";
import { cn, num } from "@/lib/utils";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { PanelTitle, Unavailable } from "./parts";

// ---------------------------------------------------------------------------
// The APPOINTMENTS donut.
//
// The donut stays: the owner considered replacing it and decided against, and
// she reads this shape every morning. What changes is the execution.
//
// It must not rely on colour alone, so each state carries a texture as well as a
// hue (completed solid, cancelled hatched, missed dotted) and the same swatch
// appears beside its figure in the legend. The legend is the accessible version
// of the chart, so the whole panel reads correctly with the graphic ignored.
//
// The ring is only as full as the day is finished. Appointments that are neither
// completed, cancelled nor missed (still ahead of themselves, or in the chair)
// are shown as the remaining track and named, rather than being folded into a
// slice or quietly dropped so the three states add to the total.
//
// LAYOUT. The donut and its legend are one block, sized to the column and set in
// the middle of the panel's share of the band, rather than a small ring floating
// at the top of an otherwise empty column.
// ---------------------------------------------------------------------------

const SIZE = 140;
const RADIUS = 54;
const STROKE = 17;
const CENTRE = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type SliceKey = "completed" | "cancelled" | "dna";

const SLICES: { key: SliceKey; label: string; colour: string; pattern: string | null }[] = [
  { key: "completed", label: "Completed", colour: "var(--status-green)", pattern: null },
  { key: "cancelled", label: "Cancelled", colour: "var(--status-amber)", pattern: "dash-hatch" },
  { key: "dna", label: "Did not attend", colour: "var(--status-red)", pattern: "dash-dots" },
];

function Swatch({ colour, pattern }: { colour: string; pattern: string | null }) {
  return (
    <svg width={10} height={10} aria-hidden className="shrink-0">
      <rect width={10} height={10} rx={2.5} fill={colour} />
      {pattern ? <rect width={10} height={10} rx={2.5} fill={`url(#${pattern})`} /> : null}
    </svg>
  );
}

/** The texture definitions, shared by the ring and the legend swatches. */
function Patterns() {
  return (
    <defs>
      <pattern id="dash-hatch" width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={5} height={5} fill="transparent" />
        <line x1={0} y1={0} x2={0} y2={5} stroke="#ffffff" strokeWidth={2.2} strokeOpacity={0.55} />
      </pattern>
      <pattern id="dash-dots" width={5} height={5} patternUnits="userSpaceOnUse">
        <rect width={5} height={5} fill="transparent" />
        <circle cx={2.5} cy={2.5} r={1.15} fill="#ffffff" fillOpacity={0.6} />
      </pattern>
    </defs>
  );
}

function LegendRow({
  label,
  value,
  share,
  swatch,
  divided = false,
}: {
  label: string;
  value: number;
  share: number;
  swatch: React.ReactNode;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-[2px]",
        divided && "mt-[2px] border-t border-line pt-[4px]",
      )}
    >
      {swatch}
      <dt className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
          {num(value)}
        </span>
        <span className="w-7 text-right text-[10px] font-medium tabular-nums text-faint">
          {share}%
        </span>
      </dd>
    </div>
  );
}

export function AppointmentsDonut({
  panel,
  caveats,
  onOpenCaveat,
}: {
  panel: AppointmentsPanel;
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  const total = panel.total.value;

  if (total === null) {
    return (
      <section aria-label="Appointments" className="flex h-full min-w-0 flex-col">
        <PanelTitle>Appointments</PanelTitle>
        <div className="flex flex-1 items-center pt-2">
          <Unavailable reason={panel.total.reason} />
        </div>
      </section>
    );
  }

  const values: Record<SliceKey, number> = {
    completed: panel.completed.value ?? 0,
    cancelled: panel.cancelled.value ?? 0,
    dna: panel.dna.value ?? 0,
  };
  const other = panel.other.value ?? 0;

  // Each arc starts where the ones before it finished, so the three states read
  // as one continuous ring rather than three overlapping ones.
  const arcs = SLICES.map((slice, index) => {
    const value = values[slice.key];
    const length = total > 0 ? (value / total) * CIRCUMFERENCE : 0;
    const start = SLICES.slice(0, index).reduce(
      (sum, earlier) => sum + (total > 0 ? (values[earlier.key] / total) * CIRCUMFERENCE : 0),
      0,
    );
    return { ...slice, value, length, start };
  });

  const describe = SLICES.map((s) => `${s.label} ${values[s.key]}`).join(", ");

  return (
    <section aria-label="Appointments" className="flex h-full min-w-0 flex-col">
      {/* The total sits on the heading line, where Dentally puts it, rather than
          in the ring. It reads as the panel's headline figure there, it lines up
          with the other three panels' headline figures across the band, and it
          leaves the ring to do the one job a ring is good at: the proportions. */}
      <PanelTitle
        right={
          <span className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
              {num(total)}
            </span>
            <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
          </span>
        }
      >
        Appointments
      </PanelTitle>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-2">
        <div className="relative shrink-0">
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label={`${total} appointments: ${describe}, still to come ${other}`}
          >
            <Patterns />
            {/* The track is what is left of the day, not decoration. */}
            <circle
              cx={CENTRE}
              cy={CENTRE}
              r={RADIUS}
              fill="none"
              stroke="var(--card-muted)"
              strokeWidth={STROKE}
            />
            {arcs.map((arc) =>
              arc.length <= 0 ? null : (
                <g key={arc.key} transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
                  <circle
                    cx={CENTRE}
                    cy={CENTRE}
                    r={RADIUS}
                    fill="none"
                    stroke={arc.colour}
                    strokeWidth={STROKE}
                    strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                    strokeDashoffset={-arc.start}
                  />
                  {arc.pattern ? (
                    <circle
                      cx={CENTRE}
                      cy={CENTRE}
                      r={RADIUS}
                      fill="none"
                      stroke={`url(#${arc.pattern})`}
                      strokeWidth={STROKE}
                      strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                      strokeDashoffset={-arc.start}
                    />
                  ) : null}
                </g>
              ),
            )}
          </svg>
        </div>

        <dl className="w-full min-w-0">
          {SLICES.map((slice) => (
            <LegendRow
              key={slice.key}
              label={slice.label}
              value={values[slice.key]}
              share={total > 0 ? Math.round((values[slice.key] / total) * 100) : 0}
              swatch={<Swatch colour={slice.colour} pattern={slice.pattern} />}
            />
          ))}
          <LegendRow
            label="Still to come"
            value={other}
            share={total > 0 ? Math.round((other / total) * 100) : 0}
            divided
            swatch={
              <svg width={10} height={10} aria-hidden className="shrink-0">
                <rect width={10} height={10} rx={2.5} fill="var(--card-muted)" />
              </svg>
            }
          />
        </dl>
      </div>
    </section>
  );
}

/** Used by the appointment list so a row's state marker matches the donut. */
export function stateSwatchClass(bucket: string): string {
  return cn(
    bucket === "completed" && "bg-status-green",
    bucket === "cancelled" && "bg-status-amber",
    bucket === "dna" && "bg-status-red",
    bucket === "other" && "bg-card-muted",
  );
}
