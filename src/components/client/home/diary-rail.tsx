import { ArrowRight, Check, CalendarDays } from "lucide-react";
import { SectionCard, EmptyState } from "@/components/primitives";
import type { TodayDiary } from "@/lib/home/diary";
import { cn } from "@/lib/utils";

// The Home page's glanceable "Today's diary" rail: every slot of the day with its
// state at a glance — done ticks, the highlighted next patient, high no-show-risk
// dots and gap-to-fill markers. A plain presentational component (no state, no
// function props) so it renders server-side with the page.

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
          <ul className="space-y-0.5">
            {diary.slots.map((s) => (
              <li
                key={s.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm",
                  s.state === "next" ? "bg-blue-dark/10 font-semibold text-navy" : "text-ink",
                )}
              >
                <span className="w-11 shrink-0 tabular-nums text-xs text-muted">{s.time}</span>
                {s.state === "completed" ? (
                  <Check size={14} className="shrink-0 text-success" aria-label="Seen" />
                ) : s.state === "next" ? (
                  <ArrowRight size={14} className="shrink-0 text-blue-dark" aria-label="Next" />
                ) : s.state === "risk" ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-warning"
                    role="img"
                    aria-label="High no-show risk"
                  />
                ) : s.state === "gap" ? (
                  <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-line-strong" aria-hidden="true" />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-line-strong" aria-hidden="true" />
                )}
                {s.state === "gap" ? (
                  <span className="min-w-0 truncate text-muted">
                    Gap ·{" "}
                    <a href={noshowHref} className="font-semibold text-blue-dark hover:underline">
                      offer to waitlist
                    </a>
                  </span>
                ) : (
                  <span className="min-w-0 truncate" title={s.label}>
                    {s.label}
                    {s.state === "risk" ? <span className="text-warning"> · risk</span> : null}
                  </span>
                )}
              </li>
            ))}
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
