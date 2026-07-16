import { cn } from "@/lib/utils";

// Mini month calendar for the Home rail: the current London month with activity
// dots and a Booked / To confirm / Risk legend. The page only loads TODAY's
// appointments, so only today carries accurate dots; every other day renders as
// a plain quiet day rather than inventing activity. When a month-level
// appointments feed exists, extend the per-cell `dots` below to mark every day
// (the cell markup already supports it). A pure server component.

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

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

export function MiniMonth({
  now,
  counts,
}: {
  now: Date;
  /** Today's activity, from data the page already loads. */
  counts: { booked: number; toConfirm: number; risk: number };
}) {
  const { y, m, day: today } = londonYMD(now);
  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "long",
    year: "numeric",
  }).format(now);
  const cells = monthCells(y, m, today);

  // Which dot colours today has earned. On the navy today-pill the dots render
  // muted (like the mock); the legend below carries the colour coding.
  const todayDots = [
    counts.booked > 0,
    counts.toConfirm > 0,
    counts.risk > 0,
  ].filter(Boolean).length;

  return (
    <div className="rounded-card border border-line bg-card p-4 shadow-card">
      <p className="px-1 text-sm font-extrabold tracking-[-0.01em] text-navy">{monthLabel}</p>

      <div className="mt-2 grid grid-cols-7 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} className="pb-1 text-[10px] font-bold uppercase tracking-[0.04em] text-muted">
            {w}
          </span>
        ))}
        {cells.map((c, i) => (
          <span key={i} className="flex items-center justify-center py-0.5">
            <span
              className={cn(
                "relative inline-flex h-8 w-8 items-center justify-center rounded-full text-caption tabular-nums",
                c.isToday
                  ? "bg-navy font-bold text-on-navy"
                  : c.inMonth
                    ? "text-ink"
                    : "text-line-strong",
              )}
            >
              {c.n}
              {c.isToday && todayDots > 0 ? (
                <span className="absolute bottom-1 flex gap-0.5" aria-hidden="true">
                  {Array.from({ length: todayDots }).map((_, d) => (
                    <i key={d} className="h-1 w-1 rounded-full bg-on-navy-muted" />
                  ))}
                </span>
              ) : null}
            </span>
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[10.5px] font-semibold text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="h-1.5 w-1.5 rounded-full bg-blue-dark" />
          Booked <b className="text-navy">{counts.booked}</b>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-1.5 w-1.5 rounded-full bg-status-amber" />
          To confirm <b className="text-navy">{counts.toConfirm}</b>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-1.5 w-1.5 rounded-full bg-status-red" />
          Risk <b className="text-navy">{counts.risk}</b>
        </span>
      </div>
    </div>
  );
}
