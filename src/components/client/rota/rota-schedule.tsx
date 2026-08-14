"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { absenceBlocksShift } from "@/lib/absence/rules";
import type { Absence } from "@/lib/absence/types";
import { isLiveShift, type RotaConfig, type RotaShift, type RotaStaff } from "@/lib/rota/types";
import { pairingViolations, type ShiftEditInput } from "@/lib/rota/edit";
import type { PrePublishSummary } from "@/lib/rota/publish";
import { RotaShiftDialog, type ShiftDraft } from "./rota-shift-dialog";
import { RotaPublishBar, type PublishState } from "./rota-publish-bar";
import {
  ROTA_ROLES,
  WEEKDAY_SHORT,
  addDaysKey,
  addMonths,
  dayOfMonth,
  londonTodayKey,
  mondayOf,
  monthGridDays,
  monthLabel,
  roleLabel,
  roleStyle,
  sameMonth,
  siteName,
  timeLabel,
  weekRangeLabel,
} from "./shared";

// ---------------------------------------------------------------------------
// The rota grid: a week you can edit, a month you can scan, and a Publish step.
//
// ---------------------------------------------------------------------------
// IT READS THE ROTA NOW, INSTEAD OF GENERATING IT.
// ---------------------------------------------------------------------------
// This view used to load by POSTing /api/rota/generate and rendering the
// generator's in-memory output, because no read route existed. Three consequences,
// all of them bugs: the cards had no id (so nothing could be edited), every card
// read as 'scheduled' (so the Notified figure was permanently 0 and the green state
// never appeared once), and simply OPENING THE PAGE wrote to the database.
//
// It now reads GET /api/rota/shifts: real rows, real ids, real statuses, tombstones
// included. Generate is still here as a button, because filling the open slots is a
// thing a manager asks for -- it is just no longer what "look at the rota" means.
//
// COLOUR IS BY ROLE. The question a manager scans for is "is there a nurse on
// Thursday", and a grid tinted by notified-vs-scheduled cannot answer it. Notified
// state is a dot and a ring instead: it matters once, then never again.
//
// LOUD FAILURE. A read that fails renders the reason, never an empty week. An empty
// week and a broken week look identical, and one of them gets a practice staffed
// wrong.
// ---------------------------------------------------------------------------

type ViewMode = "week" | "month";

/** Monday-first, and SEVEN long: both grids start on a Monday and run whole weeks. */
const WEEK_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

interface ShiftsResponse {
  ok?: boolean;
  shifts?: RotaShift[];
  staff?: RotaStaff[];
  config?: RotaConfig;
  absences?: Absence[];
  error?: string;
}

interface PublishResponse {
  ok?: boolean;
  summary?: PrePublishSummary;
  canPublish?: boolean;
  dryRun?: boolean;
  lastPublishedAt?: string | null;
  error?: string;
}

/** One day cell, whichever grid is rendering it. */
interface DayCell {
  dayKey: string;
  short: string;
  dayNum: string;
  isToday: boolean;
  inMonth: boolean;
  shifts: RotaShift[];
}

function byTimeThenSiteThenRole(a: RotaShift, b: RotaShift): number {
  return (
    a.startTime.localeCompare(b.startTime) ||
    a.siteId.localeCompare(b.siteId) ||
    a.role.localeCompare(b.role)
  );
}

export function RotaSchedule({
  clientSlug,
  siteIds,
  onShiftsLoaded,
}: {
  clientSlug: string;
  /** The sites the current view covers, for the site picker in the dialog. */
  siteIds: string[];
  /** Reports the loaded shift set up to the workspace so the StatCards stay in sync. */
  onShiftsLoaded: (shifts: RotaShift[]) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("week");
  // The Monday of the shown week, or the 1st of the shown month.
  const [anchor, setAnchor] = useState<string>(() => mondayOf(londonTodayKey()));

  const [shifts, setShifts] = useState<RotaShift[]>([]);
  const [staff, setStaff] = useState<RotaStaff[]>([]);
  const [config, setConfig] = useState<RotaConfig | null>(null);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ShiftDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const [publishState, setPublishState] = useState<PublishState | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // The window on screen. A week is Mon..Sun; a month grid is six Mon..Sun rows, so
  // both are whole weeks and one read serves either.
  //
  // NOT called `window`: that shadows the global inside every closure in this
  // component, which compiles and then bites the first person who reaches for
  // `window.location`.
  const range = useMemo(() => {
    if (mode === "week") return { from: anchor, to: addDaysKey(anchor, 6) };
    const days = monthGridDays(anchor);
    return { from: days[0], to: days[days.length - 1] };
  }, [mode, anchor]);

  // ---------------------------------------------------------------------------
  // THE VIEW KEY, AND WHY THE RESET HAPPENS DURING RENDER.
  // ---------------------------------------------------------------------------
  // Everything on this screen is about ONE window: `range` is a pure function of
  // (mode, anchor), so this string identifies the week or month being shown.
  //
  // The spinner, the cleared error and the retired publish summary are set HERE,
  // during render, rather than at the top of `load()` — which runs synchronously
  // when the effect below calls it, i.e. a setState inside an effect
  // (react-hooks/set-state-in-effect) AND an extra render before the request has
  // even been issued. This is the use-diary-day house pattern, and it has a
  // correctness half as well as a lint one: last week's publish summary must not
  // sit under this week's heading for a frame, because it names a version and a
  // change count that belong to a different promise.
  const viewKey = `${clientSlug}|${mode}|${anchor}`;
  const [shownKey, setShownKey] = useState(viewKey);
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setLoading(true);
    setLoadError(null);
    setPublishState(null);
    setPublishResult(null);
    setPublishError(null);
  }

  // `read` fetches and RETURNS; `apply` is the only thing that writes state, and
  // the effect calls it from the promise's callback. Same split as
  // use-diary-day / use-self-service, for the same two reasons: a setState
  // reachable synchronously from an effect is a cascading render, and `cancelled`
  // retires an in-flight answer so a slow reply for last week cannot repaint over
  // a faster one for this week.
  const read = useCallback(async (): Promise<{ data: ShiftsResponse | null; error: string | null }> => {
    try {
      const res = await fetch(
        `/api/rota/shifts?client=${encodeURIComponent(clientSlug)}&from=${range.from}&to=${range.to}`,
      );
      const data = (await res.json().catch(() => ({}))) as ShiftsResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load the rota (${res.status}).`);
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : "Could not load the rota." };
    }
  }, [clientSlug, range.from, range.to]);

  const apply = useCallback(
    (result: { data: ShiftsResponse | null; error: string | null }) => {
      if (result.data) {
        const loaded = result.data.shifts ?? [];
        setShifts(loaded);
        setStaff(result.data.staff ?? []);
        setConfig(result.data.config ?? null);
        setAbsences(result.data.absences ?? []);
        setLoadError(null);
        onShiftsLoaded(loaded);
      } else {
        // LOUD. Never fall back to an empty grid: a practice cannot tell an empty
        // week from a failed read, and one of those gets Tuesday staffed by nobody.
        setLoadError(result.error);
        setShifts([]);
        onShiftsLoaded([]);
      }
      setLoading(false);
    },
    [onShiftsLoaded],
  );

  /** For event handlers only — never called from an effect. */
  const load = useCallback(async () => {
    apply(await read());
  }, [read, apply]);

  useEffect(() => {
    let cancelled = false;
    read()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch(() => {
        if (!cancelled) apply({ data: null, error: "Could not load the rota." });
      });
    return () => {
      cancelled = true;
    };
  }, [read, apply]);

  // The pre-publish summary, for the week on screen. Only meaningful in week mode:
  // publishing is a promise about a week, because that is the unit staff are told in.
  const readPublishState = useCallback(async (): Promise<{
    state: PublishState | null;
    error: string | null;
    /** Month mode: there is nothing to ask and nothing to change. */
    skip: boolean;
  }> => {
    // Nothing to ask for in month mode, and nothing to set either: the summary was
    // already retired by the view-key reset above.
    if (mode !== "week") return { state: null, error: null, skip: true };
    try {
      const res = await fetch(
        `/api/rota/publish?client=${encodeURIComponent(clientSlug)}&weekStart=${anchor}`,
      );
      const data = (await res.json().catch(() => ({}))) as PublishResponse;
      if (!res.ok || !data.ok || !data.summary) {
        return {
          state: null,
          error: data.error || `Could not work out what publishing would send (${res.status}).`,
          skip: false,
        };
      }
      return {
        state: {
          summary: data.summary,
          canPublish: data.canPublish ?? false,
          dryRun: data.dryRun ?? false,
          lastPublishedAt: data.lastPublishedAt ?? null,
        },
        error: null,
        skip: false,
      };
    } catch (err) {
      return {
        state: null,
        error: err instanceof Error ? err.message : "Could not load the publish summary.",
        skip: false,
      };
    }
  }, [clientSlug, mode, anchor]);

  const applyPublishState = useCallback(
    (result: { state: PublishState | null; error: string | null; skip: boolean }) => {
      if (result.skip) return;
      setPublishState(result.state);
      setPublishError(result.error);
    },
    [],
  );

  /** For event handlers only — never called from an effect. */
  const loadPublishState = useCallback(async () => {
    applyPublishState(await readPublishState());
  }, [readPublishState, applyPublishState]);

  useEffect(() => {
    let cancelled = false;
    readPublishState()
      .then((result) => {
        if (!cancelled) applyPublishState(result);
      })
      .catch(() => {
        if (!cancelled) {
          applyPublishState({ state: null, error: "Could not load the publish summary.", skip: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readPublishState, applyPublishState]);

  const staffById = useMemo(() => {
    const map: Record<string, RotaStaff> = {};
    for (const s of staff) map[s.id] = s;
    return map;
  }, [staff]);

  const cells = useMemo<DayCell[]>(() => {
    const today = londonTodayKey();
    // SEVEN days, not six. The grid used to stop at Saturday because every site is
    // closed on Sunday and the generator therefore never produced a Sunday shift.
    // Manual editing changes that: publishing covers Monday to Sunday, so a Sunday
    // shift that existed and could not be seen would be a shift somebody was texted
    // about and nobody could find, which is the exact failure this module is meant
    // to remove.
    const days =
      mode === "week"
        ? Array.from({ length: 7 }, (_, i) => addDaysKey(anchor, i))
        : monthGridDays(anchor);
    return days.map((dayKey, index) => ({
      dayKey,
      short: WEEKDAY_SHORT[WEEK_ORDER[index % 7]],
      dayNum: dayOfMonth(dayKey),
      isToday: dayKey === today,
      inMonth: mode === "week" || sameMonth(dayKey, anchor),
      shifts: shifts.filter((s) => s.shiftDate === dayKey).sort(byTimeThenSiteThenRole),
    }));
  }, [mode, anchor, shifts]);

  // Every pairing problem across the window, computed day by day by the tested rule.
  const violationsByShift = useMemo(() => {
    const map = new Map<string, string>();
    if (!config) return map;
    const byDay = new Map<string, RotaShift[]>();
    for (const s of shifts) {
      const list = byDay.get(s.shiftDate) ?? [];
      list.push(s);
      byDay.set(s.shiftDate, list);
    }
    for (const dayShifts of byDay.values()) {
      for (const v of pairingViolations(dayShifts, config)) map.set(v.shiftId, v.message);
    }
    return map;
  }, [shifts, config]);

  function shiftsOnDay(dayKey: string): RotaShift[] {
    return shifts.filter((s) => s.shiftDate === dayKey);
  }

  function openNew(dayKey: string) {
    setDialogError(null);
    setDraft({
      siteId: siteIds[0] ?? "",
      staffId: "",
      shiftDate: dayKey,
      startTime: "09:00",
      endTime: "17:30",
      role: "dentist",
      pairedStaffId: null,
      note: null,
    });
  }

  function openEdit(shift: RotaShift) {
    setDialogError(null);
    setDraft({
      id: shift.id,
      siteId: shift.siteId,
      staffId: shift.staffId,
      shiftDate: shift.shiftDate,
      startTime: timeLabel(shift.startTime),
      endTime: timeLabel(shift.endTime),
      role: shift.role,
      pairedStaffId: shift.pairedStaffId ?? null,
      note: shift.note ?? null,
      removed: shift.status === "removed",
    });
  }

  async function afterWrite(message: string) {
    setNotice(message);
    setDraft(null);
    await load();
    await loadPublishState();
  }

  async function saveShift(value: ShiftEditInput) {
    setSaving(true);
    setDialogError(null);
    try {
      const editing = typeof value.id === "string";
      const res = await fetch(
        editing ? `/api/rota/shift/${encodeURIComponent(value.id!)}` : "/api/rota/shifts",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, ...value }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        reNotify?: boolean;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not save the shift (${res.status}).`);
      await afterWrite(
        editing
          ? data.reNotify
            ? "Shift moved. They will be told about the change."
            : "Shift updated."
          : "Shift added.",
      );
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Could not save the shift.");
    } finally {
      setSaving(false);
    }
  }

  async function removeShift(id: string) {
    setSaving(true);
    setDialogError(null);
    try {
      const res = await fetch(`/api/rota/shift/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not remove the shift (${res.status}).`);
      await afterWrite("Shift removed. The slot stays empty until you fill it.");
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Could not remove the shift.");
    } finally {
      setSaving(false);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch("/api/rota/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        inserted?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not fill the rota (${res.status}).`);
      const added = data.inserted ?? 0;
      setNotice(
        added === 0
          ? "Nothing to fill: every open slot already has somebody, or you have taken it off the rota."
          : `Filled ${added} open ${added === 1 ? "slot" : "slots"}. Anything you changed by hand was left alone.`,
      );
      await load();
      await loadPublishState();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not fill the rota.");
    } finally {
      setGenerating(false);
    }
  }

  async function publish() {
    if (publishing) return;
    setPublishing(true);
    setPublishResult(null);
    setPublishError(null);
    try {
      const res = await fetch("/api/rota/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, weekStart: anchor }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        notifiedStaff?: number;
        simulatedStaff?: number;
        notReached?: number;
        sendFailures?: number;
        dryRun?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not publish the rota (${res.status}).`);
      const parts: string[] = [`Published version ${data.version ?? "?"}.`];
      if (data.dryRun) {
        parts.push(
          `${data.simulatedStaff ?? 0} ${(data.simulatedStaff ?? 0) === 1 ? "person" : "people"} would have been told. Nothing was actually sent.`,
        );
      } else {
        parts.push(
          `${data.notifiedStaff ?? 0} ${(data.notifiedStaff ?? 0) === 1 ? "person" : "people"} told.`,
        );
      }
      if (data.notReached) {
        parts.push(
          `${data.notReached} could not be reached (no phone or email on file, or they have opted out).`,
        );
      }
      if (data.sendFailures) parts.push(`${data.sendFailures} message(s) failed and will be retried.`);
      setPublishResult(parts.join(" "));
      await load();
      await loadPublishState();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Could not publish the rota.");
    } finally {
      setPublishing(false);
    }
  }

  function step(direction: 1 | -1) {
    setNotice(null);
    setActionError(null);
    setAnchor((current) =>
      mode === "week" ? addDaysKey(current, direction * 7) : addMonths(current, direction),
    );
  }

  function switchMode(next: ViewMode) {
    setNotice(null);
    setActionError(null);
    setAnchor((current) => (next === "week" ? mondayOf(current) : `${current.slice(0, 7)}-01`));
    setMode(next);
  }

  const generateButton = (
    <Button variant="secondary" size="sm" onClick={generate} disabled={generating || loading}>
      {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
      Fill open slots
    </Button>
  );

  return (
    <SectionCard
      title="Rota"
      description="Built automatically from each site's opening hours and staff availability, then edited by you. Anything you change by hand is never overwritten. Publish a week to tell everyone their shifts."
      actions={generateButton}
    >
      <div className="space-y-3">
        {/* Week / month + paging */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label="Rota view"
              className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
            >
              {(["week", "month"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={mode === key}
                  onClick={() => switchMode(key)}
                  className={cn(
                    "pressable rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                    mode === key ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                  )}
                >
                  {key === "week" ? "Week" : "Month"}
                </button>
              ))}
            </div>
            <p className="text-sm font-semibold text-navy">
              {mode === "week" ? weekRangeLabel(anchor) : monthLabel(anchor)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={mode === "week" ? "Previous week" : "Previous month"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={mode === "week" ? "Next week" : "Next month"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {mode === "week" ? (
          <RotaPublishBar
            weekStart={anchor}
            state={publishState}
            busy={publishing}
            result={publishResult}
            error={publishError}
            onPublish={publish}
          />
        ) : null}

        {notice ? (
          <p className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            {notice}
          </p>
        ) : null}
        {actionError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        ) : null}

        {loadError ? (
          <p className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <span>
              {loadError} The rota below is not being shown, rather than being shown wrong. Reload to
              try again.
            </span>
          </p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading the rota...
          </div>
        ) : shifts.length === 0 && mode === "week" ? (
          <EmptyState
            icon={CalendarRange}
            title="Nothing on the rota this week"
            description="Fill the open slots from your sites' opening hours and staff availability, or add a shift by hand."
          >
            {generateButton}
          </EmptyState>
        ) : (
          <div
            className={cn(
              "grid gap-2",
              mode === "week"
                ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7"
                : "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7",
            )}
          >
            {cells.map((cell) => (
              <DayColumn
                key={cell.dayKey}
                cell={cell}
                mode={mode}
                clientSlug={clientSlug}
                staffById={staffById}
                absences={absences}
                violations={violationsByShift}
                onAdd={() => openNew(cell.dayKey)}
                onEdit={openEdit}
              />
            ))}
          </div>
        )}

        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {ROTA_ROLES.map((role) => (
            <span key={role} className="inline-flex items-center gap-1.5">
              <span className={cn("inline-block h-2 w-2 rounded-full", roleStyle(role).dot)} aria-hidden />
              {roleLabel(role)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full ring-2 ring-success" aria-hidden />
            Told about it
          </span>
        </p>
      </div>

      {draft ? (
        <RotaShiftDialog
          draft={draft}
          clientSlug={clientSlug}
          staff={staff}
          siteIds={siteIds}
          dayShifts={shiftsOnDay(draft.shiftDate)}
          absences={absences}
          busy={saving}
          error={dialogError}
          onSave={saveShift}
          onDelete={removeShift}
          onCancel={() => setDraft(null)}
        />
      ) : null}
    </SectionCard>
  );
}

function DayColumn({
  cell,
  mode,
  clientSlug,
  staffById,
  absences,
  violations,
  onAdd,
  onEdit,
}: {
  cell: DayCell;
  mode: ViewMode;
  clientSlug: string;
  staffById: Record<string, RotaStaff>;
  absences: Absence[];
  violations: Map<string, string>;
  onAdd: () => void;
  onEdit: (shift: RotaShift) => void;
}) {
  const live = cell.shifts.filter(isLiveShift);
  const removed = cell.shifts.filter((s) => s.status === "removed");

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card-muted/20",
        mode === "week" ? "min-h-[9rem]" : "min-h-[6.5rem]",
        cell.isToday ? "border-blue/60 ring-1 ring-blue/30" : "border-line",
        cell.inMonth ? "" : "opacity-55",
      )}
    >
      <div
        className={cn(
          "flex items-baseline justify-between gap-1 rounded-t-xl border-b px-2.5 py-1.5",
          cell.isToday ? "border-blue/30 bg-blue/5" : "border-line",
        )}
      >
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wide",
            cell.isToday ? "text-blue" : "text-muted",
          )}
        >
          {cell.short}
        </span>
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            cell.isToday ? "text-blue" : "text-navy",
          )}
        >
          {cell.dayNum}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-1.5">
        {live.length === 0 && removed.length === 0 ? (
          <span className="m-auto text-xs text-muted/70">Nobody on</span>
        ) : (
          live.map((shift) => {
            const person = staffById[shift.staffId];
            const style = roleStyle(shift.role);
            const told = shift.status === "notified";
            const partner = shift.pairedStaffId ? staffById[shift.pairedStaffId] : null;
            const clash = absenceBlocksShift(
              { staffId: shift.staffId, shiftDate: shift.shiftDate },
              absences,
            );
            const violation = shift.id ? violations.get(shift.id) : undefined;
            return (
              <button
                key={shift.id ?? `${shift.staffId}-${shift.startTime}`}
                type="button"
                onClick={() => onEdit(shift)}
                title={[
                  person?.name ?? "Unassigned",
                  roleLabel(shift.role),
                  siteName(clientSlug, shift.siteId),
                  partner ? `with ${partner.name}` : null,
                  told ? "Told about it" : "Not told yet",
                  shift.origin === "manual" ? "Set by hand" : null,
                  clash ? "On agreed time off" : null,
                  violation,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                className={cn(
                  "pressable rounded-lg border p-1.5 text-left transition-colors hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  style.card,
                  told ? "ring-1 ring-success/40" : "",
                )}
              >
                <p className="flex items-center gap-1 truncate text-[11.5px] font-semibold text-navy">
                  <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} aria-hidden />
                  <span className="truncate">{person?.name ?? "Unassigned"}</span>
                </p>
                {mode === "week" ? (
                  <>
                    <p className="mt-0.5 text-[11px] tabular-nums text-ink">
                      {timeLabel(shift.startTime)} to {timeLabel(shift.endTime)}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] text-muted">
                      {roleLabel(shift.role)}
                      <span aria-hidden> &middot; </span>
                      {siteName(clientSlug, shift.siteId)}
                    </p>
                    {partner ? (
                      <p className="mt-0.5 truncate text-[10.5px] text-muted">with {partner.name}</p>
                    ) : null}
                    {shift.note ? (
                      <p className="mt-0.5 truncate text-[10.5px] italic text-muted">{shift.note}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-0.5 truncate text-[10.5px] tabular-nums text-muted">
                    {timeLabel(shift.startTime)}
                  </p>
                )}
                {clash || violation ? (
                  <p className="mt-1 flex items-start gap-1 text-[10.5px] leading-snug text-amber-700">
                    <TriangleAlert size={11} className="mt-[1px] shrink-0" />
                    <span className="truncate">{clash ? "Agreed time off" : violation}</span>
                  </p>
                ) : null}
              </button>
            );
          })
        )}

        {removed.length > 0 && mode === "week" ? (
          <p className="text-[10.5px] leading-snug text-muted/80">
            {removed.length} removed. The rota will not refill {removed.length === 1 ? "it" : "them"}.
          </p>
        ) : null}

        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add a shift on ${cell.dayKey}`}
          className="mt-auto inline-flex items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong py-1 text-[11px] text-muted transition-colors hover:border-blue/50 hover:text-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue/30"
        >
          <Plus size={12} />
          Add
        </button>
      </div>
    </div>
  );
}
