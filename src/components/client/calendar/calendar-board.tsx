"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import type { AppointmentRecord } from "@/lib/dentally/read";

const STATE_TONE: Record<string, Tone> = {
  booked: "info",
  completed: "success",
  did_not_attend: "danger",
  cancelled: "neutral",
  pending: "info",
};
const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  completed: "Completed",
  did_not_attend: "No-show",
  cancelled: "Cancelled",
  pending: "Pending",
};
const STATE_DOT: Record<string, string> = {
  booked: "bg-blue-dark",
  completed: "bg-success",
  did_not_attend: "bg-danger",
  cancelled: "bg-muted",
  pending: "bg-blue-dark",
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
    <SectionCard
      title={view === "day" ? longDate(day) : weekLabel(day)}
      description={
        view === "day"
          ? `${dayRows.length} appointment${dayRows.length === 1 ? "" : "s"}${siteFilter === "all" ? "" : ` at ${siteName(siteFilter)}`}.`
          : `${weekTotal} appointment${weekTotal === 1 ? "" : "s"} this week${siteFilter === "all" ? "" : ` at ${siteName(siteFilter)}`}.`
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {sites.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              <FilterPill active={siteFilter === "all"} onClick={() => setSiteFilter("all")}>
                All sites
              </FilterPill>
              {sites.map((s) => (
                <FilterPill key={s.id} active={siteFilter === s.id} onClick={() => setSiteFilter(s.id)}>
                  {s.name}
                </FilterPill>
              ))}
            </div>
          ) : null}
          <div className="flex rounded-full border border-line-strong p-0.5">
            {(["day", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors",
                  view === v ? "bg-blue-dark/10 text-blue-dark" : "text-muted hover:text-navy",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <NavBtn aria-label="Previous" onClick={() => setDay(shiftDay(day, -step))}>
              <ChevronLeft size={16} />
            </NavBtn>
            <button
              type="button"
              onClick={() => setDay(today)}
              className="rounded-full border border-line-strong bg-card px-3 py-1 text-xs font-semibold text-ink hover:bg-card-muted"
            >
              Today
            </button>
            <NavBtn aria-label="Next" onClick={() => setDay(shiftDay(day, step))}>
              <ChevronRight size={16} />
            </NavBtn>
          </div>
        </div>
      }
    >
      {view === "day" ? (
        <>
          <div className="mb-4 grid grid-cols-7 gap-1.5">
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
                    "flex flex-col items-center rounded-lg border px-1 py-2 transition-colors",
                    isSel ? "border-blue-dark/40 bg-blue-dark/10" : "border-line bg-card hover:bg-card-muted",
                  )}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{dow(d)}</span>
                  <span className={cn("text-base font-extrabold", isToday ? "text-blue-dark" : "text-navy")}>{dnum(d)}</span>
                  <span className="mt-0.5 h-4 text-[10px] tabular-nums text-muted">{count > 0 ? `${count} appt` : ""}</span>
                </button>
              );
            })}
          </div>

          {dayRows.length === 0 ? (
            <EmptyState icon={CalendarDays} title="Nothing booked" description="No appointments on this day for the selected site." className="m-0" />
          ) : (
            <ol className="space-y-2">
              {dayRows.map((a) => (
                <li key={a.id} className="flex items-center gap-4 rounded-lg border border-line bg-card px-4 py-3">
                  <div className="w-16 shrink-0 text-right">
                    <p className="text-sm font-bold tabular-nums text-navy">{hhmm(a.start)}</p>
                    <p className="text-[11px] text-muted">{a.durationMin} min</p>
                  </div>
                  <div className="h-9 w-px shrink-0 bg-line" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-navy">{a.patientName}</p>
                    <p className="truncate text-xs text-muted">
                      {a.reason ?? "Appointment"}
                      {a.practitioner ? ` · ${a.practitioner}` : ""}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    <p className="text-xs text-muted">{siteName(a.siteId)}</p>
                  </div>
                  <StatusPill tone={STATE_TONE[a.state] ?? "neutral"}>{STATE_LABEL[a.state] ?? a.state}</StatusPill>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-7 gap-2">
            {weekDays.map((d) => {
              const list = apptsByDay.get(d) ?? [];
              const isToday = d === today;
              return (
                <div key={d} className="flex flex-col rounded-lg border border-line bg-card-muted/30">
                  <button
                    type="button"
                    onClick={() => {
                      setDay(d);
                      setView("day");
                    }}
                    className={cn(
                      "flex flex-col items-center border-b border-line py-2 transition-colors hover:bg-card-muted",
                      isToday && "bg-blue-dark/10",
                    )}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{dow(d)}</span>
                    <span className={cn("text-sm font-extrabold", isToday ? "text-blue-dark" : "text-navy")}>{dnum(d)}</span>
                  </button>
                  <div className="flex flex-1 flex-col gap-1 p-1.5">
                    {list.length === 0 ? (
                      <span className="py-3 text-center text-[11px] text-muted">—</span>
                    ) : (
                      list.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            setDay(d);
                            setView("day");
                          }}
                          className="rounded-md border border-line bg-card px-2 py-1.5 text-left transition-colors hover:bg-card-muted"
                        >
                          <span className="flex items-center gap-1.5">
                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[a.state] ?? "bg-muted")} />
                            <span className="text-[11px] font-bold tabular-nums text-navy">{hhmm(a.start)}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-ink">{a.patientName}</span>
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
    </SectionCard>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
        active ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark" : "border-line-strong bg-card text-muted hover:bg-card-muted",
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
      className="flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-card text-muted hover:bg-card-muted hover:text-navy"
    >
      {children}
    </button>
  );
}
