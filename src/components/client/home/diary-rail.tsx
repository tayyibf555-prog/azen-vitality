import { ArrowRight, Check, Clock, AlertTriangle, CalendarDays } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SectionCard, EmptyState } from "@/components/primitives";
import type { DiarySlotState } from "@/lib/home/diary";
import type { TodayDiary } from "@/lib/home/diary";
import { cn } from "@/lib/utils";

// The Home page's glanceable "Today's diary" rail: every slot of the day as a soft
// tinted pill chip with a white rounded icon square (the aesthetic-shell chip
// language) — green ticks for seen, a highlighted next patient, amber/red risk and
// quiet dashed rows for gaps to fill. A plain presentational component (no state,
// no function props) so it renders server-side with the page.

// Per-state chip styling. Each tone is a pale tint + hairline + a white icon square.
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

export function DiaryRail({ diary, clientSlug }: { diary: TodayDiary; clientSlug: string }) {
  const calendarHref = `/c/${clientSlug}/calendar`;
  const noshowHref = `/c/${clientSlug}/no-show-defence`;

  return (
    <SectionCard title="Today's diary" bodyClassName="px-5 py-4">
      {diary.slots.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing in the diary today"
          description="Booked appointments appear here with risk and gaps marked."
        />
      ) : (
        <>
          <ul className="space-y-1.5">
            {diary.slots.map((s) => {
              if (s.state === "gap") {
                // Quiet empty row: a dashed marker and a call to fill it.
                return (
                  <li key={s.id} className="flex items-center gap-2.5 px-1.5 py-1.5 text-sm">
                    <span className="w-11 shrink-0 tabular-nums text-xs text-muted">{s.time}</span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full border border-dashed border-line-strong"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate text-muted">
                      Gap ·{" "}
                      <a href={noshowHref} className="font-semibold text-blue-dark hover:underline">
                        offer to waitlist
                      </a>
                    </span>
                  </li>
                );
              }
              const chip = CHIP[s.state];
              const Icon = chip.icon;
              return (
                <li key={s.id}>
                  <div
                    className={cn(
                      "flex items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-3.5 shadow-chip",
                      chip.wrap,
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-white",
                        chip.square,
                      )}
                    >
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="w-10 shrink-0 tabular-nums text-xs font-semibold text-muted">{s.time}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-navy" title={s.label}>
                      {s.label}
                    </span>
                    {chip.flag ? (
                      <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-status-red">
                        {chip.flag}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
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
    </SectionCard>
  );
}
