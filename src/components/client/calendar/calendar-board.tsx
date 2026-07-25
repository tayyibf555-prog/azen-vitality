"use client";

import { useMemo, useState } from "react";
import { EmptyState, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, CalendarDays, AlertTriangle } from "lucide-react";
import { londonDayKey } from "@/lib/time/london";
import type { AppointmentRecord } from "@/lib/dentally/read";
import {
  dayKey,
  shiftDay,
  mondayOf,
  hhmm,
  longDate,
  weekLabel,
  dow,
  dnum,
  clampDayToWindow,
  isWithinWindow,
  stateDotClass,
  stateLabel,
  STATE_BADGE_TONE,
  STATE_BADGE_LABEL,
} from "./calendar-logic";

// The diary board in the locked flat language: a display-type date header with
// the count as a quiet caption, segment-style filters, and the day view as the
// Home diary's hairline slot rows (time gutter, 7px status dot, name 600 with
// the reason muted, quiet right meta; a tinted tag only for the no-show state).
// The week grid stays a grid, with its chrome quieted to hairlines.
//
// All date/time bucketing and formatting is delegated to ./calendar-logic (pure,
// unit-tested there): times render in Europe/London (B1), "today" and every
// day-bucket use the London calendar day, not a UTC slice (B2), and navigation
// is clamped to the window the server actually fetched (B4, see windowFrom/To).

export function CalendarBoard({
  appointments,
  sites,
  nowIso,
  initialSiteFilter = "all",
  loadFailed = false,
  windowFrom,
  windowTo,
}: {
  appointments: AppointmentRecord[];
  sites: { id: string; name: string }[];
  nowIso: string;
  initialSiteFilter?: string;
  /** True when the Dentally read for this window failed outright (B3): render
   *  an amber "could not load" notice instead of a confident empty diary. */
  loadFailed?: boolean;
  /** The [windowFrom, windowTo] day keys the server actually fetched. Navigation
   *  is clamped inside this range (B4) so paging past it can never show an
   *  unloaded, possibly fully-booked day as free. */
  windowFrom: string;
  windowTo: string;
}) {
  // "Today" MUST be the London calendar day, not a UTC slice of nowIso: between
  // 00:00 and 01:00 BST the UTC day is still yesterday (B2).
  const today = londonDayKey(new Date(nowIso));
  const [day, setDay] = useState(() => clampDayToWindow(today, windowFrom, windowTo));
  const [siteFilter, setSiteFilter] = useState<string>(initialSiteFilter);
  const [view, setView] = useState<"day" | "week">("day");
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  const visible = useMemo(
    () => appointments.filter((a) => siteFilter === "all" || a.siteId === siteFilter),
    [appointments, siteFilter],
  );

  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of visible) m.set(dayKey(a.start), (m.get(dayKey(a.start)) ?? 0) + 1);
    return m;
  }, [visible]);

  const dayRows = useMemo(
    () => visible.filter((a) => dayKey(a.start) === day).sort((a, b) => (a.start < b.start ? -1 : 1)),
    [visible, day],
  );

  const weekDays = useMemo(() => {
    const mon = mondayOf(day);
    return Array.from({ length: 7 }, (_, i) => shiftDay(mon, i));
  }, [day]);
  const apptsByDay = useMemo(() => {
    const m = new Map<string, AppointmentRecord[]>();
    for (const a of visible) {
      const k = dayKey(a.start);
      const list = m.get(k);
      if (list) list.push(a);
      else m.set(k, [a]);
    }
    for (const list of m.values()) list.sort((a, b) => (a.start < b.start ? -1 : 1));
    return m;
  }, [visible]);
  const weekTotal = weekDays.reduce((sum, d) => sum + (countByDay.get(d) ?? 0), 0);

  // Day-view 7-day strip centred on the selected day.
  const strip = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 3)), [day]);

  const step = view === "week" ? 7 : 1;
  const canGoPrev = day > windowFrom;
  const canGoNext = day < windowTo;
  const goTo = (d: string) => setDay(clampDayToWindow(d, windowFrom, windowTo));

  return (
    <section>
      {/* Display-type date header with the count caption; controls right-aligned
          above a hairline. */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-3">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.3px] text-navy">
            {view === "day" ? longDate(day) : weekLabel(day)}
          </h2>
          <p className="mt-1 text-caption font-normal text-muted">
            {view === "day"
              ? `${dayRows.length} appointment${dayRows.length === 1 ? "" : "s"}${siteFilter === "all" ? "" : ` at ${siteName(siteFilter)}`}.`
              : `${weekTotal} appointment${weekTotal === 1 ? "" : "s"} this week${siteFilter === "all" ? "" : ` at ${siteName(siteFilter)}`}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sites.length > 1 ? (
            <div
              className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
              role="group"
              aria-label="Filter by site"
            >
              <SegmentBtn active={siteFilter === "all"} onClick={() => setSiteFilter("all")}>
                All sites
              </SegmentBtn>
              {sites.map((s) => (
                <SegmentBtn key={s.id} active={siteFilter === s.id} onClick={() => setSiteFilter(s.id)}>
                  {s.name}
                </SegmentBtn>
              ))}
            </div>
          ) : null}
          <div
            className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
            role="group"
            aria-label="Day or week view"
          >
            {(["day", "week"] as const).map((v) => (
              <SegmentBtn key={v} active={view === v} onClick={() => setView(v)} className="capitalize">
                {v}
              </SegmentBtn>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <NavBtn aria-label="Previous" disabled={!canGoPrev} onClick={() => goTo(shiftDay(day, -step))}>
              <ChevronLeft size={16} />
            </NavBtn>
            <button
              type="button"
              onClick={() => goTo(today)}
              className="pressable rounded-lg border border-line-strong bg-card px-3 py-1 text-xs font-medium text-ink hover:bg-card-muted"
            >
              Today
            </button>
            <NavBtn aria-label="Next" disabled={!canGoNext} onClick={() => goTo(shiftDay(day, step))}>
              <ChevronRight size={16} />
            </NavBtn>
          </div>
        </div>
      </header>

      {loadFailed ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-tint-amber-line bg-tint-amber px-4 py-3 text-[13px] text-status-amber"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">We could not load the diary.</span> Dentally did not respond, so an
            empty day below is NOT confirmation that it is free. Try refreshing shortly.
          </span>
        </div>
      ) : null}

      {view === "day" ? (
        <>
          {/* Quiet 7-day strip: plain numbers, the selected day as the navy chip
              (the mini-month idiom), today's numeral in blue. Days outside the
              loaded window are shown but disabled (B4): their appointments were
              never fetched, so treating them as clickable would risk showing an
              unloaded, possibly fully-booked day as free. */}
          <div className="mt-4 grid grid-cols-7 gap-1.5">
            {strip.map((d) => {
              const isSel = d === day;
              const isToday = d === today;
              const count = countByDay.get(d) ?? 0;
              const inWindow = isWithinWindow(d, windowFrom, windowTo);
              return (
                <button
                  key={d}
                  type="button"
                  disabled={!inWindow}
                  onClick={() => goTo(d)}
                  className={cn(
                    "pressable flex flex-col items-center rounded-lg px-1 py-2 transition-colors",
                    isSel ? "bg-navy" : "hover:bg-[#f7f9fc]",
                    !inWindow && "cursor-not-allowed opacity-40 hover:bg-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "text-[10px] font-medium uppercase tracking-wide",
                      isSel ? "text-white/70" : "text-faint",
                    )}
                  >
                    {dow(d)}
                  </span>
                  <span
                    className={cn(
                      "text-base font-semibold tabular-nums",
                      isSel ? "text-white" : isToday ? "text-blue-royal" : "text-navy",
                    )}
                  >
                    {dnum(d)}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 h-4 text-[10px] tabular-nums",
                      isSel ? "text-white/70" : "text-muted",
                    )}
                  >
                    {count > 0 ? `${count} appt` : ""}
                  </span>
                </button>
              );
            })}
          </div>

          {dayRows.length === 0 ? (
            <EmptyState
              icon={loadFailed ? AlertTriangle : CalendarDays}
              title={loadFailed ? "Diary unavailable" : "Nothing booked"}
              description={
                loadFailed
                  ? "Dentally could not be reached, so this is not confirmed as a free day."
                  : "No appointments on this day for the selected site."
              }
              className="mt-4"
            />
          ) : (
            <div className="mt-2">
              {dayRows.map((a) => {
                const badgeTone = STATE_BADGE_TONE[a.state];
                return (
                  <div
                    key={a.id}
                    className="grid grid-cols-[46px_8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-[11px] last:border-0"
                  >
                    <span className="text-xs font-medium tabular-nums text-faint">{hhmm(a.start)}</span>
                    <span
                      aria-hidden
                      title={stateLabel(a.state)}
                      className={cn("h-[7px] w-[7px] rounded-full", stateDotClass(a.state))}
                    />
                    <span className="min-w-0 truncate">
                      <span className="text-[13.5px] font-semibold text-navy">{a.patientName}</span>
                      <span className="ml-2 text-[12.5px] text-muted">
                        {a.reason ?? "Appointment"}
                        {a.practitioner ? ` · ${a.practitioner}` : ""}
                      </span>
                      <span className="sr-only">{stateLabel(a.state)}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      {sites.length > 1 ? (
                        <span className="hidden text-[11.5px] text-faint sm:inline">{siteName(a.siteId)}</span>
                      ) : null}
                      {badgeTone ? (
                        <StatusPill tone={badgeTone}>{STATE_BADGE_LABEL[a.state]}</StatusPill>
                      ) : a.state === "cancelled" ? (
                        <span className="text-[11.5px] font-medium text-faint">Cancelled</span>
                      ) : (
                        <span className="text-[11.5px] font-medium text-muted">{a.durationMin} min</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="mt-4 overflow-x-auto">
          {/* The week GRID stays; its chrome quiets to hairlines. */}
          <div className="grid min-w-[760px] grid-cols-7 gap-2">
            {weekDays.map((d) => {
              const list = apptsByDay.get(d) ?? [];
              const isToday = d === today;
              const inWindow = isWithinWindow(d, windowFrom, windowTo);
              return (
                <div key={d} className={cn("flex flex-col rounded-lg border border-line", !inWindow && "opacity-50")}>
                  <button
                    type="button"
                    disabled={!inWindow}
                    onClick={() => {
                      goTo(d);
                      setView("day");
                    }}
                    className="flex flex-col items-center border-b border-line py-2 transition-colors hover:bg-[#f7f9fc] disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <span className="text-[10px] font-medium uppercase tracking-wide text-faint">{dow(d)}</span>
                    <span className={cn("text-sm font-semibold tabular-nums", isToday ? "text-blue-royal" : "text-navy")}>
                      {dnum(d)}
                    </span>
                  </button>
                  <div className="flex flex-1 flex-col p-1.5">
                    {list.length === 0 ? (
                      <span className="py-3 text-center text-[11px] text-faint">{inWindow ? ", " : "Not loaded"}</span>
                    ) : (
                      list.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            goTo(d);
                            setView("day");
                          }}
                          className="rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[#f7f9fc]"
                        >
                          <span className="flex items-center gap-1.5">
                            <span
                              aria-hidden
                              title={stateLabel(a.state)}
                              className={cn("h-[7px] w-[7px] shrink-0 rounded-full", stateDotClass(a.state))}
                            />
                            <span className="text-[11px] font-medium tabular-nums text-navy">{hhmm(a.start)}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted">{a.patientName}</span>
                          <span className="sr-only">{stateLabel(a.state)}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function SegmentBtn({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "pressable rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
        className,
      )}
    >
      {children}
    </button>
  );
}

function NavBtn({ children, onClick, ...rest }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className="pressable flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-card text-muted hover:bg-card-muted hover:text-navy disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}
