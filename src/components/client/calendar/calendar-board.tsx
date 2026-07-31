"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { londonDayKey } from "@/lib/time/london";
import type { OpeningHours } from "@/lib/types";
import type { AppointmentRecord } from "@/lib/dentally/read";
import {
  clampDayToWindow,
  dnum,
  dow,
  isWithinWindow,
  longDate,
  mondayOf,
  safeDayKey,
  shiftDay,
  weekLabel,
} from "./calendar-logic";
import {
  dayBounds,
  effectiveMinutes,
  labelMinutes,
  londonMinutes,
  nowFraction,
} from "./diary-grid";
import {
  blockEdges,
  columnKey,
  dayCaption,
  dayCounts,
  initialFocus,
  nextFocus,
  openingWindowFor,
  orderColumns,
  parseOpeningWindow,
  resolveSolo,
  sortByStart,
  weekColumn,
  DIARY_ZOOM_COOKIE,
  type DiaryAppointment,
  type FocusKey,
  type FocusPos,
  type Zoom,
} from "./diary-view";
import { DiaryDay, type DayColumnInput } from "./diary-day";
import { DiaryWeek, type WeekDayInput } from "./diary-week";
import { AppointmentPanel } from "./appointment-panel";
import { blockDomId } from "./appointment-block";

// ---------------------------------------------------------------------------
// The diary board: the chrome round the grid, and the state that drives it.
//
// Time runs DOWN the page and one column runs ACROSS per clinician working that
// day. Columns are EQUAL: the receptionist filling a cancellation needs to read
// every clinician at once, there is no clinician role in the platform, and a
// mode one person sets is a mode the next person on a shared reception machine
// inherits. Solo is the one column control, it is visibly pressed, and it does
// not survive a fresh visit.
//
// Nothing here counts free time. White space is visible by construction (blocks
// are tinted, empty grid is white) and is never framed, shaded or labelled,
// because the only opening-hours source in the repo is our own config, which has
// never been verified against the practice and is already contradicted by live
// availability running past the configured close. The single exception is a gap
// bounded on both sides by a drawn block, which is a fact about the booked day
// rather than a claim about who is working.
//
// Only ZOOM persists. Day, view, site and solo are addressable in the URL and
// deliberately not remembered, so the diary always opens on today with every
// column showing, and a mode cannot be left set wrong on a shared machine.
//
// All date/time bucketing and formatting is delegated to ./calendar-logic and
// ./diary-grid and ./diary-view, all pure and unit-tested: times render in
// Europe/London (B1), "today" and every day-bucket use the London calendar day
// (B2), navigation is clamped to the window the server actually fetched (B4),
// and a failed read is told apart from a genuinely empty day end to end (B3).
// ---------------------------------------------------------------------------

type View = "day" | "week";

export interface SiteOption {
  id: string;
  name: string;
  openingHours?: OpeningHours;
}

export interface PractitionersForSite {
  practitioners: { id: string; name: string }[];
  failed: boolean;
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
        "pressable rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Segment({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[2px]"
    >
      {children}
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-tint-amber-line bg-tint-amber px-3 py-2"
    >
      <AlertTriangle size={14} className="mt-[1px] shrink-0 text-status-amber" aria-hidden />
      {/* The ink is text-ink, not text-status-amber, which is 3.55:1 on tint-amber
          and fails. The amber signal is carried by the fill, hairline and icon. */}
      <span className="text-[11.5px] leading-[1.45] text-ink">{children}</span>
    </div>
  );
}

// The wall clock as an external store, ticked every thirty seconds.
//
// It is NEVER read during render. staleTimes.dynamic is 30 in next.config.ts, so
// the server's nowIso can be half a minute old on a revisit, and a render-time
// Date.now() is a hydration mismatch on the most important screen in the
// product. The server snapshot is empty, so the now-line is simply absent until
// after hydration; once it is live, "today" is recomputed from it, which also
// fixes a tab left open past midnight still calling yesterday today.
const clockListeners = new Set<() => void>();
let clockIso = "";
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(onChange: () => void): () => void {
  clockListeners.add(onChange);
  if (clockTimer === null) {
    clockIso = new Date().toISOString();
    clockTimer = setInterval(() => {
      clockIso = new Date().toISOString();
      for (const listener of clockListeners) listener();
    }, 30_000);
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const readClock = () => clockIso;
const readServerClock = () => "";

/**
 * Whether the CLINICIAN list failed for the one site now on screen.
 *
 * Never the collapsed `.some()` across every scoped site: one failing practice
 * would otherwise blank out the counts, the column summaries and the gaps of a
 * healthy practice the reader is actually looking at, which is its own kind of
 * lie. The whole-request flag is only the fallback for a site with no entry at
 * all (the outer catch, where nothing loaded).
 */
function practitionersBySiteFailed(
  bySite: Record<string, PractitionersForSite>,
  siteId: string,
  whole: boolean,
): boolean {
  const entry = bySite[siteId];
  return entry ? entry.failed : whole;
}

/** The minute spans a day's appointments occupy, for dayBounds. */
function spansOf(appts: readonly DiaryAppointment[]): { startMin: number; endMin: number }[] {
  return appts
    .map((a) => {
      const startMin = londonMinutes(a.start);
      return { startMin, endMin: startMin + effectiveMinutes(a) };
    })
    .filter((s) => Number.isFinite(s.startMin));
}

export function CalendarBoard({
  appointments,
  sites,
  practitionersBySite,
  nowIso,
  initialSite,
  isAllSites,
  loadFailed = false,
  failedSiteIds = [],
  practitionersFailed = false,
  windowFrom,
  windowTo,
  clientSlug,
  initialZoom = "normal",
}: {
  appointments: AppointmentRecord[];
  sites: SiteOption[];
  practitionersBySite: Record<string, PractitionersForSite>;
  nowIso: string;
  initialSite: string;
  isAllSites: boolean;
  /** True when the Dentally appointment read for this window failed outright:
   *  an empty column is then NOT confirmation that a clinician is free. */
  loadFailed?: boolean;
  /** The sites whose own appointment read threw. The grid draws ONE practice at
   *  a time out of a multi-site read, so the whole-request `loadFailed` is not
   *  enough: with three sites loaded and one failing, `loadFailed` is false and
   *  switching to the failed practice would otherwise draw a confident empty day. */
  failedSiteIds?: string[];
  /** True when the clinician list could not be read: the column set is then only
   *  what the day's appointments imply, so a clinician with an empty day may be
   *  missing entirely. */
  practitionersFailed?: boolean;
  windowFrom: string;
  windowTo: string;
  clientSlug: string;
  initialZoom?: Zoom;
}) {
  // "Today" MUST be the London calendar day, never a UTC slice of nowIso.
  const serverToday = londonDayKey(new Date(nowIso));

  // Addressable state: ?day, ?view, ?site and ?clinician are read ONCE, here, so
  // a refresh, a back-navigation and a link pasted into a staff group all land
  // where they should with no post-mount correction. A URL-sourced day is
  // clamped to the loaded window before it ever reaches state.
  const searchParams = useSearchParams();
  const [day, setDay] = useState(() => {
    const d = searchParams.get("day");
    const wanted = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : serverToday;
    return clampDayToWindow(wanted, windowFrom, windowTo);
  });
  const [view, setView] = useState<View>(() => (searchParams.get("view") === "week" ? "week" : "day"));
  const [siteId, setSiteId] = useState(() => {
    const s = searchParams.get("site");
    return s && sites.some((x) => x.id === s) ? s : initialSite;
  });
  const [solo, setSolo] = useState<string | null>(() => searchParams.get("clinician") || null);
  const [dayZoom, setDayZoom] = useState<Zoom>(initialZoom);
  // Seven day columns of a whole day do not fit at Normal, so week view keeps
  // its own density. The cookie stores the DAY zoom, which is the one that matters.
  const [weekZoom, setWeekZoom] = useState<Zoom>("compact");
  const [selected, setSelected] = useState<DiaryAppointment | null>(null);
  const [focus, setFocus] = useState<FocusPos | null>(null);

  const liveClock = useSyncExternalStore(subscribeClock, readClock, readServerClock);
  const now = useMemo(() => (liveClock ? new Date(liveClock) : null), [liveClock]);

  const today = now ? londonDayKey(now) : serverToday;
  const zoom = view === "week" ? weekZoom : dayZoom;
  const setZoom = (z: Zoom) => (view === "week" ? setWeekZoom(z) : setDayZoom(z));

  const goTo = useCallback(
    (d: string) => setDay(clampDayToWindow(d, windowFrom, windowTo)),
    [windowFrom, windowTo],
  );

  useEffect(() => {
    document.cookie = `${DIARY_ZOOM_COOKIE}=${dayZoom}; path=/; max-age=31536000; samesite=lax`;
  }, [dayZoom]);

  // --- the day's data --------------------------------------------------------

  const site = useMemo(() => sites.find((s) => s.id === siteId) ?? sites[0] ?? null, [sites, siteId]);
  const siteName = site?.name ?? "this site";

  // Failure is read PER SITE. The server fetches every site in scope in one call
  // and this grid slices it down to one practice, so the read's whole-request
  // verdict stays false whenever any OTHER practice returned rows. Reading only
  // that verdict is how the site switcher lands on a practice whose read threw
  // and prints "Nothing booked" in every column.
  const readFailed = loadFailed || (site ? failedSiteIds.includes(site.id) : false);
  const columnsFailed = site
    ? practitionersBySiteFailed(practitionersBySite, site.id, practitionersFailed)
    : practitionersFailed;

  const siteAppointments = useMemo(
    () => sortByStart(appointments.filter((a) => (site ? a.siteId === site.id : false))),
    [appointments, site],
  );

  // Rows whose start cannot be parsed are bucketed OUT rather than fed to dayKey,
  // which throws a RangeError on an invalid date and would take the whole diary
  // down mid-render for one bad row anywhere in the sixty-day window. They are
  // then named on screen: a silently dropped appointment is a missed patient.
  const bucketed = useMemo(() => {
    const byDayMap = new Map<string, DiaryAppointment[]>();
    const undatedRows: DiaryAppointment[] = [];
    for (const a of siteAppointments) {
      const k = safeDayKey(a.start);
      if (k === null) {
        undatedRows.push(a);
        continue;
      }
      const list = byDayMap.get(k);
      if (list) list.push(a);
      else byDayMap.set(k, [a]);
    }
    return { byDay: byDayMap, undated: undatedRows };
  }, [siteAppointments]);

  const byDay = bucketed.byDay;
  const undated = bucketed.undated;

  const dayAppointments = useMemo(() => byDay.get(day) ?? [], [byDay, day]);

  const practitioners = useMemo(
    () => practitionersBySite[site?.id ?? ""]?.practitioners ?? [],
    [practitionersBySite, site],
  );

  const allColumns = useMemo(
    () => orderColumns(practitioners, dayAppointments),
    [practitioners, dayAppointments],
  );

  const dayColumns: DayColumnInput[] = useMemo(() => {
    const byKey = new Map<string, DiaryAppointment[]>();
    for (const a of dayAppointments) {
      const k = columnKey(a.practitionerId);
      const list = byKey.get(k);
      if (list) list.push(a);
      else byKey.set(k, [a]);
    }
    return allColumns.map((c) => ({
      key: columnKey(c.id),
      id: c.id,
      name: c.name,
      appointments: byKey.get(columnKey(c.id)) ?? [],
    }));
  }, [allColumns, dayAppointments]);

  // A soloed key that does not match any column on the day now in view is
  // IGNORED rather than filtering every column away, and the drop is SAID rather
  // than silently absorbed. resolveSolo carries the reasoning and its tests; the
  // raw key is KEPT in state here, so stepping back to a day where that
  // clinician works restores them.
  const { effective: effectiveSolo, dropped: soloDropped } = useMemo(
    () => resolveSolo(dayColumns, solo),
    [dayColumns, solo],
  );

  // The state is written back with replaceState and NEVER a router push, which
  // would re-run the server component and re-fetch the whole sixty-day window.
  // The server already holds every scoped site's appointments and clinicians, so
  // changing site is entirely client-side. It lives here, below the column set,
  // because it writes the clinician the grid actually drew.
  useEffect(() => {
    const sp = new URLSearchParams();
    sp.set("day", day);
    sp.set("view", view);
    if (isAllSites) sp.set("site", siteId);
    // effectiveSolo, not solo: the URL states what is actually DRAWN, so a link
    // pasted into a staff group can never open on a different set of columns.
    if (effectiveSolo) sp.set("clinician", effectiveSolo);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }, [day, view, siteId, effectiveSolo, isAllSites]);

  const visibleDayColumns = useMemo(
    () => (effectiveSolo ? dayColumns.filter((c) => c.key === effectiveSolo) : dayColumns),
    [dayColumns, effectiveSolo],
  );

  // The week's one clinician: whoever is soloed, else the first column. Week view
  // is single-clinician by construction, so this is NEVER left implicit: the
  // clinician is named in the caption, said in the note under the command bar,
  // and their rail chip is the pressed one.
  const { key: weekColumnKey, name: weekClinicianName } = useMemo(
    () => weekColumn(dayColumns, effectiveSolo),
    [dayColumns, effectiveSolo],
  );

  const weekDayKeys = useMemo(() => {
    const mon = mondayOf(day);
    return Array.from({ length: 7 }, (_, i) => shiftDay(mon, i));
  }, [day]);

  const weekAppointmentsByDay = useMemo(() => {
    const m = new Map<string, DiaryAppointment[]>();
    for (const k of weekDayKeys) {
      const all = byDay.get(k) ?? [];
      m.set(
        k,
        weekColumnKey === null ? [] : all.filter((a) => columnKey(a.practitionerId) === weekColumnKey),
      );
    }
    return m;
  }, [weekDayKeys, byDay, weekColumnKey]);

  // --- the drawn extent ------------------------------------------------------

  const bounds = useMemo(() => {
    if (view === "day") {
      const { openMin, closeMin } = openingWindowFor(site?.openingHours, day);
      // Bounds come from the WHOLE day at this site, not the soloed column, so
      // soloing never shifts the time axis under the reader. Anything booked
      // outside the window still extends the grid: a 07:15 emergency is never clipped.
      return dayBounds(spansOf(dayAppointments), openMin, closeMin);
    }
    let openMin = Number.POSITIVE_INFINITY;
    let closeMin = Number.NEGATIVE_INFINITY;
    for (const k of weekDayKeys) {
      const w = openingWindowFor(site?.openingHours, k);
      openMin = Math.min(openMin, w.openMin);
      closeMin = Math.max(closeMin, w.closeMin);
    }
    if (!Number.isFinite(openMin) || !Number.isFinite(closeMin)) {
      const fallback = parseOpeningWindow(null);
      openMin = fallback.openMin;
      closeMin = fallback.closeMin;
    }
    const all = weekDayKeys.flatMap((k) => weekAppointmentsByDay.get(k) ?? []);
    return dayBounds(spansOf(all), openMin, closeMin);
  }, [view, site, day, dayAppointments, weekDayKeys, weekAppointmentsByDay]);

  // --- the now-line ----------------------------------------------------------

  const nowMin = now ? londonMinutes(now.toISOString()) : Number.NaN;
  const dayNowTop = useMemo(() => {
    if (!now || view !== "day") return null;
    // nowFraction returns null off-day and off-grid, so on any day but today the
    // line simply does not render rather than being clamped to the top.
    if (nowFraction(now, day, bounds) === null) return null;
    return blockEdges(nowMin, nowMin, bounds.startMin, zoom).top;
  }, [now, view, day, bounds, nowMin, zoom]);
  const nowLabel = Number.isFinite(nowMin) ? labelMinutes(nowMin) : null;

  const weekDays: WeekDayInput[] = useMemo(
    () =>
      weekDayKeys.map((k) => {
        const inWindow = isWithinWindow(k, windowFrom, windowTo);
        const isToday = k === today;
        const nowTop =
          now && isToday && nowFraction(now, k, bounds) !== null
            ? blockEdges(nowMin, nowMin, bounds.startMin, zoom).top
            : null;
        return {
          dayKey: k,
          appointments: weekAppointmentsByDay.get(k) ?? [],
          inWindow,
          isToday,
          nowTop,
        };
      }),
    [weekDayKeys, weekAppointmentsByDay, windowFrom, windowTo, today, now, bounds, nowMin, zoom],
  );

  // --- counts ----------------------------------------------------------------

  // A gap-aware screen that computes from a failed read invents free time, which
  // is worse than the confident empty diary it replaces. So every derived figure
  // is suppressed while either read is untrustworthy.
  const countsUnavailable = readFailed || columnsFailed;

  const caption = useMemo(() => {
    if (readFailed) return `${siteName} · Counts unavailable`;
    if (view === "day") return dayCaption(siteName, dayCounts(dayAppointments));
    // Week view draws ONE clinician, so its caption counts exactly what is drawn
    // and names whose week it is. Counting the whole practice here put a figure
    // like "212 booked" directly above a grid showing about sixteen blocks. The
    // whole-practice-per-day figures stay on the seven-day strip, which is on
    // screen in both views.
    const drawn = weekDayKeys.flatMap((k) => weekAppointmentsByDay.get(k) ?? []);
    return dayCaption(
      `${siteName} · ${weekClinicianName ?? "No clinician"}`,
      dayCounts(drawn),
    );
  }, [readFailed, siteName, view, dayAppointments, weekDayKeys, weekAppointmentsByDay, weekClinicianName]);

  const strip = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 3)), [day]);
  const stripCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (readFailed) return m;
    for (const d of strip) m.set(d, dayCounts(byDay.get(d) ?? []).booked);
    return m;
  }, [strip, byDay, readFailed]);

  // The figure beside each rail chip counts the SAME span the grid is drawing:
  // that clinician's day in day view, that clinician's week in week view. A day
  // count sitting beside a week grid is a number that quietly means something
  // other than what the reader is looking at.
  const railCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (countsUnavailable) return m;
    if (view === "week") {
      const weekRows = weekDayKeys.flatMap((k) => byDay.get(k) ?? []);
      for (const c of dayColumns) {
        const mine = weekRows.filter((a) => columnKey(a.practitionerId) === c.key);
        m.set(c.key, dayCounts(mine).booked);
      }
      return m;
    }
    for (const c of dayColumns) m.set(c.key, dayCounts(c.appointments).booked);
    return m;
  }, [dayColumns, countsUnavailable, view, weekDayKeys, byDay]);

  // --- keyboard --------------------------------------------------------------

  const focusColumns = useMemo(
    () =>
      view === "day"
        ? visibleDayColumns.map((c) =>
            c.appointments.map((a) => ({ id: a.id, startMin: londonMinutes(a.start) })),
          )
        : weekDays.map((d) =>
            d.inWindow ? d.appointments.map((a) => ({ id: a.id, startMin: londonMinutes(a.start) })) : [],
          ),
    [view, visibleDayColumns, weekDays],
  );

  // On today the tab stop starts at the first appointment at or after now in the
  // leftmost column that has one; otherwise at the first appointment of the day.
  const focusFrom = day === today && Number.isFinite(nowMin) ? nowMin : Number.NEGATIVE_INFINITY;
  const defaultFocus = useMemo(() => initialFocus(focusColumns, focusFrom), [focusColumns, focusFrom]);

  const activeFocus = useMemo<FocusPos | null>(() => {
    if (focus && focusColumns[focus.colIndex]?.some((i) => i.id === focus.id)) return focus;
    return defaultFocus;
  }, [focus, focusColumns, defaultFocus]);

  const moveFocus = (pos: FocusPos | null) => {
    if (!pos) return;
    setFocus(pos);
    document.getElementById(blockDomId(pos.id))?.focus();
  };

  const step = view === "week" ? 7 : 1;

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    ) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
      if (!activeFocus) return;
      event.preventDefault();
      moveFocus(nextFocus(focusColumns, activeFocus.colIndex, activeFocus.startMin, key as FocusKey));
      return;
    }

    const lower = key.toLowerCase();
    if (lower === "t") {
      event.preventDefault();
      goTo(today);
    } else if (key === "[") {
      event.preventDefault();
      goTo(shiftDay(day, -step));
    } else if (key === "]") {
      event.preventDefault();
      goTo(shiftDay(day, step));
    } else if (lower === "d") {
      event.preventDefault();
      setView("day");
    } else if (lower === "w") {
      event.preventDefault();
      setView("week");
    } else if (lower === "s" && view === "day" && activeFocus) {
      event.preventDefault();
      const col = visibleDayColumns[activeFocus.colIndex];
      if (col) setSolo((current) => (current === col.key ? null : col.key));
    }
  };

  // --- the panel -------------------------------------------------------------

  const lastOpened = useRef<string | null>(null);
  const openAppointment = useCallback((appt: DiaryAppointment) => {
    lastOpened.current = appt.id;
    setSelected(appt);
  }, []);
  const closePanel = useCallback(() => {
    setSelected(null);
    const id = lastOpened.current;
    if (id) requestAnimationFrame(() => document.getElementById(blockDomId(id))?.focus());
  }, []);

  const selectedClinician = selected
    ? dayColumns.find((c) => c.key === columnKey(selected.practitionerId))?.name ?? null
    : null;

  // --- chrome ----------------------------------------------------------------

  const instructionsId = useId();
  const bleed = "-mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8";
  const canGoPrev = day > windowFrom;
  const canGoNext = day < windowTo;
  const onSolo = useCallback((key: string) => setSolo((current) => (current === key ? null : key)), []);
  // In week view the rail PICKS the clinician rather than toggling one on and
  // off, because the week always draws exactly one and there is no "all" week.
  const onRailPick = useCallback(
    (key: string) => {
      if (view === "week") setSolo(key);
      else setSolo((current) => (current === key ? null : key));
    },
    [view],
  );
  const onPickDay = useCallback(
    (d: string) => {
      goTo(d);
      setView("day");
    },
    [goTo],
  );

  const emptyDay = view === "day" && !readFailed && dayAppointments.length === 0;

  // One line of standing context under the command bar, so nothing about WHAT is
  // drawn is left to be inferred from a pressed chip.
  const notes: string[] = [];
  if (isAllSites && sites.length > 1) notes.push("The diary shows one practice at a time.");
  if (view === "week") {
    notes.push(
      `Week view shows one clinician: ${weekClinicianName ?? "none available"}. Pick another below. The seven-day strip counts the whole practice.`,
    );
  }
  if (view === "day" && soloDropped) {
    notes.push("The clinician you picked is not in this day's diary, so every clinician is shown.");
  }

  return (
    <div data-diary className="flex min-h-0 flex-col gap-2 lg:h-full">
      {/* Command bar. The date IS the page title: a 24px display heading plus a
          PageHeader would cost a quarter of a laptop's grid. */}
      <div className={cn("flex h-9 items-center gap-2 border-b border-line", bleed)}>
        <div role="group" aria-label="Change day" className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={view === "week" ? "Previous week" : "Previous day"}
            disabled={!canGoPrev}
            onClick={() => goTo(shiftDay(day, -step))}
            className="pressable flex h-6 w-6 items-center justify-center rounded-md border border-line-strong bg-card text-muted transition-colors hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => goTo(today)}
            className="pressable h-6 rounded-md border border-line-strong bg-card px-2 text-[11px] font-medium text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            Today
          </button>
          <button
            type="button"
            aria-label={view === "week" ? "Next week" : "Next day"}
            disabled={!canGoNext}
            onClick={() => goTo(shiftDay(day, step))}
            className="pressable flex h-6 w-6 items-center justify-center rounded-md border border-line-strong bg-card text-muted transition-colors hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <h1 className="min-w-0 shrink-0 truncate text-[15px] font-semibold tracking-[-0.3px] tabular-nums text-navy">
          {view === "day" ? longDate(day) : weekLabel(day)}
        </h1>

        <p className="hidden min-w-0 truncate text-[11px] font-medium tabular-nums text-muted sm:block">
          {caption}
        </p>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isAllSites && sites.length > 1 ? (
            <Segment label="Site">
              {sites.map((s) => (
                <SegmentBtn key={s.id} active={s.id === siteId} onClick={() => setSiteId(s.id)}>
                  {s.name}
                </SegmentBtn>
              ))}
            </Segment>
          ) : null}
          <div className="hidden lg:block">
            <Segment label="Day or week view">
              {(["day", "week"] as View[]).map((v) => (
                <SegmentBtn key={v} active={view === v} onClick={() => setView(v)} className="capitalize">
                  {v}
                </SegmentBtn>
              ))}
            </Segment>
          </div>
          <div className="hidden lg:block">
            <Segment label="Row height">
              {(["compact", "normal", "roomy"] as Zoom[]).map((z) => (
                <SegmentBtn key={z} active={zoom === z} onClick={() => setZoom(z)} className="capitalize">
                  {z}
                </SegmentBtn>
              ))}
            </Segment>
          </div>
        </div>
      </div>

      {notes.length > 0 ? (
        <p className={cn("shrink-0 text-[10px] font-medium text-muted", bleed)}>{notes.join(" ")}</p>
      ) : null}

      {/* The seven-day strip: the practice manager's week shape, in BOTH views.
          Days outside the loaded window are shown but disabled, never hidden: an
          unfetched day renders as zero appointments, which is indistinguishable
          from a free day on a fully booked diary. */}
      <div className={cn("grid h-[34px] shrink-0 grid-cols-7 gap-1", bleed)}>
        {strip.map((d) => {
          const isSel = d === day;
          const isToday = d === today;
          const inWindow = isWithinWindow(d, windowFrom, windowTo);
          const count = stripCounts.get(d) ?? 0;
          return (
            <button
              key={d}
              type="button"
              disabled={!inWindow}
              onClick={() => goTo(d)}
              aria-current={isSel ? "date" : undefined}
              title={inWindow ? undefined : "Not loaded"}
              className={cn(
                "pressable flex flex-col items-center rounded-md px-1 py-[3px] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                isSel ? "bg-navy" : "hover:bg-card-muted/50",
                !inWindow && "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              <span
                className={cn(
                  "text-[9px] font-medium uppercase tracking-[0.07em]",
                  isSel ? "text-white/70" : "text-muted",
                )}
              >
                {dow(d)}
              </span>
              <span
                className={cn(
                  "text-[12.5px] font-bold tabular-nums",
                  isSel ? "text-white" : isToday ? "text-blue-royal" : "text-navy",
                )}
              >
                {dnum(d)}
              </span>
              <span className={cn("text-[9px] tabular-nums", isSel ? "text-white/70" : "text-muted")}>
                {inWindow && count > 0 ? count : ""}
              </span>
            </button>
          );
        })}
      </div>

      {/* The clinician rail: who is on today, the only column control, and the
          column picker below lg. A single-select, never a checklist: hiding a
          column that has appointments is a clinician's whole day disappearing
          behind a count on a button. */}
      <div
        role="group"
        aria-label="Clinician"
        className={cn("flex h-[30px] shrink-0 items-center gap-1 overflow-x-auto", bleed)}
      >
        {/* "All" is a DAY-view control only. Week view draws exactly one
            clinician, so an "All" button pressed there would assert the opposite
            of what is on the grid. */}
        {view === "day" ? (
          <button
            type="button"
            aria-pressed={effectiveSolo === null}
            onClick={() => setSolo(null)}
            className={cn(
              "pressable shrink-0 rounded-md px-2 py-[2px] text-[11px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
              effectiveSolo === null
                ? "bg-navy text-white"
                : "text-muted hover:bg-card-muted/50 hover:text-navy",
            )}
          >
            All
          </button>
        ) : null}
        {dayColumns.map((c) => {
          const active = view === "week" ? c.key === weekColumnKey : effectiveSolo === c.key;
          const count = railCounts.get(c.key);
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={active}
              onClick={() => onRailPick(c.key)}
              title={c.name}
              className={cn(
                "pressable shrink-0 rounded-md px-2 py-[2px] text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                active ? "bg-navy text-white" : "text-muted hover:bg-card-muted/50 hover:text-navy",
              )}
            >
              {c.name}
              {typeof count === "number" && count > 0 ? (
                <span className="ml-1 text-[10px] tabular-nums opacity-70">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {readFailed ? (
        <Alert>
          We could not load the diary for {siteName}. Dentally did not respond, so an empty column
          below is NOT confirmation that it is free. Try refreshing shortly.
        </Alert>
      ) : null}
      {columnsFailed ? (
        <Alert>
          We could not load the clinician list for {siteName}. The columns below are drawn only from
          the appointments that loaded, so a clinician with an empty day may be missing.
        </Alert>
      ) : null}
      {undated.length > 0 ? (
        <Alert>
          {undated.length === 1
            ? "One appointment has no readable start time, so it is not drawn on the grid"
            : `${undated.length} appointments have no readable start time, so they are not drawn on the grid`}
          : {undated.slice(0, 5).map((a) => a.patientName).join(", ")}
          {undated.length > 5 ? ` and ${undated.length - 5} more` : ""}. Check them in Dentally.
        </Alert>
      ) : null}

      {emptyDay ? (
        <p className="shrink-0 text-[11px] font-medium text-muted">
          Nothing booked at {siteName} on {longDate(day)}.
        </p>
      ) : null}

      <p id={instructionsId} className="sr-only">
        Use the arrow keys to move between appointments, Home and End for the first and last in a
        column, Enter to open an appointment, and Escape to close it. Press t for today, square
        brackets to change day, d for day view, w for week view, and s to show only the focused
        clinician.
      </p>
      <p role="status" className="sr-only">
        {view === "day" ? longDate(day) : weekLabel(day)}. {caption}.
      </p>

      {view === "day" ? (
        <DiaryDay
          columns={visibleDayColumns}
          bounds={bounds}
          zoom={zoom}
          ariaLabel={`Diary, ${longDate(day)}, ${siteName}`}
          soloKey={effectiveSolo}
          onSolo={onSolo}
          countsUnavailable={countsUnavailable}
          nowTop={dayNowTop}
          nowLabel={nowLabel}
          focusedId={activeFocus?.id ?? null}
          onFocusItem={(colIndex, appt) =>
            setFocus({ colIndex, id: appt.id, startMin: londonMinutes(appt.start) })
          }
          onOpen={openAppointment}
          onKeyDown={onGridKeyDown}
          describedById={instructionsId}
        />
      ) : (
        <DiaryWeek
          days={weekDays}
          clinicianName={weekClinicianName}
          bounds={bounds}
          zoom={zoom}
          ariaLabel={`Diary, ${weekLabel(day)}, ${weekClinicianName ?? "no clinician selected"}, ${siteName}`}
          countsUnavailable={countsUnavailable}
          onPickDay={onPickDay}
          focusedId={activeFocus?.id ?? null}
          onFocusItem={(colIndex, appt) =>
            setFocus({ colIndex, id: appt.id, startMin: londonMinutes(appt.start) })
          }
          onOpen={openAppointment}
          onKeyDown={onGridKeyDown}
          describedById={instructionsId}
          selectedDay={day}
        />
      )}

      {selected ? (
        <AppointmentPanel
          appointment={selected}
          clinicianName={selectedClinician}
          siteName={siteName}
          clientSlug={clientSlug}
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}
