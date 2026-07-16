import type { BriefSection } from "@/lib/daily-brief/types";
import { cn } from "@/lib/utils";

// The Home rail's "Needs attention" list, in the locked flat language: a plain
// section title + hairline, then whisper-tinted cards (8px radius, tint fill +
// tint hairline) each carrying a full-saturation status dot, a 600-weight
// title, a one-line detail and a right-aligned quiet urgency. Built purely from
// the brief the page already loads; the full section lists stay one click away
// on the Morning brief page. A pure server component.

type Priority = "high" | "medium" | "low";

const TONE: Record<Priority, { wrap: string; dot: string }> = {
  high: { wrap: "border-tint-red-line bg-tint-red", dot: "bg-status-red" },
  medium: { wrap: "border-tint-amber-line bg-tint-amber", dot: "bg-status-amber" },
  low: { wrap: "border-tint-blue-line bg-tint-blue", dot: "bg-status-blue" },
};

const URGENCY: Record<Priority, string> = {
  high: "Now",
  medium: "Today",
  low: "This week",
};

const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function NeedsAttention({
  sections,
  fallbackHref,
}: {
  sections: BriefSection[];
  /** Where a card links when its brief line carries no deep link. */
  fallbackHref: string;
}) {
  const cards = sections
    .filter((s) => s.key !== "diary" && s.items.length > 0)
    .map((s) => ({ key: s.key, item: s.items[0] }))
    .sort((a, b) => RANK[a.item.priority] - RANK[b.item.priority])
    .slice(0, 4);

  return (
    <section>
      <h3 className="border-b border-line pb-2.5 text-title text-navy">Needs attention</h3>
      {cards.length === 0 ? (
        <p className="mt-3 text-caption font-normal text-muted">Nothing needs attention right now.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {cards.map(({ key, item }) => {
            const tone = TONE[item.priority] ?? TONE.low;
            return (
              <a
                key={key}
                href={item.href ?? fallbackHref}
                className={cn(
                  "pressable flex items-start gap-2.5 rounded-[8px] border p-3",
                  tone.wrap,
                )}
              >
                <span aria-hidden className={cn("mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full", tone.dot)} />
                <span className="min-w-0 flex-1">
                  <b className="block text-[12.5px] font-semibold leading-snug text-navy">{item.title}</b>
                  <span className="text-[11.5px] text-muted">{item.detail}</span>
                </span>
                <span className="whitespace-nowrap text-[10.5px] font-medium text-faint">
                  {URGENCY[item.priority] ?? "Today"}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
