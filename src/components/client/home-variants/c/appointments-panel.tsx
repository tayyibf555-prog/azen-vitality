"use client";

import type { AppointmentsPanel } from "@/lib/dashboard/view";
import { countWork, sharePercent } from "@/lib/home-variants/c/work";
import { cn, num } from "@/lib/utils";
import { FOCUS, PanelHead, Unavailable, WorkLine } from "./parts";
import type { StatusFilter } from "./appointment-list";

// ---------------------------------------------------------------------------
// VARIANT C: the APPOINTMENTS donut.
//
// Two things changed and nothing moved.
//
// SIZE. The ring used to sit small at the top of a wide column with the legend
// stranded under it and dead space beside. It is now drawn to the column, the
// centre is left empty as Dentally leaves it (the total belongs on the heading
// line, where it lines up with the other three panels' headline figures), and
// the legend runs the full width with name, count and share on their own aligned
// columns.
//
// ACTION. Every legend row is the way into the work. Clicking "Did not attend"
// filters the appointment list at the foot of this screen to the ones that were
// missed, which is the list somebody actually needs to see before they can do
// anything about it. The affordance stays quiet: the row looks like a row until
// it is hovered or focused.
//
// Colour is never the only carrier: each state keeps a texture as well as a hue,
// and the same swatch appears beside its figure.
// ---------------------------------------------------------------------------

const SIZE = 168;
const RADIUS = 66;
const STROKE = 21;
const CENTRE = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type SliceKey = "completed" | "cancelled" | "dna";

const SLICES: {
  key: SliceKey;
  label: string;
  colour: string;
  pattern: string | null;
  filter: StatusFilter;
}[] = [
  { key: "completed", label: "Completed", colour: "var(--status-green)", pattern: null, filter: "completed" },
  { key: "cancelled", label: "Cancelled", colour: "var(--status-amber)", pattern: "c-hatch", filter: "cancelled" },
  { key: "dna", label: "Did not attend", colour: "var(--status-red)", pattern: "c-dots", filter: "dna" },
];

function Swatch({ colour, pattern }: { colour: string; pattern: string | null }) {
  return (
    <svg width={10} height={10} aria-hidden className="shrink-0">
      <rect width={10} height={10} rx={2.5} fill={colour} />
      {pattern ? <rect width={10} height={10} rx={2.5} fill={`url(#${pattern})`} /> : null}
    </svg>
  );
}

function Patterns() {
  return (
    <defs>
      <pattern id="c-hatch" width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={5} height={5} fill="transparent" />
        <line x1={0} y1={0} x2={0} y2={5} stroke="#ffffff" strokeWidth={2.2} strokeOpacity={0.55} />
      </pattern>
      <pattern id="c-dots" width={5} height={5} patternUnits="userSpaceOnUse">
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
  onShow,
  showTitle,
}: {
  label: string;
  value: number;
  share: number;
  swatch: React.ReactNode;
  divided?: boolean;
  onShow?: () => void;
  showTitle?: string;
}) {
  const body = (
    <>
      {swatch}
      <span className="min-w-0 flex-1 truncate text-left text-[11.5px] font-medium text-muted underline-offset-[3px] group-hover/leg:underline">
        {label}
      </span>
      <span className="w-12 text-right text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
        {num(value)}
      </span>
      <span className="w-9 text-right text-[11px] font-medium tabular-nums text-faint">
        {share}%
      </span>
    </>
  );

  const shape = cn(
    "flex w-full items-center gap-2 rounded-[5px] px-1 py-[3px]",
    divided && "mt-[3px] border-t border-line pt-[6px]",
  );

  if (!onShow) return <div className={shape}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onShow}
      title={showTitle}
      className={cn(shape, "group/leg transition-colors hover:bg-[#f2f6fc]", FOCUS)}
    >
      {body}
    </button>
  );
}

export function AppointmentsPanelView({
  panel,
  clientSlug,
  onShowStatus,
  note,
}: {
  panel: AppointmentsPanel;
  clientSlug: string;
  /** Filter the appointment list at the foot of this screen. Reading, not writing. */
  onShowStatus: (status: StatusFilter) => void;
  /** A qualification on the total, attached here rather than in a chip row. */
  note: string | null;
}) {
  const total = panel.total.value;

  if (total === null) {
    return (
      <section aria-label="Appointments" className="flex h-full min-w-0 flex-col">
        <PanelHead>Appointments</PanelHead>
        <div className="flex flex-1 items-center pt-2">
          <Unavailable reason={panel.total.reason} className="text-[13px]" />
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

  // Each arc starts where the one before it finished, so the three states read as
  // one continuous ring rather than three overlapping ones.
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

  const work = countWork({
    clientSlug,
    module: "no-show-defence",
    metric: panel.dna,
    verb: "Fill",
    one: "missed slot",
    many: "missed slots",
  });

  return (
    <section aria-label="Appointments" className="flex h-full min-w-0 flex-col">
      <PanelHead
        right={
          <button
            type="button"
            onClick={() => onShowStatus("all")}
            title="Show every appointment in this period in the list below"
            className={cn(
              "text-[15px] font-bold tabular-nums tracking-[-0.3px] text-navy underline-offset-[3px] hover:underline",
              FOCUS,
            )}
          >
            {num(total)}
            {note ? <span className="sr-only"> {note}</span> : null}
          </button>
        }
      >
        Appointments
      </PanelHead>

      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-3">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${total} appointments: ${describe}, still to come ${other}`}
          className="h-auto w-full max-w-[168px] shrink-0"
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

        <div className="w-full min-w-0">
          {SLICES.map((slice) => (
            <LegendRow
              key={slice.key}
              label={slice.label}
              value={values[slice.key]}
              share={sharePercent(values[slice.key], total)}
              swatch={<Swatch colour={slice.colour} pattern={slice.pattern} />}
              onShow={() => onShowStatus(slice.filter)}
              showTitle={`Show the ${slice.label.toLowerCase()} appointments in the list below`}
            />
          ))}
          <LegendRow
            label="Still to come"
            value={other}
            share={sharePercent(other, total)}
            divided
            onShow={() => onShowStatus("remaining")}
            showTitle="Show the appointments still to be completed in the list below"
            swatch={
              <svg width={10} height={10} aria-hidden className="shrink-0">
                <rect width={10} height={10} rx={2.5} fill="var(--card-muted)" />
              </svg>
            }
          />
        </div>
      </div>

      <WorkLine work={work} />
    </section>
  );
}
