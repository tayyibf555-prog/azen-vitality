import { cn } from "@/lib/utils";

// Mini month calendar for the Home rail, in the locked flat language: a plain
// section (title + hairline, no card box), plain day numbers, and a navy square
// (7px radius) for today. The page only loads TODAY's appointments, so no other
// day can honestly carry an activity dot; the per-cell markup below already
// supports the mock's 4px dots — extend `dotFor` when a month-level
// appointments feed exists. A pure server component.

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function londonYMD(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), day: get("day") };
}

interface Cell {
  n: number;
  inMonth: boolean;
  isToday: boolean;
}

function monthCells(y: number, m: number, today: number): Cell[] {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstMondayIdx = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const prevMonthDays = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();

  const cells: Cell[] = [];
  for (let i = firstMondayIdx - 1; i >= 0; i--) {
    cells.push({ n: prevMonthDays - i, inMonth: false, isToday: false });
  }
  for (let n = 1; n <= daysInMonth; n++) {
    cells.push({ n, inMonth: true, isToday: n === today });
  }
  let next = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ n: next++, inMonth: false, isToday: false });
  }
  return cells;
}

/** Activity dot colour for a day, or null. Today-only data for now (see above). */
function dotFor(_cell: Cell): string | null {
  return null;
}

export function MiniMonth({ now }: { now: Date }) {
  const { y, m, day: today } = londonYMD(now);
  const monthName = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "long",
  }).format(now);
  const yearLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "long",
    year: "numeric",
  }).format(now);
  const cells = monthCells(y, m, today);

  return (
    <section>
      <h3 className="border-b border-line pb-2.5 text-title text-navy" title={yearLabel}>
        {monthName}
      </h3>
      <div className="mt-2 grid grid-cols-7 text-center">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="py-1 text-[9.5px] font-medium uppercase text-faint">
            {w}
          </span>
        ))}
        {cells.map((c, i) => {
          const dot = dotFor(c);
          return (
            <span key={i} className="py-[3px] text-[11.5px] tabular-nums">
              {c.isToday ? (
                <span className="inline-block h-[26px] w-[26px] rounded-[7px] bg-navy text-[11.5px] font-semibold leading-[26px] text-white">
                  {c.n}
                </span>
              ) : (
                <span className={cn("block", c.inMonth ? "text-ink" : "text-line-strong")}>
                  {c.n}
                  {dot ? (
                    <em aria-hidden className={cn("mx-auto mt-[1px] block h-1 w-1 rounded-full not-italic", dot)} />
                  ) : null}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </section>
  );
}
