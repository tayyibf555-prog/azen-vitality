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

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}
function shiftDay(dayIso: string, by: number): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
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

export function CalendarBoard({
  appointments,
  sites,
  nowIso,
}: {
  appointments: AppointmentRecord[];
  sites: { id: string; name: string }[];
  nowIso: string;
}) {
  const today = nowIso.slice(0, 10);
  const [day, setDay] = useState(today);
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of appointments) {
      if (siteFilter !== "all" && a.siteId !== siteFilter) continue;
      m.set(dayKey(a.start), (m.get(dayKey(a.start)) ?? 0) + 1);
    }
    return m;
  }, [appointments, siteFilter]);

  const rows = useMemo(
    () =>
      appointments
        .filter((a) => dayKey(a.start) === day)
        .filter((a) => siteFilter === "all" || a.siteId === siteFilter)
        .sort((a, b) => (a.start < b.start ? -1 : 1)),
    [appointments, day, siteFilter],
  );

  // A 7-day strip centred on the selected day for quick navigation.
  const strip = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 3)), [day]);

  return (
    <SectionCard
      title={longDate(day)}
      description={`${rows.length} appointment${rows.length === 1 ? "" : "s"}${siteFilter === "all" ? "" : ` at ${siteName(siteFilter)}`}.`}
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
          <div className="flex items-center gap-1">
            <NavBtn aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
              <ChevronLeft size={16} />
            </NavBtn>
            <button
              type="button"
              onClick={() => setDay(today)}
              className="rounded-full border border-line-strong bg-card px-3 py-1 text-xs font-semibold text-ink hover:bg-card-muted"
            >
              Today
            </button>
            <NavBtn aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))}>
              <ChevronRight size={16} />
            </NavBtn>
          </div>
        </div>
      }
    >
      {/* Week strip */}
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
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}
              </span>
              <span className={cn("text-base font-extrabold", isToday ? "text-blue-dark" : "text-navy")}>
                {new Date(`${d}T00:00:00Z`).getUTCDate()}
              </span>
              <span className="mt-0.5 h-4 text-[10px] tabular-nums text-muted">{count > 0 ? `${count} appt` : ""}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing booked" description="No appointments on this day for the selected site." className="m-0" />
      ) : (
        <ol className="space-y-2">
          {rows.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-4 rounded-lg border border-line bg-card px-4 py-3"
            >
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
