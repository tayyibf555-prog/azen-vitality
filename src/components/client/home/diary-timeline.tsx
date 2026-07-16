import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/primitives";
import type { DiarySlot, TodayDiary } from "@/lib/home/diary";
import { cn } from "@/lib/utils";

// The Home hero: today's diary as flat hairline slot rows (the locked mock's
// construction). Time gutter, a 7px status dot, the patient name (600) with the
// treatment in muted ink, and a right-aligned meta that is EMPTY unless the row
// needs action (risk rows carry a flat tinted tag; gaps read as quiet copy).
// A plain presentational server component: no state, no function props.

const DOT: Record<DiarySlot["state"], string> = {
  completed: "bg-status-green",
  next: "bg-status-blue",
  booked: "bg-status-blue",
  risk: "bg-status-red",
  gap: "bg-line-strong",
};

/** Split "Hannah D · Scale & polish" into a 600-weight name + muted reason. */
function splitLabel(label: string): { name: string; rest: string | null } {
  const i = label.indexOf(" · ");
  if (i === -1) return { name: label, rest: null };
  return { name: label.slice(0, i), rest: label.slice(i + 3) };
}

export function DiaryTimeline({
  diary,
  clientSlug,
}: {
  diary: TodayDiary;
  clientSlug: string;
}) {
  const calendarHref = `/c/${clientSlug}/calendar`;
  const noshowHref = `/c/${clientSlug}/no-show-defence`;
  const nextId = diary.slots.find((s) => s.state === "next")?.id ?? null;

  return (
    <section className="min-w-0">
      <h2 className="flex items-baseline border-b border-line pb-2.5 text-title text-navy">
        Today&rsquo;s diary
        <a href={calendarHref} className="ml-auto text-[11.5px] font-medium text-blue-royal hover:underline">
          Full diary
        </a>
      </h2>

      {diary.slots.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing in the diary today"
          description="Booked appointments appear here with risk and gaps marked."
          className="mt-4"
        />
      ) : (
        <div>
          {diary.slots.map((slot) => {
            const { name, rest } = splitLabel(slot.label);
            const isGap = slot.state === "gap";
            return (
              <div
                key={slot.id}
                className="grid grid-cols-[46px_8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-[11px] last:border-0"
              >
                <span
                  className={cn(
                    "text-xs font-medium tabular-nums",
                    slot.id === nextId ? "text-blue-royal" : "text-faint",
                  )}
                >
                  {slot.time}
                </span>
                <span aria-hidden className={cn("h-[7px] w-[7px] rounded-full", DOT[slot.state])} />
                {isGap ? (
                  <span className="min-w-0 truncate text-[12.5px] text-faint">
                    Open slot.{" "}
                    <a href={noshowHref} className="font-medium text-blue-royal hover:underline">
                      Offer to the waitlist
                    </a>
                    .
                  </span>
                ) : (
                  <span className="min-w-0 truncate" title={slot.label}>
                    <span className="text-[13.5px] font-semibold text-navy">{name}</span>
                    {rest ? <span className="ml-2 text-[12.5px] text-muted">{rest}</span> : null}
                  </span>
                )}
                {slot.state === "risk" ? (
                  <span className="rounded-md border border-tint-red-line bg-tint-red px-2 py-[2.5px] text-[11.5px] font-medium text-status-red">
                    No-show risk
                  </span>
                ) : (
                  <span aria-hidden />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
