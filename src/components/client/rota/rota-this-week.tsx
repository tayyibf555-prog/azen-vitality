"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Loader2, Sparkles, Clock, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import type { RotaShift, RotaStaff } from "@/lib/rota/types";
import {
  ROTA_WEEKDAYS,
  dayLabel,
  roleLabel,
  siteName,
  timeLabel,
  weekdayOf,
} from "./shared";

// The "This week" tab: the generated rota.
//
// There is no GET-shifts route, so we POST /api/rota/generate to (idempotently)
// generate and read back the upcoming shift set in one call. The button re-runs the
// same call to fill any newly-open slots, showing how many new shifts were created.
// Shifts are grouped by day (Mon..Sat) then site, each row showing the staff member,
// role, time and a status pill (scheduled = info/blue, notified = success/green).

interface GenerateResponse {
  ok?: boolean;
  generated?: number;
  inserted?: number;
  shifts?: RotaShift[];
  error?: string;
}

/** A day bucket with its shifts, resolved staff names attached. */
interface DayGroup {
  dayKey: string; // YYYY-MM-DD
  weekdayLabel: string;
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

  // Group shifts by day (only Mon..Sat, in order), then within a day keep them
  // ordered by site and start time (the API already returns date/time-sorted).
  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, RotaShift[]>();
    for (const shift of shifts) {
      const wd = weekdayOf(shift.shiftDate);
      if (!wd || !ROTA_WEEKDAYS.includes(wd)) continue;
      const list = byDay.get(shift.shiftDate) ?? [];
      list.push(shift);
      byDay.set(shift.shiftDate, list);
    }
    return [...byDay.keys()]
      .sort()
      .map((dayKey) => ({
        dayKey,
        weekdayLabel: dayLabel(dayKey),
        shifts: [...(byDay.get(dayKey) ?? [])].sort(
          (a, b) =>
            a.siteId.localeCompare(b.siteId) ||
            a.startTime.localeCompare(b.startTime) ||
            a.role.localeCompare(b.role),
        ),
      }));
  }, [shifts]);

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
        ) : groups.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No shifts yet"
            description="Generate the rota and we will fill each open day from your sites' opening hours and staff availability, then text every staff member their upcoming shifts."
          >
            {generateButton}
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.dayKey} className="rounded-xl border border-line bg-card-muted/30">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h4 className="text-sm font-semibold text-navy">{group.weekdayLabel}</h4>
                  <span className="text-xs text-muted">
                    {group.shifts.length} {group.shifts.length === 1 ? "shift" : "shifts"}
                  </span>
                </div>
                <ul className="divide-y divide-line">
                  {group.shifts.map((shift) => {
                    const person = staffById[shift.staffId];
                    const notified = shift.status === "notified";
                    return (
                      <li
                        key={shift.id ?? `${shift.staffId}-${shift.shiftDate}-${shift.startTime}`}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-navy">
                            {person?.name ?? "Unassigned"}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                            <span>{roleLabel(shift.role)}</span>
                            <span aria-hidden>&middot;</span>
                            <span>{siteName(clientSlug, shift.siteId)}</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-ink">
                            <Clock size={14} className="text-muted" />
                            {timeLabel(shift.startTime)}&ndash;{timeLabel(shift.endTime)}
                          </span>
                          <StatusPill tone={notified ? "success" : "info"}>
                            {notified ? "Notified" : "Scheduled"}
                          </StatusPill>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
