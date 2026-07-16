import type { BriefSection } from "@/lib/daily-brief/types";
import { cn } from "@/lib/utils";

// The Home rail's "Needs attention" cards: the top line of each daily-brief
// section as a soft tinted block (bold title, one-line detail, a white urgency
// pill and an arrow action), mirroring the approved mock. Built purely from the
// brief the page already loads; the full section lists stay one click away on
// the Morning brief page. A pure server component.

type Priority = "high" | "medium" | "low";

const TONE: Record<Priority, { wrap: string; ink: string }> = {
  high: { wrap: "border-tint-red-line bg-tint-red", ink: "text-status-red" },
  medium: { wrap: "border-tint-amber-line bg-tint-amber", ink: "text-status-amber" },
  low: { wrap: "border-tint-blue-line bg-tint-blue", ink: "text-status-blue" },
};

const URGENCY: Record<Priority, string> = {
  high: "Now",
  medium: "Today",
  low: "This week",
};

// Per-section action labels; anything unmapped falls back to "Open".
const ACTION: Record<string, string> = {
  noshow: "Confirm now",
  chase: "Review list",
  overnight: "Review calls",
  money: "Chase payments",
  compliance: "Review items",
  arriving: "See the list",
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
      <h3 className="text-title text-navy">Needs attention</h3>
      {cards.length === 0 ? (
        <p className="mt-3 text-caption text-muted">Nothing needs attention right now.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {cards.map(({ key, item }) => {
            const tone = TONE[item.priority] ?? TONE.low;
            return (
              <a
                key={key}
                href={item.href ?? fallbackHref}
                className={cn(
                  "pressable flex flex-col gap-1.5 rounded-[18px] border p-4 shadow-chip",
                  tone.wrap,
                )}
              >
                <div className="flex items-start gap-2">
                  <b className="min-w-0 flex-1 text-caption font-bold leading-snug text-navy">
                    {item.title}
                  </b>
                  <span
                    className={cn(
                      "shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.04em]",
                      tone.ink,
                    )}
                  >
                    {URGENCY[item.priority] ?? "Today"}
                  </span>
                </div>
                <p className="text-caption text-muted">{item.detail}</p>
                <span className={cn("text-caption font-bold", tone.ink)}>
                  {ACTION[key] ?? "Open"} →
                </span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
