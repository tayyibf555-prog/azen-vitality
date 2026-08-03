"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, LogIn, LogOut, UserCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatCard, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { durationLabel, londonTimeLabel } from "@/lib/clock/pairing";
import type { ClockKind, ClockStaff, TodayRow, TodayView } from "@/lib/clock/types";
import { CheckInActivity } from "./check-in-activity";
import {
  ANOMALY_TONE,
  KIND_LABEL,
  STATE_DOT,
  STATE_LABEL,
  STATE_ORDER,
  roleLabel,
  siteLabel,
} from "./shared";

// The staff check-in screen. It renders a TodayView exactly as the server built
// it (src/lib/clock/pairing.ts): every state, duration, count and exception
// arrives already decided, so there is no rule in this file to get wrong.

interface TodayResponse {
  ok?: boolean;
  ready?: boolean;
  canManage?: boolean;
  me?: ClockStaff | null;
  view?: TodayView;
  error?: string;
}

/**
 * The NETWORK half on its own, outside the component and holding no state: it
 * either resolves with a good payload or throws. Separating it is what lets the
 * mount effect keep its setState inside a `.then` callback (see the effect below)
 * while the reload-after-a-clock path awaits the same function.
 */
async function readToday(clientSlug: string): Promise<TodayResponse & { view: TodayView }> {
  const res = await fetch(`/api/staff-check-in?client=${encodeURIComponent(clientSlug)}`);
  const data = (await res.json().catch(() => ({}))) as TodayResponse;
  if (!res.ok || !data.ok || !data.view) {
    throw new Error(data.error || `Could not load today's check-ins (${res.status}).`);
  }
  return { ...data, view: data.view };
}

export function CheckInWorkspace({ clientSlug }: { clientSlug: string }) {
  const [view, setView] = useState<TodayView | null>(null);
  const [me, setMe] = useState<ClockStaff | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyStaffId, setBusyStaffId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Applying a good payload, and applying a failure, are ONE function each, shared
  // by the mount effect and by the reload after a clock so the two cannot drift.
  const applyLoaded = useCallback((data: TodayResponse & { view: TodayView }) => {
    setView(data.view);
    setMe(data.me ?? null);
    setCanManage(Boolean(data.canManage));
    setReady(data.ready !== false);
    setLoadError(null);
    setLoading(false);
  }, []);

  const applyFailure = useCallback((err: unknown) => {
    setLoadError(err instanceof Error ? err.message : "Could not load today's check-ins.");
    setView(null);
    setLoading(false);
  }, []);

  // THE FETCH IS IN THE EFFECT, THE setState IS IN ITS CALLBACK — the same shape as
  // useDiaryDay (src/components/client/calendar/use-diary-day.ts), which is the
  // house pattern for this exact job. Two reasons, and the lint rule is the lesser:
  //
  //  - it stops the mount doing a render, a synchronous setState and a second render
  //    before the request has even been issued (react-hooks/set-state-in-effect);
  //  - `cancelled` retires an in-flight answer when the client changes or the screen
  //    unmounts, which the previous `void load()` did not. On THIS screen a late
  //    answer is worse than most: it repaints who is currently on the premises.
  useEffect(() => {
    let cancelled = false;
    readToday(clientSlug)
      .then((data) => {
        if (!cancelled) applyLoaded(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) applyFailure(err);
      });
    return () => {
      cancelled = true;
    };
  }, [clientSlug, applyLoaded, applyFailure]);

  // The reload after somebody clocks in or out. Called from the event handler only,
  // never from an effect. It deliberately does NOT put the spinner back: the row
  // that was just tapped has its own busy state, and blanking the whole list to a
  // spinner after every tap is what made it feel like the tap had failed.
  const reload = useCallback(async () => {
    try {
      applyLoaded(await readToday(clientSlug));
    } catch (err) {
      applyFailure(err);
    }
  }, [clientSlug, applyLoaded, applyFailure]);

  async function clock(staffId: string, kind: ClockKind) {
    if (busyStaffId) return;
    setBusyStaffId(staffId);
    setActionError(null);
    try {
      const res = await fetch("/api/staff-check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, staffId, kind }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `That could not be recorded (${res.status}).`);
      await reload();
      setReloadKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "That could not be recorded.");
    } finally {
      setBusyStaffId(null);
    }
  }

  const myRow = view?.rows.find((r) => r.staffId === me?.id) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="In now"
          value={view?.inNow ?? 0}
          dot="bg-status-green"
          hint="Clocked in and still here"
          emphasis
        />
        <StatCard
          label="Expected"
          value={view?.expected ?? 0}
          dot="bg-status-blue"
          hint="On the rota, not clocked in yet"
        />
        <StatCard
          label="Clocked out"
          value={view?.clockedOut ?? 0}
          dot="bg-line-strong"
          hint="Worked today and left"
        />
        <StatCard
          label="To look at"
          value={view?.notes.length ?? 0}
          dot="bg-status-amber"
          hint="Raised for a human, nobody is blocked"
        />
      </div>

      {!ready ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-sm text-status-amber">
          Clocking is not switched on for this practice yet, so nothing has been recorded. Once it
          is, today&apos;s taps appear here.
        </p>
      ) : null}

      {actionError ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <SectionCard
        title="You"
        description="Clock yourself in when you arrive and out when you leave. Your login proves who you are."
      >
        {me && myRow ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card-muted/20 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-navy">{me.name}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {myRow.state === "in" && myRow.since
                  ? `Clocked in at ${londonTimeLabel(myRow.since)}, ${durationLabel(myRow.openMinutes ?? 0)} so far.`
                  : myRow.minutes !== null
                    ? `Clocked out. ${durationLabel(myRow.minutes)} recorded today.`
                    : "Not clocked in yet today."}
              </p>
            </div>
            <Button
              variant={myRow.nextKind === "in" ? "primary" : "secondary"}
              onClick={() => clock(me.id, myRow.nextKind)}
              disabled={busyStaffId !== null}
            >
              {busyStaffId === me.id ? (
                <Loader2 size={16} className="animate-spin" />
              ) : myRow.nextKind === "in" ? (
                <LogIn size={16} />
              ) : (
                <LogOut size={16} />
              )}
              {KIND_LABEL[myRow.nextKind]}
            </Button>
          </div>
        ) : (
          <p className="rounded-xl border border-line bg-card-muted/20 px-4 py-3 text-[13px] text-muted">
            Your login is not linked to a staff record, so there is nothing to clock. The practice
            manager can link you on the rota, or record your attendance for you.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Today"
        description="Who is in, who is expected, and anything worth a look. Exceptions are raised for a human to explain, never enforced against anybody."
      >
        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {loadError}
          </p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading today&apos;s check-ins...
          </div>
        ) : !view || view.rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody on the rota here yet"
            description="Add your team on the Staff Rota and they will appear here, ready to clock in and out."
          />
        ) : (
          <div className="space-y-5">
            {STATE_ORDER.map((state) => {
              const rows = view.rows.filter((r) => r.state === state);
              if (rows.length === 0) return null;
              return (
                <div key={state} className="space-y-2">
                  <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <span className={cn("inline-block h-[7px] w-[7px] rounded-full", STATE_DOT[state])} aria-hidden />
                    {STATE_LABEL[state]}
                    <span className="font-medium tabular-nums text-faint">{rows.length}</span>
                  </p>
                  <ul className="space-y-1.5">
                    {rows.map((row) => (
                      <PersonRow
                        key={row.staffId}
                        row={row}
                        clientSlug={clientSlug}
                        canManage={canManage}
                        busy={busyStaffId === row.staffId}
                        disabled={busyStaffId !== null}
                        onClock={clock}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {canManage ? <CheckInActivity clientSlug={clientSlug} reloadKey={reloadKey} /> : null}
    </div>
  );
}

/** One person's row. Renders the computed row; decides nothing about it. */
function PersonRow({
  row,
  clientSlug,
  canManage,
  busy,
  disabled,
  onClock,
}: {
  row: TodayRow;
  clientSlug: string;
  canManage: boolean;
  busy: boolean;
  disabled: boolean;
  onClock: (staffId: string, kind: ClockKind) => void;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-navy">{row.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-muted">
          {roleLabel(row.role)}
          <span aria-hidden> &middot; </span>
          {siteLabel(clientSlug, row.siteId)}
          {row.shifts.length > 0 ? (
            <>
              <span aria-hidden> &middot; </span>
              rostered {row.shifts[0].startTime.slice(0, 5)} to {row.shifts[0].endTime.slice(0, 5)}
            </>
          ) : null}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {row.sessions.map((session) => (
            <span
              key={session.inAt}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card-muted/30 px-2 py-[2.5px] text-[11.5px] tabular-nums text-ink"
            >
              <UserCheck size={12} className="text-muted" />
              {londonTimeLabel(session.inAt)} to {session.outAt ? londonTimeLabel(session.outAt) : "now"}
              {session.minutes !== null ? (
                <span className="text-muted">({durationLabel(session.minutes)})</span>
              ) : null}
            </span>
          ))}
          {row.notes.map((note) => (
            <StatusPill key={`${note.kind}-${note.at ?? ""}`} tone={ANOMALY_TONE[note.kind]}>
              {note.label}
            </StatusPill>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {row.state === "in" ? (
          <span className="text-[12px] tabular-nums text-muted">
            {durationLabel(row.openMinutes ?? 0)} in
          </span>
        ) : row.minutes !== null ? (
          <span className="text-[12px] tabular-nums text-muted">{durationLabel(row.minutes)}</span>
        ) : null}

        {canManage ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onClock(row.staffId, row.nextKind)}
            disabled={disabled}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : row.nextKind === "in" ? (
              <LogIn size={14} />
            ) : (
              <LogOut size={14} />
            )}
            {KIND_LABEL[row.nextKind]}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
