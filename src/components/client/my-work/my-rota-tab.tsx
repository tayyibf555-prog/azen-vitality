"use client";

import { useMemo } from "react";
import { CalendarClock, Info } from "lucide-react";
import { EmptyState, SectionCard, StatusPill } from "@/components/primitives";
import { addDayKey } from "@/lib/absence/rules";
import { groupShiftsByDay, myRota, panelStateFor, type SelfShift } from "@/lib/my-work/rules";
import { PanelShell } from "./panel-shell";
import { useSelfServiceRead } from "./use-self-service";
import { dayLabel, myShiftsUrl, timeRangeLabel } from "./shared";

// MY ROTA — the shifts that have been PUBLISHED to me, and nothing else.
//
// A draft rota is a manager thinking out loud. Showing one to the person who
// would have to turn up for it is worse than showing no rota at all, so
// `myRota` (in @/lib/my-work/rules, under test) requires a publish stamp to be
// PRESENT before a shift renders. A shift with no stamp — because the week was
// never published, because the publish columns are not applied yet, or because
// a read forgot the filter — is withheld and COUNTED, so this tab can say "the
// rota for these days has not been published yet" instead of the flatly wrong
// "you are not working".
//
// The read is the rota lane's `GET /api/rota/shifts?...&mine=1` (see shared.ts
// for the contract). Until that lands, every state here is an honest failure.

/** How far ahead a person's own rota is worth showing. */
const WINDOW_DAYS = 27;

interface ShiftsResponse {
  ok?: boolean;
  shifts?: SelfShift[];
  error?: string;
}

export function MyRotaTab({
  clientSlug,
  today,
  selfStaffId,
}: {
  clientSlug: string;
  /** London day key, resolved on the server so SSR and the browser agree. */
  today: string;
  /** The session's staff id, or null when the login is not linked. */
  selfStaffId: string | null;
}) {
  const to = useMemo(() => addDayKey(today, WINDOW_DAYS), [today]);
  const url = selfStaffId ? myShiftsUrl(clientSlug, today, to) : null;
  const { data, loading, failure } = useSelfServiceRead<ShiftsResponse>(url);

  const view = useMemo(() => myRota(data?.shifts ?? [], selfStaffId), [data, selfStaffId]);
  const days = useMemo(() => groupShiftsByDay(view.shifts), [view.shifts]);

  const state = panelStateFor({
    subject: "your shifts",
    consequence: "there are no shifts to show",
    loading,
    linked: selfStaffId !== null,
    failure,
    count: view.shifts.length,
  });

  const next = view.shifts[0];

  return (
    <SectionCard
      title="My rota"
      description={`Shifts your practice manager has published to you, from ${dayLabel(today)} to ${dayLabel(to)}. Anything still in draft is not shown.`}
      actions={
        state.kind === "ready" && next ? (
          <StatusPill tone="info">
            <CalendarClock size={13} />
            Next in {dayLabel(next.shiftDate)}, {next.startTime}
          </StatusPill>
        ) : null
      }
    >
      <div className="space-y-4">
        <PanelShell
          state={state}
          loadingLabel="Loading your shifts..."
          empty={
            view.withheld > 0 ? (
              // NOT an empty state. Shifts for these dates exist; they have not
              // been published, which is a different sentence and the true one.
              <p className="flex items-start gap-2 rounded-xl border border-line bg-card-muted/20 px-4 py-3 text-[13px] text-muted">
                <Info size={16} className="mt-0.5 shrink-0" />
                <span>
                  Nothing has been published to you yet for these dates. There{" "}
                  {view.withheld === 1 ? "is 1 shift" : `are ${view.withheld} shifts`} in the draft rota
                  waiting for your practice manager to publish. Drafts change, so they are not shown here.
                </span>
              </p>
            ) : (
              <EmptyState
                icon={CalendarClock}
                title="No published shifts in the next four weeks"
                description="When your practice manager publishes the rota, the shifts you are on appear here."
              />
            )
          }
        >
          <div className="space-y-3">
            {view.withheld > 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12.5px] text-status-amber">
                <Info size={15} className="mt-0.5 shrink-0" />
                <span>
                  {view.withheld === 1 ? "1 further shift is" : `${view.withheld} further shifts are`} in
                  the draft rota for these dates and have not been published yet.
                </span>
              </p>
            ) : null}

            <ul className="divide-y divide-line rounded-xl border border-line">
              {days.map((day) => (
                <li key={day.dayKey} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3">
                  <p className="w-28 shrink-0 text-sm font-semibold text-navy">{dayLabel(day.dayKey)}</p>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {day.shifts.map((shift, index) => (
                      <div
                        key={shift.id ?? `${shift.shiftDate}-${shift.startTime}-${index}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1"
                      >
                        <span className="text-sm tabular-nums text-ink">
                          {timeRangeLabel(shift.startTime, shift.endTime)}
                        </span>
                        {shift.role ? (
                          <span className="text-[12.5px] text-muted">{shift.role}</span>
                        ) : null}
                        {shift.status === "notified" ? (
                          <StatusPill tone="success">Confirmed to you</StatusPill>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </PanelShell>
      </div>
    </SectionCard>
  );
}
