import { ArrowRight, Check, Clock, AlertTriangle, CalendarDays } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/primitives";
import type { DiarySlot, DiarySlotState, TodayDiary } from "@/lib/home/diary";
import { cn } from "@/lib/utils";

// The Home hero: today's diary as an hour-row timeline (the approved mock's
// information architecture). A time gutter on the left, the day's appointments
// as soft tinted pill chips grouped per hour, and quiet rows for hours with
// nothing booked. The day stats sit inline in the heading row as text stats.
// A plain presentational server component: no state, no function props.

// Per-state chip styling: a pale tint + hairline + a white rounded icon square.
const CHIP: Record<
  Exclude<DiarySlotState, "gap">,
  { wrap: string; square: string; icon: LucideIcon; flag?: string }
> = {
  completed: {
    wrap: "bg-tint-green border-tint-green-line",
    square: "text-status-green",
    icon: Check,
  },
  next: {
    wrap: "bg-tint-royal border-tint-royal-line ring-1 ring-blue-royal/25",
    square: "text-status-royal",
    icon: ArrowRight,
  },
  booked: {
    wrap: "bg-tint-blue border-tint-blue-line",
    square: "text-status-blue",
    icon: Clock,
  },
  risk: {
    wrap: "bg-tint-red border-tint-red-line",
    square: "text-status-red",
    icon: AlertTriangle,
    flag: "Risk",
  },
};

function SlotChip({ slot }: { slot: DiarySlot }) {
  if (slot.state === "gap") return null;
  const chip = CHIP[slot.state];
  const Icon = chip.icon;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 shadow-chip",
        chip.wrap,
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-white",
          chip.square,
        )}
      >
        <Icon size={13} aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate text-caption font-bold text-navy" title={slot.label}>
        {slot.label}
      </span>
      <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted">{slot.time}</span>
      {chip.flag ? (
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-status-red">
          {chip.flag}
        </span>
      ) : null}
    </div>
  );
}

interface HourRow {
  hour: number;
  chips: DiarySlot[];
  gaps: number;
}

/** Group the day's slots into hour rows spanning the diary's active range. */
function toHourRows(slots: DiarySlot[]): HourRow[] {
  const byHour = new Map<number, { chips: DiarySlot[]; gaps: number }>();
  for (const s of slots) {
    const h = Number(s.time.slice(0, 2));
    if (!Number.isFinite(h)) continue;
    const row = byHour.get(h) ?? { chips: [], gaps: 0 };
    if (s.state === "gap") row.gaps += 1;
    else row.chips.push(s);
    byHour.set(h, row);
  }
  const hours = [...byHour.keys()];
  if (hours.length === 0) return [];
  const min = Math.min(...hours);
  const max = Math.max(...hours);
  const rows: HourRow[] = [];
  for (let h = min; h <= max; h++) {
    const row = byHour.get(h);
    const chips = (row?.chips ?? []).slice().sort((a, b) => a.time.localeCompare(b.time));
    rows.push({ hour: h, chips, gaps: row?.gaps ?? 0 });
  }
  return rows;
}

export function DiaryTimeline({
  diary,
  clientSlug,
  stats,
}: {
  diary: TodayDiary;
  clientSlug: string;
  /** The day's headline counts, shown inline in the heading row as text stats. */
  stats: { booked: number; toConfirm: number; gaps: number };
}) {
  const calendarHref = `/c/${clientSlug}/calendar`;
  const noshowHref = `/c/${clientSlug}/no-show-defence`;
  const rows = toHourRows(diary.slots);
  const nextHour = diary.next ? Number(diary.next.time.slice(0, 2)) : null;

  return (
    <section className="min-w-0">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-3">
        <h2 className="text-title text-navy">Today&rsquo;s diary</h2>
        <div className="ml-auto flex items-baseline gap-5 text-caption text-muted">
          <span>
            <b className="text-sm font-extrabold tabular-nums text-navy">{stats.booked}</b> booked
          </span>
          <span>
            <b className="text-sm font-extrabold tabular-nums text-navy">{stats.toConfirm}</b> to confirm
          </span>
          <span>
            <b className="text-sm font-extrabold tabular-nums text-navy">{stats.gaps}</b>{" "}
            {stats.gaps === 1 ? "gap" : "gaps"}
          </span>
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing in the diary today"
          description="Booked appointments appear here with risk and gaps marked."
          className="mt-4"
        />
      ) : (
        <>
          <div>
            {rows.map(({ hour, chips, gaps }) => (
              <div
                key={hour}
                className="grid grid-cols-[52px_minmax(0,1fr)] items-start gap-3 border-b border-line py-2.5 last:border-0"
              >
                <div
                  className={cn(
                    "pt-1.5 text-caption font-bold tabular-nums",
                    hour === nextHour ? "text-blue-royal" : "text-muted",
                  )}
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {chips.map((s) => (
                    <SlotChip key={s.id} slot={s} />
                  ))}
                  {chips.length === 0 ? (
                    <span className="py-1.5 text-caption text-muted/80">
                      No bookings.
                      {gaps > 0 ? (
                        <>
                          {" "}
                          {gaps} open {gaps === 1 ? "slot" : "slots"},{" "}
                          <a href={noshowHref} className="font-semibold text-blue-dark hover:underline">
                            offer to the waitlist
                          </a>
                          .
                        </>
                      ) : null}
                    </span>
                  ) : gaps > 0 ? (
                    <a
                      href={noshowHref}
                      className="py-1 text-caption font-semibold text-blue-dark hover:underline"
                    >
                      +{gaps} open {gaps === 1 ? "slot" : "slots"}
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-caption text-muted">
            {diary.fillPercent !== null ? `${diary.fillPercent}% full` : "No slots"}
            {diary.gapCount > 0
              ? ` · ${diary.gapCount} gap${diary.gapCount === 1 ? "" : "s"} offerable`
              : ""}
            {" · "}
            <a href={calendarHref} className="font-semibold text-blue-dark hover:underline">
              Full diary
            </a>
          </p>
        </>
      )}
    </section>
  );
}
