"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  Loader2,
  Sparkles,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { RotaShift, RotaStaff } from "@/lib/rota/types";
import {
  ROTA_WEEKDAYS,
  WEEKDAY_SHORT,
  roleLabel,
  siteName,
  timeLabel,
  weekdayOf,
  addDaysKey,
  mondayOf,
  dayOfMonth,
  weekRangeLabel,
  londonTodayKey,
} from "./shared";

// The "This week" tab: the generated rota as a Monday-to-Saturday calendar grid.
//
// There is no GET-shifts route, so we POST /api/rota/generate to (idempotently)
// generate and read back the upcoming shift set in one call. The button re-runs the
// same call to fill any newly-open slots. Shifts span a couple of weeks, so the view
// pages one week at a time: six day columns (Mon..Sat), each holding that day's shifts
// as compact cards with the staff member, role, site, time and notified state.

interface GenerateResponse {
  ok?: boolean;
  generated?: number;
  inserted?: number;
  shifts?: RotaShift[];
  error?: string;
}

/** One day column in the current week's grid. */
interface DayColumn {
  dayKey: string; // YYYY-MM-DD
  short: string; // Mon
  dayNum: string; // 6
  isToday: boolean;
  shifts: RotaShift[];
}

export function RotaThisWeek({
  clientSlug,
  onShiftsLoaded,
}: {
  clientSlug: string;
  /** Reports the loaded shift set up to the workspace so the StatCards stay in sync. */
  onShiftsLoaded: (shifts: RotaShift[]) => void;
}) {
  const [shifts, setShifts] = useState<RotaShift[]>([]);
  const [staffById, setStaffById] = useState<Record<string, RotaStaff>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const [weekIndex, setWeekIndex] = useState(0);

  // Read the current shifts by generating idempotently (no separate read route exists),
  // and load staff so we can show names rather than ids.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [genRes, staffRes] = await Promise.all([
        fetch("/api/rota/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug }),
        }),
        fetch(`/api/rota/staff?client=${encodeURIComponent(clientSlug)}`),
      ]);
      const genData = (await genRes.json().catch(() => ({}))) as GenerateResponse;
      if (!genRes.ok || !genData.ok) {
        throw new Error(genData.error || `Could not load the rota (${genRes.status}).`);
      }
      const staffData = (await staffRes.json().catch(() => ({}))) as { ok?: boolean; staff?: RotaStaff[] };
      const map: Record<string, RotaStaff> = {};
      if (staffRes.ok && staffData.ok) for (const s of staffData.staff ?? []) map[s.id] = s;

      const loaded = genData.shifts ?? [];
      setShifts(loaded);
      setStaffById(map);
      onShiftsLoaded(loaded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the rota.");
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug, onShiftsLoaded]);

  useEffect(() => {
    setResult(null);
    setGenError(null);
    void load();
  }, [load]);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setResult(null);
    setGenError(null);
    try {
      const res = await fetch("/api/rota/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as GenerateResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not generate the rota (${res.status}).`);
      const generated = data.shifts ?? [];
      setShifts(generated);
      const total = generated.length;
      setResult(
        `Generated ${total} ${total === 1 ? "shift" : "shifts"}, staff will be texted their shifts.`,
      );
      onShiftsLoaded(generated);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Could not generate the rota.");
    } finally {
      setGenerating(false);
    }
  }

  // The distinct Mondays covered by the shift set, in order, so the view can page
  // one week at a time.
  const weeks = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const shift of shifts) {
      const wd = weekdayOf(shift.shiftDate);
      if (!wd || !ROTA_WEEKDAYS.includes(wd)) continue;
      set.add(mondayOf(shift.shiftDate));
    }
    return [...set].sort();
  }, [shifts]);

  const clampedIndex = weeks.length ? Math.min(Math.max(weekIndex, 0), weeks.length - 1) : 0;
  const weekStart = weeks[clampedIndex];

  // The six day columns (Mon..Sat) for the selected week, each with its shifts sorted
  // by start time then site then role.
  const columns = useMemo<DayColumn[]>(() => {
    if (!weekStart) return [];
    const today = londonTodayKey();
    return ROTA_WEEKDAYS.map((_, offset) => {
      const dayKey = addDaysKey(weekStart, offset);
      const dayShifts = shifts
        .filter((s) => s.shiftDate === dayKey)
        .sort(
          (a, b) =>
            a.startTime.localeCompare(b.startTime) ||
            a.siteId.localeCompare(b.siteId) ||
            a.role.localeCompare(b.role),
        );
      return {
        dayKey,
        short: WEEKDAY_SHORT[ROTA_WEEKDAYS[offset]],
        dayNum: dayOfMonth(dayKey),
        isToday: dayKey === today,
        shifts: dayShifts,
      };
    });
  }, [weekStart, shifts]);

  const generateButton = (
    <Button variant="primary" size="sm" onClick={generate} disabled={generating}>
      {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
      Generate rota
    </Button>
  );

  return (
    <SectionCard
      title="This week"
      description="The rota is built automatically from each site's opening hours and staff availability. Generate to fill any open slots; staff are then texted their upcoming shifts."
      actions={generateButton}
    >
      <div className="space-y-4">
        {result ? (
          <p className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            {result}
          </p>
        ) : null}
        {genError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {genError}
          </p>
        ) : null}

        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {loadError}
          </p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading the rota...
          </div>
        ) : weeks.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No shifts yet"
            description="Generate the rota and we will fill each open day from your sites' opening hours and staff availability, then text every staff member their upcoming shifts."
          >
            {generateButton}
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {/* Week navigator */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-navy">{weekRangeLabel(weekStart)}</p>
                {weeks.length > 1 ? (
                  <p className="text-xs text-muted">
                    Week {clampedIndex + 1} of {weeks.length}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setWeekIndex(clampedIndex - 1)}
                  disabled={clampedIndex === 0}
                  aria-label="Previous week"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setWeekIndex(clampedIndex + 1)}
                  disabled={clampedIndex >= weeks.length - 1}
                  aria-label="Next week"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* Mon..Sat calendar grid: 2 cols on mobile, 3 on tablet, 6 on desktop. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {columns.map((col) => (
                <div
                  key={col.dayKey}
                  className={cn(
                    "flex min-h-[8rem] flex-col rounded-xl border bg-card-muted/20",
                    col.isToday ? "border-blue/60 ring-1 ring-blue/30" : "border-line",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-baseline justify-between gap-1 rounded-t-xl border-b px-2.5 py-2",
                      col.isToday ? "border-blue/30 bg-blue/5" : "border-line",
                    )}
                  >
                    <span
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide",
                        col.isToday ? "text-blue" : "text-muted",
                      )}
                    >
                      {col.short}
                    </span>
                    <span
                      className={cn(
                        "text-sm font-semibold tabular-nums",
                        col.isToday ? "text-blue" : "text-navy",
                      )}
                    >
                      {col.dayNum}
                    </span>
                  </div>

                  <div className="flex flex-1 flex-col gap-1.5 p-1.5">
                    {col.shifts.length === 0 ? (
                      <span className="m-auto text-xs text-muted/70">Closed</span>
                    ) : (
                      col.shifts.map((shift) => {
                        const person = staffById[shift.staffId];
                        const notified = shift.status === "notified";
                        return (
                          <div
                            key={shift.id ?? `${shift.staffId}-${shift.shiftDate}-${shift.startTime}`}
                            className={cn(
                              "rounded-lg border p-2 text-left",
                              notified
                                ? "border-success/30 bg-success/5"
                                : "border-blue/25 bg-blue/5",
                            )}
                            title={`${person?.name ?? "Unassigned"} · ${roleLabel(shift.role)} · ${siteName(clientSlug, shift.siteId)} · ${notified ? "Notified" : "Scheduled"}`}
                          >
                            <p className="truncate text-xs font-semibold text-navy">
                              {person?.name ?? "Unassigned"}
                            </p>
                            <p className="mt-0.5 flex items-center gap-1">
                              <span
                                className={cn(
                                  "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                                  notified ? "bg-success" : "bg-blue",
                                )}
                                aria-hidden
                              />
                              <span className="text-[11px] tabular-nums text-ink">
                                {timeLabel(shift.startTime)} to {timeLabel(shift.endTime)}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-muted">
                              {roleLabel(shift.role)}
                              <span aria-hidden> &middot; </span>
                              {siteName(clientSlug, shift.siteId)}
                            </p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>

            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-blue" aria-hidden />
                Scheduled
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />
                Notified (texted to staff)
              </span>
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
