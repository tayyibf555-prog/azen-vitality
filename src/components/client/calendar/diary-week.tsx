"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { layoutColumn } from "./diary-grid";
import { dow, dnum } from "./calendar-logic";
import {
  columnCounts,
  interiorGaps,
  type DiaryAppointment,
  type Zoom,
} from "./diary-view";
import { DiaryGrid, type GridColumn } from "./diary-day";

// ---------------------------------------------------------------------------
// Week view: the identical grid with days across instead of clinicians, for ONE
// clinician, which is Dentally's own week model.
//
// Everyone at once is deliberately NOT offered: seven days by thirteen
// clinicians is 91 columns, and eight lanes in a 112px column is a 14px block
// with no text on it. This is a knowing regression from a whole-practice week;
// the mitigation is the seven-day strip above, which carries whole-practice
// counts per day in BOTH views and is always on screen.
// ---------------------------------------------------------------------------

export interface WeekDayInput {
  dayKey: string;
  appointments: DiaryAppointment[];
  /** False for a day outside the window the server actually fetched. */
  inWindow: boolean;
  isToday: boolean;
  /** The now-line's offset inside this day's column, when it is today. */
  nowTop: number | null;
}

export function DiaryWeek({
  days,
  clinicianName,
  bounds,
  zoom,
  ariaLabel,
  countsUnavailable,
  onPickDay,
  focusedId,
  onFocusItem,
  onOpen,
  onKeyDown,
  describedById,
  selectedDay,
}: {
  days: WeekDayInput[];
  clinicianName: string | null;
  bounds: { startMin: number; endMin: number };
  zoom: Zoom;
  ariaLabel: string;
  countsUnavailable: boolean;
  /** Drills through to that day in day view, which is what staff already expect. */
  onPickDay: (dayKey: string) => void;
  focusedId: string | null;
  onFocusItem: (colIndex: number, appt: DiaryAppointment) => void;
  onOpen: (appt: DiaryAppointment) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  describedById: string;
  selectedDay: string;
}) {
  const columns: GridColumn[] = useMemo(
    () =>
      days.map((d) => {
        const placed = d.inWindow ? layoutColumn(d.appointments) : [];
        const summary = !d.inWindow
          ? "Not loaded"
          : countsUnavailable
            ? "Not loaded"
            : columnCounts(d.appointments);
        const unavailable = !d.inWindow || countsUnavailable;
        return {
          key: d.dayKey,
          headerId: `diary-week-${d.dayKey}`,
          headerLabel: `${dow(d.dayKey)} ${dnum(d.dayKey)}, ${summary}`,
          header: (
            <>
              <span className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
                  {dow(d.dayKey)}
                </span>
                <span
                  className={cn(
                    "text-[12.5px] font-bold tabular-nums tracking-[-0.2px]",
                    d.isToday ? "text-blue-royal" : "text-navy",
                  )}
                >
                  {dnum(d.dayKey)}
                </span>
              </span>
              <span
                className={cn(
                  "block truncate text-[10px] leading-[1.25] tabular-nums",
                  unavailable ? "font-semibold text-ink" : "font-medium text-muted",
                )}
              >
                {summary}
              </span>
            </>
          ),
          onHeaderClick: d.inWindow ? () => onPickDay(d.dayKey) : undefined,
          headerDisabled: !d.inWindow,
          headerTitle: d.inWindow ? "Open this day" : "Not loaded",
          marked: d.dayKey === selectedDay,
          placed,
          gaps: unavailable ? [] : interiorGaps(placed, bounds.startMin, bounds.endMin, zoom),
          clinicianName,
          nowTop: d.nowTop,
        };
      }),
    [days, clinicianName, bounds.startMin, bounds.endMin, zoom, countsUnavailable, onPickDay, selectedDay],
  );

  return (
    <DiaryGrid
      columns={columns}
      bounds={bounds}
      zoom={zoom}
      ariaLabel={ariaLabel}
      mobileKey={selectedDay}
      nowTop={null}
      nowLabel={null}
      focusedId={focusedId}
      onFocusItem={onFocusItem}
      onOpen={onOpen}
      onKeyDown={onKeyDown}
      describedById={describedById}
    />
  );
}
