"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import type { AppointmentRecord } from "@/lib/dentally/read";

// The diary board in the locked flat language: a display-type date header with
// the count as a quiet caption, segment-style filters, and the day view as the
// Home diary's hairline slot rows (time gutter, 7px status dot, name 600 with
// the reason muted, quiet right meta; a tinted tag only for the no-show state).
// The week grid stays a grid, with its chrome quieted to hairlines.

const STATE_DOT: Record<string, string> = {
  booked: "bg-status-blue",
  completed: "bg-status-green",
  did_not_attend: "bg-status-red",
  cancelled: "bg-line-strong",
  pending: "bg-status-blue",
};
const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  completed: "Completed",
  did_not_attend: "No-show",
  cancelled: "Cancelled",
  pending: "Pending",
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}
function shiftDay(dayIso: string, by: number): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dayIso: string): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // days since Monday
  return shiftDay(dayIso, -offset);
}
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}
function longDate(dayIso: string): string {
  return new Date(`${dayIso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
function weekLabel(dayIso: string): string {
  const mon = mondayOf(dayIso);
  const sun = shiftDay(mon, 6);
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  return `${fmt(mon, { day: "numeric", month: "short" })} – ${fmt(sun, { day: "numeric", month: "short", year: "numeric" })}`;
}
function dow(dayIso: string): string {
  return new Date(`${dayIso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}
function dnum(dayIso: string): number {
  return new Date(`${dayIso}T00:00:00Z`).getUTCDate();
}

export function CalendarBoard({
  appointments,
  sites,
  nowIso,
  initialSiteFilter = "all",
}: {
  appointments: AppointmentRecord[];
  sites: { id: string; name: string }[];
  nowIso: string;
  initialSiteFilter?: string;
}) {
  const today = nowIso.slice(0, 10);
  const [day, setDay] = useState(today);
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
            <NavBtn aria-label="Previous" onClick={() => setDay(shiftDay(day, -step))}>
              <ChevronLeft size={16} />
            </NavBtn>
            <button
              type="button"
              onClick={() => setDay(today)}
              className="pressable rounded-lg border border-line-strong bg-card px-3 py-1 text-xs font-medium text-ink hover:bg-card-muted"
            >
              Today
            </button>
            <NavBtn aria-label="Next" onClick={() => setDay(shiftDay(day, step))}>
              <ChevronRight size={16} />
            </NavBtn>
          </div>
        </div>
      </header>

      {view === "day" ? (
        <>
          {/* Quiet 7-day strip: plain numbers, the selected day as the navy chip
              (the mini-month idiom), today's numeral in blue. */}
          <div className="mt-4 grid grid-cols-7 gap-1.5">
            {strip.map((d) => {
              const isSel = d === day;
              const isToday = d === today;
              const count = countByDay.get(d) ?? 0;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  className={cn(
                    "pressable flex flex-col items-center rounded-lg px-1 py-2 transition-colors",
                    isSel ? "bg-navy" : "hover:bg-[#f7f9fc]",
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
              icon={CalendarDays}
              title="Nothing booked"
              description="No appointments on this day for the selected site."
              className="mt-4"
            />
          ) : (
            <div className="mt-2">
              {dayRows.map((a) => (
                <div
                  key={a.id}
                  className="grid grid-cols-[46px_8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-[11px] last:border-0"
                >
                  <span className="text-xs font-medium tabular-nums text-faint">{hhmm(a.start)}</span>
                  <span
                    aria-hidden
                    title={STATE_LABEL[a.state] ?? a.state}
                    className={cn("h-[7px] w-[7px] rounded-full", STATE_DOT[a.state] ?? "bg-line-strong")}
                  />
                  <span className="min-w-0 truncate">
                    <span className="text-[13.5px] font-semibold text-navy">{a.patientName}</span>
                    <span className="ml-2 text-[12.5px] text-muted">
                      {a.reason ?? "Appointment"}
                      {a.practitioner ? ` · ${a.practitioner}` : ""}
                    </span>
                    <span className="sr-only">{STATE_LABEL[a.state] ?? a.state}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    {sites.length > 1 ? (
                      <span className="hidden text-[11.5px] text-faint sm:inline">{siteName(a.siteId)}</span>
                    ) : null}
                    {a.state === "did_not_attend" ? (
                      <span className="rounded-md border border-tint-red-line bg-tint-red px-2 py-[2.5px] text-[11.5px] font-medium text-status-red">
                        No-show
                      </span>
                    ) : a.state === "cancelled" ? (
                      <span className="text-[11.5px] font-medium text-faint">Cancelled</span>
                    ) : (
                      <span className="text-[11.5px] font-medium text-muted">{a.durationMin} min</span>
                    )}
                  </span>
                </div>
              ))}
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
              return (
                <div key={d} className="flex flex-col rounded-lg border border-line">
                  <button
                    type="button"
                    onClick={() => {
                      setDay(d);
                      setView("day");
                    }}
                    className="flex flex-col items-center border-b border-line py-2 transition-colors hover:bg-[#f7f9fc]"
                  >
                    <span className="text-[10px] font-medium uppercase tracking-wide text-faint">{dow(d)}</span>
                    <span className={cn("text-sm font-semibold tabular-nums", isToday ? "text-blue-royal" : "text-navy")}>
                      {dnum(d)}
                    </span>
                  </button>
                  <div className="flex flex-1 flex-col p-1.5">
                    {list.length === 0 ? (
                      <span className="py-3 text-center text-[11px] text-faint">—</span>
                    ) : (
                      list.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            setDay(d);
                            setView("day");
                          }}
                          className="rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[#f7f9fc]"
                        >
                          <span className="flex items-center gap-1.5">
                            <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", STATE_DOT[a.state] ?? "bg-line-strong")} />
                            <span className="text-[11px] font-medium tabular-nums text-navy">{hhmm(a.start)}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted">{a.patientName}</span>
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
      className="pressable flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-card text-muted hover:bg-card-muted hover:text-navy"
    >
      {children}
    </button>
  );
}
