"use client";

import { useEffect, useState } from "react";
import { History, Loader2, LogIn, LogOut } from "lucide-react";
import { EmptyState, SectionCard, StatusPill } from "@/components/primitives";
import { londonDayKey } from "@/lib/time/london";
import { londonTimeLabel } from "@/lib/clock/pairing";
import type { ClockAnomalyNote, ClockEvent, ClockStaff } from "@/lib/clock/types";
import { ANOMALY_TONE, SOURCE_LABEL } from "./shared";

// The practice manager's activity list: the raw taps over the last week, in the
// order they happened, plus the exceptions the rules raised across that window.
//
// Raw taps on purpose. The sessions above are DERIVED, and when a derived
// session looks wrong the only way to see why is the events it was built from.
// Approver only, enforced by the route.

interface EventsResponse {
  ok?: boolean;
  ready?: boolean;
  from?: string;
  to?: string;
  events?: ClockEvent[];
  notes?: ClockAnomalyNote[];
  staff?: ClockStaff[];
  error?: string;
}

/** A day's worth of taps, newest day first. */
interface DayGroup {
  dayKey: string;
  events: ClockEvent[];
}

/**
 * The NETWORK half on its own, outside the component and holding no state: it
 * either resolves with a good payload or throws. Separating it is what lets the
 * effect below keep its setState inside a `.then` callback.
 */
async function readActivity(clientSlug: string): Promise<EventsResponse> {
  const res = await fetch(`/api/staff-check-in/events?client=${encodeURIComponent(clientSlug)}`);
  const body = (await res.json().catch(() => ({}))) as EventsResponse;
  if (!res.ok || !body.ok) throw new Error(body.error || `Could not load the activity (${res.status}).`);
  return body;
}

export function CheckInActivity({
  clientSlug,
  reloadKey,
}: {
  clientSlug: string;
  /** Bumped by the workspace after a clock action, so the list refreshes with it. */
  reloadKey: number;
}) {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // THE FETCH IS IN THE EFFECT, THE setState IS IN ITS CALLBACK — the same shape as
  // useDiaryDay (src/components/client/calendar/use-diary-day.ts), which is the
  // house pattern for this exact job. Two reasons, and the lint rule is the lesser:
  //
  //  - it stops the mount doing a render, a synchronous setState and a second render
  //    before the request has even been issued (react-hooks/set-state-in-effect);
  //  - `cancelled` retires an in-flight answer. This list refetches on every bump of
  //    `reloadKey`, which is every clock in and out, so two requests genuinely can be
  //    in flight at once and the older one must not be the one that lands.
  //
  // The spinner is deliberately NOT put back on a reload: the list is already on
  // screen and correct, and blanking it after every tap read as though the tap had
  // cleared the log. `loading` therefore only ever describes the first load.
  useEffect(() => {
    let cancelled = false;
    readActivity(clientSlug)
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load the activity.");
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientSlug, reloadKey]);

  const names = new Map((data?.staff ?? []).map((s) => [s.id, s.name]));

  // Group the ascending event list into days, newest day first.
  const groups: DayGroup[] = [];
  for (const event of [...(data?.events ?? [])].reverse()) {
    const dayKey = londonDayKey(new Date(event.occurredAt));
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) last.events.push(event);
    else groups.push({ dayKey, events: [event] });
  }

  const notes = data?.notes ?? [];

  return (
    <SectionCard
      title="Recent activity"
      description="Every clock event for the last week, exactly as it was recorded, with anything the rules raised."
    >
      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading the activity...
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing recorded yet"
          description="Clock events appear here as soon as somebody clocks in or out."
        />
      ) : (
        <div className="space-y-5">
          {notes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {notes.map((note) => (
                <StatusPill key={`${note.staffId}-${note.kind}-${note.at ?? ""}`} tone={ANOMALY_TONE[note.kind]}>
                  {names.get(note.staffId) ?? "Someone"}
                  <span aria-hidden> &middot; </span>
                  {note.label}
                </StatusPill>
              ))}
            </div>
          ) : null}

          {groups.map((group) => (
            <div key={group.dayKey} className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {new Date(`${group.dayKey}T12:00:00Z`).toLocaleDateString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  timeZone: "Europe/London",
                })}
              </p>
              <ul className="space-y-1">
                {group.events.map((event) => (
                  <li
                    key={event.id ?? `${event.staffId}-${event.occurredAt}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2 text-[12.5px]"
                  >
                    <span className="w-12 shrink-0 tabular-nums font-semibold text-navy">
                      {londonTimeLabel(event.occurredAt)}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-ink">
                      {event.kind === "in" ? (
                        <LogIn size={13} className="text-status-green" />
                      ) : (
                        <LogOut size={13} className="text-muted" />
                      )}
                      {event.kind === "in" ? "Clocked in" : "Clocked out"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-navy">
                      {names.get(event.staffId) ?? "Unknown staff member"}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-faint">
                      {SOURCE_LABEL[event.source] ?? event.source}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
