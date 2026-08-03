"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { londonDayKey } from "@/lib/time/london";
import type { OpeningHours } from "@/lib/types";
import type { AppointmentRecord } from "@/lib/dentally/read";
import { windowsFor } from "@/lib/calendar/availability";
import type { FundingCode } from "@/lib/calendar/funding";
import { entriesForColumn, occupyingEntries, type DiaryEntryRecord } from "@/lib/calendar/entries";
import { columnWorkState, workingSpans } from "@/lib/calendar/working-spans";
import type { Proposal } from "@/lib/calendar/propose";
import {
  clampDayToWindow,
  dnum,
  dow,
  isWithinWindow,
  longDate,
  safeDayKey,
  shiftDay,
  spanLabel,
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
  multidaySpanKeys,
  nextFocus,
  openingWindowFor,
  orderColumns,
  parseOpeningWindow,
  parseSpan,
  resolveSolo,
  sortByStart,
  weekColumn,
  DIARY_ZOOM_COOKIE,
  MULTIDAY_SPANS,
  UNASSIGNED_KEY,
  type DiaryAppointment,
  type FocusKey,
  type FocusPos,
  type MultidaySpan,
  type Zoom,
} from "./diary-view";
import { DiaryDay, type DayColumnInput } from "./diary-day";
import { DiaryKey } from "./diary-key";
import { DiaryDays, weekDayKeys as weekKeysOf, type DayColumnDayInput } from "./diary-week";
import { AppointmentPanel } from "./appointment-panel";
import { blockDomId } from "./appointment-block";
import { EntryDialog, type EntryDraft } from "./entry-dialog";
import { useDiaryDay, type DiaryDaySeed } from "./use-diary-day";
import { useDiaryMove, type MoveColumn, type PendingMove } from "./use-diary-move";
import { MoveConfirmDialog } from "./move-confirm-dialog";
import {
  MOVE_BLOCKED_BY_ENTRIES,
  MOVE_BLOCKED_BY_APPOINTMENTS,
  MOVE_BLOCKED_BY_PENDING,
  MOVE_BLOCKED_BY_READ,
  type NotifyBlocker,
} from "./move-copy";
import type { GridDrag } from "./diary-day";

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
// WORKING TIME NOW COMES FROM DENTALLY'S OWN AVAILABILITY, not from our config.
// The config was never verified against the practice and is already contradicted
// by live windows running past its close, so it survives only as the drawn
// EXTENT of the grid and makes no claim about who is in. The grid starts GREY and
// white sessions are painted onto it, so a clinician can only ever read as
// available because Dentally positively said so. Three textures, three claims:
// white we asked and they are working, grey we asked and they are not, hatch we
// did not get an answer.
//
// FIVE failure signals, none conflated, each per SITE: appointments,
// practitioners, availability, funding, breaks and notes. Every derived figure
// from a failed read prints "Not loaded", never a zero and never a blank.
//
// Only ZOOM persists. Day, view, span, site and solo are addressable in the URL
// and deliberately not remembered, so the diary always opens on today with every
// column showing, and a mode cannot be left set wrong on a shared machine.
//
// All date/time bucketing and formatting is delegated to ./calendar-logic and
// ./diary-grid and ./diary-view, all pure and unit-tested: times render in
// Europe/London (B1), "today" and every day-bucket use the London calendar day
// (B2), navigation is clamped to the window the server actually fetched (B4),
// and a failed read is told apart from a genuinely empty day end to end (B3).
// ---------------------------------------------------------------------------

type View = "day" | "week" | "multiday";

/** The view's columns are DAYS rather than clinicians. Week is multiday with a
 *  span of seven anchored to Monday, so the two share one component. */
function isDayPerColumn(view: View): boolean {
  return view === "week" || view === "multiday";
}

export interface SiteOption {
  id: string;
  name: string;
  openingHours?: OpeningHours;
  /** null until the owner supplies real numbers. A patient text that cannot name
   *  a number to ring back is not sent at all, and the dialog says so. */
  publicPhone?: string | null;
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

// Stable identities, so a failed funding or entries read does not mint a new
// object on every render and re-run every column memo underneath it.
const EMPTY_FUNDING: Record<string, FundingCode> = {};
const EMPTY_ENTRIES: DiaryEntryRecord[] = [];

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
  diarySeed = null,
  windowFrom,
  windowTo,
  clientSlug,
  initialZoom = "normal",
  canMove = false,
  writeEnabled = false,
  messagingDryRun = false,
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
  /** The initially selected day's availability, funding and breaks, resolved on
   *  the server so the first paint is already correct with no client round trip. */
  diarySeed?: DiaryDaySeed | null;
  windowFrom: string;
  windowTo: string;
  clientSlug: string;
  initialZoom?: Zoom;
  /** True when this reader's ROLE may move an appointment. Read from the SAME
   *  list the server enforces (PATIENT_ADMIN_ROLES), so the two cannot drift.
   *  Hiding the affordance is courtesy; the server gate is the enforcement. */
  canMove?: boolean;
  /** isDentallyWriteEnabled(). False locally, and the panel says so plainly
   *  rather than letting a clinician discover it by trying. */
  writeEnabled?: boolean;
  /** MESSAGING_DRY_RUN: a queued text is simulated, never delivered. */
  messagingDryRun?: boolean;
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
  const [view, setView] = useState<View>(() => {
    const v = searchParams.get("view");
    return v === "week" || v === "multiday" ? v : "day";
  });
  // Span lives in the URL and never in a cookie: only zoom persists, and a span
  // one person set is a span the next person on a shared reception machine
  // inherits.
  const [span, setSpan] = useState<MultidaySpan>(() => parseSpan(searchParams.get("span")));
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
  const [entryDraft, setEntryDraft] = useState<{ draft: EntryDraft; day: string } | null>(null);
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  // Bumped after a saved break or note, to refetch the days on screen.
  const [entryNonce, setEntryNonce] = useState(0);

  // THE OPTIMISTIC OVERLAY, owned here rather than inside useDiaryMove, because
  // it has to be merged over the server prop BEFORE the columns that the move
  // hook is then given are derived. `appointments` is a server prop and every
  // derived value is a useMemo over it, so there is no appointment state to
  // mutate: the overlay is the only way a move can show before it has landed.
  const [pendingMoves, setPendingMoves] = useState<Map<string, PendingMove>>(() => new Map());

  const liveClock = useSyncExternalStore(subscribeClock, readClock, readServerClock);
  const now = useMemo(() => (liveClock ? new Date(liveClock) : null), [liveClock]);

  const today = now ? londonDayKey(now) : serverToday;
  const dayPerColumn = isDayPerColumn(view);
  const zoom = dayPerColumn ? weekZoom : dayZoom;
  const setZoom = (z: Zoom) => (dayPerColumn ? setWeekZoom(z) : setDayZoom(z));

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

  const baseById = useMemo(() => {
    const m = new Map<string, AppointmentRecord>();
    for (const a of appointments) m.set(a.id, a);
    return m;
  }, [appointments]);

  // The overlay entries that are still doing work. An entry whose values the
  // SERVER PROP now carries is dropped rather than re-applied, so a refresh can
  // never double-apply a move and the overlay never outlives the truth it stood
  // in for. Derived rather than pruned in an effect: an effect that sets state
  // from a prop is a cascading render, and this is a plain function of the two.
  const activePending = useMemo(() => {
    if (pendingMoves.size === 0) return pendingMoves;
    const next = new Map<string, PendingMove>();
    for (const [id, p] of pendingMoves) {
      const row = baseById.get(id);
      const settled =
        p.status === "saved" &&
        row !== undefined &&
        Date.parse(row.start) === Date.parse(p.startTime) &&
        (row.practitionerId ?? null) === p.practitionerId;
      if (!settled) next.set(id, p);
    }
    return next.size === pendingMoves.size ? pendingMoves : next;
  }, [pendingMoves, baseById]);

  const siteAppointments = useMemo(() => {
    const base = appointments.filter((a) => (site ? a.siteId === site.id : false));
    if (activePending.size === 0) return sortByStart(base);
    return sortByStart(
      base.map((a) => {
        const p = activePending.get(a.id);
        // "unknown" alone falls back to the server prop. We could not find out
        // whether the write landed, so the diary asserts nothing and lets the next
        // refresh answer; the sticky alert carries the words meanwhile.
        //
        // "failed" and "held" DO draw from the overlay, because the overlay was
        // written with the move's own `from` end, which is the last position we
        // have positive evidence for. The server prop is not that: inside the
        // refresh window after a confirmed move it still holds the pre-move time,
        // so falling back to it drew the appointment somewhere it is not while the
        // alert named the right place. People act on the grid.
        if (!p || p.status === "unknown") return a;
        return {
          ...a,
          start: p.startTime,
          finish: p.finishTime,
          durationMin: p.durationMin,
          practitionerId: p.practitionerId,
          practitioner: p.practitionerName || a.practitioner,
        };
      }),
    );
  }, [appointments, site, activePending]);

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

  // ONE date label for the heading and the live region, so what is announced and
  // what is printed can never disagree. Multiday is anchor-FORWARD, so weekLabel
  // (Monday to Sunday of the containing week) is the wrong range for it.
  const rangeLabel =
    view === "day" ? longDate(day) : view === "week" ? weekLabel(day) : spanLabel(day, span);

  // The days this view actually draws. Week is Monday-anchored; multiday runs
  // FORWARD from the selected day, which is what the reference's own URL does and
  // what a practice manager checking a clinician's next five days expects.
  const viewDayKeys = useMemo(() => {
    if (view === "day") return [day];
    if (view === "week") return weekKeysOf(day);
    return multidaySpanKeys(day, span);
  }, [view, day, span]);

  // --- availability, funding and breaks --------------------------------------
  //
  // Scoped to the days ON SCREEN, never to the loaded sixty-day window. The first
  // day is seeded from the server, so the first paint costs no round trip.
  const diaryDay = useDiaryDay(site?.id ?? "", viewDayKeys, diarySeed, entryNonce);

  // PRACTITIONERS FAILED IMPLIES AVAILABILITY FAILED: the practitioner id set is
  // the only thing scoping an availability read to a site, so a partial or wrong
  // set could return another practice's windows with nothing in the response to
  // catch it. The server sets the flag at source; this is the client-side guard
  // for the case where the column read failed and no request was worth making.
  const availabilityFailed = diaryDay.availabilityFailed || columnsFailed;
  const fundingFailed = diaryDay.fundingFailed;
  const entriesFailed = diaryDay.entriesFailed;

  // PENDING IS NOT FAILED. While the read is in flight the columns keep the hatch,
  // because painting grey or white before Dentally has answered would be a claim
  // we cannot support. But the ALERTS stay silent: "Working hours could not be
  // read" flashing on every day change is a false alarm, and PRODUCT.md is
  // explicit that a warning colour on something that is not a warning trains
  // people to ignore the ones that are.
  const diaryPending = diaryDay.loading;

  // No rail is drawn ANYWHERE when the funding read failed, which looks identical
  // to "not on file", which is exactly why the board says so in words as well.
  const funding = fundingFailed ? EMPTY_FUNDING : diaryDay.funding;
  const entries = entriesFailed ? EMPTY_ENTRIES : diaryDay.entries;

  const practitioners = useMemo(
    () => practitionersBySite[site?.id ?? ""]?.practitioners ?? [],
    [practitionersBySite, site],
  );

  const allColumns = useMemo(
    () => orderColumns(practitioners, dayAppointments),
    [practitioners, dayAppointments],
  );

  // The clinician columns WITHOUT their working time, which the solo resolution,
  // the rail counts and the keyboard path all key off. columnWork adds the rest.
  const dayColumns = useMemo(() => {
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

  // Everything about WORKING TIME for one column on one day, in one place, so day
  // view and the day-per-column views cannot answer it differently.
  //
  // workingSpans = availability windows UNION that clinician's own booked spans.
  // Bookings count as working time because a booking is proof of a session even
  // when availability says nothing, and because whether Dentally's windows already
  // exclude booked time is UNPROVEN: the union is correct under both readings.
  // The clinician-days whose availability could belong to ANOTHER of this
  // client's practices. Their windows are already stripped server side; this set
  // is what lets the column say so rather than reading as "Not working".
  const unconfirmedKeys = useMemo(
    () => new Set(diaryDay.unconfirmed.map((u) => `${u.practitionerId}|${u.dayKey}`)),
    [diaryDay.unconfirmed],
  );

  const columnWork = useCallback(
    (practitionerId: string | null, dayKey: string, appts: readonly DiaryAppointment[]) => {
      const windows = windowsFor(diaryDay.windows, practitionerId, dayKey);
      // OCCUPYING spans only. A cancelled or did-not-attend row does not prove
      // anybody was in the building, and including it here was the one way white
      // could appear with nothing positive behind it: one cancelled Saturday
      // booking painted an hour the clinician was not there for, and the drop
      // validator then accepted a patient into it.
      const apptSpans = spansOf(appts.filter((a) => a.state !== "cancelled" && a.state !== "did_not_attend"));
      const presenceConfirmed =
        practitionerId === null || !unconfirmedKeys.has(`${practitionerId}|${dayKey}`);
      return {
        workState: columnWorkState({
          availabilityFailed,
          // A failed APPOINTMENT read hatches the column too: the union includes
          // appointments, so a missing set would shrink the white area and make
          // booked time read as off.
          appointmentsFailed: readFailed,
          windows,
          apptSpans,
          presenceConfirmed,
        }),
        workingSpans: presenceConfirmed ? workingSpans(windows, apptSpans) : [],
        entries: entriesForColumn(entries, practitionerId, dayKey),
      };
    },
    [diaryDay.windows, availabilityFailed, readFailed, entries, unconfirmedKeys],
  );

  const dayGridColumns: DayColumnInput[] = useMemo(
    () => dayColumns.map((c) => ({ ...c, ...columnWork(c.id, day, c.appointments) })),
    [dayColumns, columnWork, day],
  );

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
    // Span is meaningful only in multiday; writing it in every view would put a
    // parameter in the URL that the grid is not honouring.
    if (view === "multiday") sp.set("span", String(span));
    if (isAllSites) sp.set("site", siteId);
    // effectiveSolo, not solo: the URL states what is actually DRAWN, so a link
    // pasted into a staff group can never open on a different set of columns.
    if (effectiveSolo) sp.set("clinician", effectiveSolo);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }, [day, view, span, siteId, effectiveSolo, isAllSites]);

  const visibleDayColumns = useMemo(
    () => (effectiveSolo ? dayColumns.filter((c) => c.key === effectiveSolo) : dayColumns),
    [dayColumns, effectiveSolo],
  );

  /** The same set, carrying each column's working time and its breaks and notes. */
  const visibleGridColumns = useMemo(
    () =>
      effectiveSolo ? dayGridColumns.filter((c) => c.key === effectiveSolo) : dayGridColumns,
    [dayGridColumns, effectiveSolo],
  );

  // The week's one clinician: whoever is soloed, else the first column. Week view
  // is single-clinician by construction, so this is NEVER left implicit: the
  // clinician is named in the caption, said in the note under the command bar,
  // and their rail chip is the pressed one.
  const { key: weekColumnKey, name: weekClinicianName } = useMemo(
    () => weekColumn(dayColumns, effectiveSolo),
    [dayColumns, effectiveSolo],
  );

  const spanAppointmentsByDay = useMemo(() => {
    const m = new Map<string, DiaryAppointment[]>();
    for (const k of viewDayKeys) {
      const all = byDay.get(k) ?? [];
      m.set(
        k,
        weekColumnKey === null ? [] : all.filter((a) => columnKey(a.practitionerId) === weekColumnKey),
      );
    }
    return m;
  }, [viewDayKeys, byDay, weekColumnKey]);

  // The clinician whose days the day-per-column views draw, as a PRACTITIONER ID
  // rather than a column key. Unassigned is not a person and has no availability,
  // so it resolves to null and its column reads as off unless something is booked
  // in it, which is the honest answer.
  const spanPractitionerId = weekColumnKey === UNASSIGNED_KEY ? null : weekColumnKey;

  // --- the drawn extent ------------------------------------------------------

  const bounds = useMemo(() => {
    if (view === "day") {
      const { openMin, closeMin } = openingWindowFor(site?.openingHours, day);
      // Bounds come from the WHOLE day at this site, not the soloed column, so
      // soloing never shifts the time axis under the reader. Anything booked
      // outside the window still extends the grid: a 07:15 emergency is never clipped.
      return dayBounds(spansOf(dayAppointments), openMin, closeMin);
    }
    // Our own opening hours survive ONLY as the drawn extent. They widen the grid
    // across the span and make no claim at all about who is working: that is now
    // Dentally's availability, painted as white sessions on the grey.
    let openMin = Number.POSITIVE_INFINITY;
    let closeMin = Number.NEGATIVE_INFINITY;
    for (const k of viewDayKeys) {
      const w = openingWindowFor(site?.openingHours, k);
      openMin = Math.min(openMin, w.openMin);
      closeMin = Math.max(closeMin, w.closeMin);
    }
    if (!Number.isFinite(openMin) || !Number.isFinite(closeMin)) {
      const fallback = parseOpeningWindow(null);
      openMin = fallback.openMin;
      closeMin = fallback.closeMin;
    }
    const all = viewDayKeys.flatMap((k) => spanAppointmentsByDay.get(k) ?? []);
    return dayBounds(spansOf(all), openMin, closeMin);
  }, [view, site, day, dayAppointments, viewDayKeys, spanAppointmentsByDay]);

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

  const spanColumns: DayColumnDayInput[] = useMemo(
    () =>
      viewDayKeys.map((k) => {
        const inWindow = isWithinWindow(k, windowFrom, windowTo);
        const isToday = k === today;
        const appts = spanAppointmentsByDay.get(k) ?? [];
        const nowTop =
          now && isToday && nowFraction(now, k, bounds) !== null
            ? blockEdges(nowMin, nowMin, bounds.startMin, zoom).top
            : null;
        return {
          dayKey: k,
          appointments: appts,
          inWindow,
          isToday,
          nowTop,
          ...columnWork(spanPractitionerId, k, appts),
        };
      }),
    [
      viewDayKeys,
      spanAppointmentsByDay,
      spanPractitionerId,
      columnWork,
      windowFrom,
      windowTo,
      today,
      now,
      bounds,
      nowMin,
      zoom,
    ],
  );

  // --- counts ----------------------------------------------------------------

  // A gap-aware screen that computes from a failed read invents free time, which
  // is worse than the confident empty diary it replaces. So every derived figure
  // is suppressed while either read is untrustworthy.
  const countsUnavailable = readFailed || columnsFailed;

  const caption = useMemo(() => {
    if (readFailed) return `${siteName} · Counts unavailable`;
    if (view === "day") return dayCaption(siteName, dayCounts(dayAppointments));
    // The day-per-column views draw ONE clinician, so the caption counts exactly
    // what is drawn and names whose days they are. Counting the whole practice
    // here put a figure like "212 booked" directly above a grid showing about
    // sixteen blocks. The whole-practice-per-day figures stay on the seven-day
    // strip, which is on screen in every view.
    const drawn = viewDayKeys.flatMap((k) => spanAppointmentsByDay.get(k) ?? []);
    return dayCaption(
      `${siteName} · ${weekClinicianName ?? "No clinician"}`,
      dayCounts(drawn),
    );
  }, [readFailed, siteName, view, dayAppointments, viewDayKeys, spanAppointmentsByDay, weekClinicianName]);

  const strip = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 3)), [day]);
  const stripCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (readFailed) return m;
    for (const d of strip) m.set(d, dayCounts(byDay.get(d) ?? []).booked);
    return m;
  }, [strip, byDay, readFailed]);

  // The figure beside each rail chip counts the SAME span the grid is drawing:
  // that clinician's day in day view, that clinician's whole span in the
  // day-per-column views. A day count sitting beside a five-day grid is a number
  // that quietly means something other than what the reader is looking at.
  const railCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (countsUnavailable) return m;
    if (dayPerColumn) {
      const spanRows = viewDayKeys.flatMap((k) => byDay.get(k) ?? []);
      for (const c of dayColumns) {
        const mine = spanRows.filter((a) => columnKey(a.practitionerId) === c.key);
        m.set(c.key, dayCounts(mine).booked);
      }
      return m;
    }
    for (const c of dayColumns) m.set(c.key, dayCounts(c.appointments).booked);
    return m;
  }, [dayColumns, countsUnavailable, dayPerColumn, viewDayKeys, byDay]);

  // --- keyboard --------------------------------------------------------------

  const focusColumns = useMemo(
    () =>
      view === "day"
        ? visibleDayColumns.map((c) =>
            c.appointments.map((a) => ({ id: a.id, startMin: londonMinutes(a.start) })),
          )
        : spanColumns.map((d) =>
            d.inWindow ? d.appointments.map((a) => ({ id: a.id, startMin: londonMinutes(a.start) })) : [],
          ),
    [view, visibleDayColumns, spanColumns],
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

  // The day-per-column views step by their own span, so [ and ] always move the
  // grid by exactly what is on screen.
  const step = view === "week" ? 7 : view === "multiday" ? span : 1;

  // --- moving an appointment -------------------------------------------------

  /** The spans that CONSUME a clinician's time. cancelled and DNA do not. */
  const occupiedOf = useCallback(
    (appts: readonly DiaryAppointment[]) =>
      appts
        .filter((a) => a.state !== "cancelled" && a.state !== "did_not_attend")
        .map((a) => {
          const startMin = londonMinutes(a.start);
          return { startMin, endMin: startMin + effectiveMinutes(a), appointmentId: a.id };
        })
        .filter((s) => Number.isFinite(s.startMin)),
    [],
  );

  // Every column a move could land on, in ONE shape whichever view is drawn, so
  // the drop validator cannot be given different facts by different views.
  const moveColumns: MoveColumn[] = useMemo(() => {
    if (view === "day") {
      return dayGridColumns.map((c) => ({
        key: c.key,
        practitionerId: c.id,
        name: c.name,
        dayKey: day,
        workState: c.workState,
        workingSpans: c.workingSpans,
        occupied: occupiedOf(c.appointments),
        breaks: occupyingEntries(c.entries, c.id).map((e) => ({
          startMin: e.startMin,
          endMin: e.endMin,
        })),
      }));
    }
    // In the day-per-column views the column axis is DAYS for one clinician, so
    // moving left or right changes the DAY and the clinician is unchanged.
    return spanColumns
      .filter((d) => d.inWindow)
      .map((d) => ({
        key: d.dayKey,
        practitionerId: spanPractitionerId,
        name: weekClinicianName ?? "",
        dayKey: d.dayKey,
        workState: d.workState,
        workingSpans: d.workingSpans,
        occupied: occupiedOf(d.appointments),
        breaks: occupyingEntries(d.entries, spanPractitionerId).map((e) => ({
          startMin: e.startMin,
          endMin: e.endMin,
        })),
      }));
  }, [
    view,
    dayGridColumns,
    day,
    spanColumns,
    spanPractitionerId,
    weekClinicianName,
    occupiedOf,
  ]);

  const appointmentsById = useMemo(() => {
    const m = new Map<string, DiaryAppointment>();
    for (const a of siteAppointments) m.set(a.id, a);
    return m;
  }, [siteAppointments]);

  // A read we did not get REFUSES the move rather than warning about it. During a
  // Dentally availability outage the diary is read only, which is the correct
  // direction for a patient-safety write: an unverifiable move is refused, never
  // guessed. The server enforces the same thing independently.
  //
  // PENDING IS NOT FAILED here either. Until this was gated, stepping to the next
  // day and opening a block while the fetch was still in flight printed "could
  // not be read ... Reload the page" at a moment when nothing had failed and a
  // reload would not have helped: the same false alarm the alerts and the column
  // headers were already careful about. Moves are still refused while pending,
  // because there is nothing to check them against yet; only the WORDS differ.
  //
  // The three sentences are also kept apart by CAUSE. A failed APPOINTMENT read is
  // not a failed working-hours read, and telling a receptionist the wrong thing
  // failed sends them looking in the wrong place.
  const moveBlockedReason = diaryPending
    ? MOVE_BLOCKED_BY_PENDING
    : availabilityFailed
      ? MOVE_BLOCKED_BY_READ
      : readFailed
        ? MOVE_BLOCKED_BY_APPOINTMENTS
        : entriesFailed
          ? MOVE_BLOCKED_BY_ENTRIES
          : null;

  const focusedColumnKey =
    activeFocus === null
      ? null
      : view === "day"
        ? (visibleDayColumns[activeFocus.colIndex]?.key ?? null)
        : (spanColumns[activeFocus.colIndex]?.dayKey ?? null);

  const move = useDiaryMove(
    {
      siteId: site?.id ?? "",
      bounds,
      zoom,
      columns: moveColumns,
      allowed: canMove,
      blockedReason: moveBlockedReason,
      suspended: selected !== null || entryDraft !== null,
      focusedId: activeFocus?.id ?? null,
      focusedColumnKey,
      appointmentsById,
    },
    activePending,
    setPendingMoves,
  );

  const gridDrag: GridDrag = useMemo(
    () => ({
      enabled: move.allowed,
      draggingId: move.draggingId,
      pending: move.pending,
      preview: move.preview,
      registerColumn: move.registerColumn,
      onBlockPointerDown: move.onBlockPointerDown,
      swallowClick: move.swallowClick,
    }),
    [
      move.allowed,
      move.draggingId,
      move.pending,
      move.preview,
      move.registerColumn,
      move.onBlockPointerDown,
      move.swallowClick,
    ],
  );

  // The clinician list the confirmation dialog offers. Always the FULL day column
  // set, and never Unassigned, which is not a person and has no availability.
  const moveClinicians = useMemo(() => {
    const list = dayColumns
      .filter((c) => c.id !== null)
      .map((c) => ({ id: c.id as string, name: c.name }));
    // A slot proposed on another day can name a clinician who has no column
    // today, and a select that cannot show its own value is a trap.
    const chosen = move.proposal?.to;
    if (chosen?.practitionerId && !list.some((c) => c.id === chosen.practitionerId)) {
      list.push({ id: chosen.practitionerId, name: chosen.practitionerName ?? chosen.practitionerId });
    }
    return list;
  }, [dayColumns, move.proposal]);

  // What the dialog may honestly claim about the patient's text. The one thing it
  // can know for certain BEFORE the write is whether the practice has a phone
  // number at all; consent and suppression are checked at drain time, which is
  // why the dialog says "will be texted" and the post-move line reports what
  // actually happened.
  const notifyBlocker: NotifyBlocker =
    site?.publicPhone && site.publicPhone.trim() !== "" ? "none" : "no_phone";

  // lastMove retires itself after UNDO_WINDOW_MS inside the hook, so this is
  // never an offer of a button that would no longer work.
  const undoOffered = move.lastMove !== null;

  // --- breaks and notes ------------------------------------------------------

  /** Open the dialog on a fresh entry, prefilled from wherever the reader is. */
  const openNewEntry = useCallback(
    (startMin: number, dayKey: string, practitionerId: string | null) => {
      const start = Math.max(0, Math.min(1435, Math.round(startMin / 5) * 5));
      setEntryError(null);
      setEntryDraft({
        day: dayKey,
        draft: {
          kind: "break",
          title: "",
          body: "",
          startMin: start,
          endMin: Math.min(1440, start + 60),
          practitionerId,
        },
      });
    },
    [],
  );

  const openExistingEntry = useCallback((entry: DiaryEntryRecord) => {
    setEntryError(null);
    setEntryDraft({
      day: entry.day,
      draft: {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body ?? "",
        startMin: entry.startMin,
        endMin: entry.endMin,
        practitionerId: entry.practitionerId,
      },
    });
  }, []);

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // The move handler runs FIRST and says whether it took the key. It has to:
    // undo is Ctrl+Z, which the metaKey/ctrlKey early return below would swallow,
    // and while a move is in progress the arrows belong to the move rather than
    // to the roving tab stop.
    if (move.onKeyDown(event)) return;

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
    } else if (lower === "n") {
      // 'n' is free: the grid handler claims only the arrows, Home, End, t, [, ],
      // d, w and s. It prefills from wherever the reader already is, so adding a
      // break never costs a hunt for the right time.
      event.preventDefault();
      if (view === "day") {
        const col = activeFocus ? visibleDayColumns[activeFocus.colIndex] : null;
        openNewEntry(activeFocus?.startMin ?? bounds.startMin, day, col?.id ?? null);
      } else {
        const col = activeFocus ? spanColumns[activeFocus.colIndex] : null;
        openNewEntry(activeFocus?.startMin ?? bounds.startMin, col?.dayKey ?? day, spanPractitionerId);
      }
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

  /**
   * A slot picked from the reschedule suggestions goes through the SAME dialog and
   * the SAME write route as a drag. There is one commit path, not two.
   */
  const onPickProposal = useCallback(
    (p: Proposal) => {
      const appt = selected;
      if (!appt) return;
      const startMin = londonMinutes(appt.start);
      move.openProposal({
        appointment: appt,
        from: {
          dayKey: safeDayKey(appt.start) ?? day,
          startMin,
          endMin: startMin + effectiveMinutes(appt),
          practitionerId: appt.practitionerId,
          practitionerName: selectedClinician,
        },
        to: {
          dayKey: p.dayKey,
          startMin: p.startMin,
          endMin: p.endMin,
          practitionerId: p.practitionerId,
          practitionerName: p.practitionerName,
        },
        fromSuggestion: true,
      });
      // The panel closes so the confirmation is the only thing on screen: a
      // blocking clinical write must not be answered past another dialog.
      closePanel();
    },
    [selected, selectedClinician, day, move, closePanel],
  );

  // A CONFIRMED move invalidates the appointment cache server side, so the board
  // may now ask for the truth. Until it arrives the optimistic overlay stays
  // authoritative, and the effect above drops each entry only once the server
  // prop genuinely carries it.
  const router = useRouter();
  const refreshedFor = useRef<number | null>(null);
  useEffect(() => {
    const at = move.lastMove?.at ?? null;
    if (at === null || refreshedFor.current === at) return;
    refreshedFor.current = at;
    router.refresh();
  }, [move.lastMove, router]);

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

  const saveEntry = useCallback(
    async (value: EntryDraft) => {
      if (!site || !entryDraft) return;
      setEntryBusy(true);
      setEntryError(null);
      try {
        const res = await fetch("/api/diary/entry", {
          method: value.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            siteId: site.id,
            id: value.id,
            day: entryDraft.day,
            kind: value.kind,
            title: value.title,
            body: value.body,
            startMin: value.startMin,
            endMin: value.endMin,
            practitionerId: value.practitionerId,
          }),
        });
        const payload = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || payload.ok !== true) {
          // The server's own words, verbatim. A generic shrug here would leave a
          // reader unable to tell a validation slip from an outage.
          setEntryError(payload.error ?? "That could not be saved. The diary has not been changed.");
          return;
        }
        setEntryDraft(null);
        setEntryNonce((n) => n + 1);
      } catch {
        setEntryError("That could not be saved. The diary has not been changed.");
      } finally {
        setEntryBusy(false);
      }
    },
    [site, entryDraft],
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      if (!site) return;
      setEntryBusy(true);
      setEntryError(null);
      try {
        const res = await fetch("/api/diary/entry", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ siteId: site.id, id }),
        });
        const payload = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || payload.ok !== true) {
          setEntryError(payload.error ?? "That could not be removed. The diary has not been changed.");
          return;
        }
        setEntryDraft(null);
        setEntryNonce((n) => n + 1);
      } catch {
        setEntryError("That could not be removed. The diary has not been changed.");
      } finally {
        setEntryBusy(false);
      }
    },
    [site],
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
  if (view === "multiday") {
    notes.push(
      `Multiday shows one clinician across ${span} days from ${longDate(day)}: ${weekClinicianName ?? "none available"}. Pick another below.`,
    );
  }
  if (view === "day" && soloDropped) {
    notes.push("The clinician you picked is not in this day's diary, so every clinician is shown.");
  }

  // The clinician list the entry dialog offers, plus the site-wide option it adds
  // itself. Always the FULL day column set, never the soloed subset: a break can
  // legitimately be hung on a clinician who is not the one currently drawn.
  const entryClinicians = useMemo(
    () => dayColumns.filter((c) => c.id !== null).map((c) => ({ id: c.id, name: c.name })),
    [dayColumns],
  );

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
          {rangeLabel}
        </h1>

        <p className="hidden min-w-0 truncate text-[11px] font-medium tabular-nums text-muted sm:block">
          {caption}
        </p>
        {/* A missing rail is visually identical to "not on file", so the absence
            has to be stated where the figures are, not only in the alert above. */}
        {fundingFailed && !diaryPending ? (
          <span className="hidden shrink-0 rounded-md border border-tint-amber-line bg-tint-amber px-1.5 py-[1px] text-[10px] font-semibold text-ink sm:inline">
            Funding: not loaded
          </span>
        ) : null}

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
            <Segment label="View">
              {(["day", "week", "multiday"] as View[]).map((v) => (
                <SegmentBtn key={v} active={view === v} onClick={() => setView(v)} className="capitalize">
                  {v}
                </SegmentBtn>
              ))}
            </Segment>
          </div>
          {view === "multiday" ? (
            <div className="hidden lg:block">
              <Segment label="Days shown">
                {MULTIDAY_SPANS.map((n) => (
                  <SegmentBtn key={n} active={span === n} onClick={() => setSpan(n)}>
                    {n}
                  </SegmentBtn>
                ))}
              </Segment>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() =>
              openNewEntry(
                bounds.startMin + 240,
                day,
                view === "day" ? null : spanPractitionerId,
              )
            }
            className="pressable hidden h-6 shrink-0 rounded-md border border-line-strong bg-card px-2 text-[11px] font-medium text-ink transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 lg:block"
          >
            Add break or note
          </button>
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

      {/* The standing context, and the KEY beside it. One row, so the decoder
          for the whole screen costs a single line of chrome while it is shut.
          The key is what makes the state letters learnable: P, C, the clock, S
          and the tick are Dentally's own notation and the practice reads them
          fluently, but a new receptionist could previously only find out what an
          "S" meant by hovering a block. */}
      <div className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1", bleed)}>
        {notes.length > 0 ? (
          <p className="min-w-0 flex-1 text-[10px] font-medium text-muted">{notes.join(" ")}</p>
        ) : (
          <span className="flex-1" />
        )}
        <DiaryKey />
      </div>

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
      {/* THREE SEPARATE SENTENCES for three separate reads, never one shrug. Each
          absence looks different on the grid and each needs its own words. */}
      {availabilityFailed && !diaryPending ? (
        <Alert>
          Working hours could not be read for {siteName}. The diary cannot say who is working today.
          Booked appointments below are still correct.
        </Alert>
      ) : null}
      {fundingFailed && !diaryPending ? (
        <Alert>
          Funding could not be read for {siteName}. No appointment shows NHS or private today.
        </Alert>
      ) : null}
      {entriesFailed && !diaryPending ? (
        <Alert>Breaks and notes could not be read for {siteName}.</Alert>
      ) : null}
      {/* A move that did not save, or one we could not verify. It stays until it
          is dismissed or the day changes, because it is the only place the
          reader learns that what they see is not what Dentally holds. */}
      {move.alert ? (
        <Alert>
          <span className="flex flex-wrap items-baseline gap-2">
            <span>{move.alert}</span>
            <button
              type="button"
              onClick={move.dismissAlert}
              className="text-[11px] font-semibold text-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              Dismiss
            </button>
          </span>
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

      {/* What is happening to a move, in words, for the shortest blocks where no
          outline is legible and for anyone reading across a desk. */}
      {move.savingLine || undoOffered ? (
        <p className={cn("flex shrink-0 flex-wrap items-baseline gap-2 text-[11px]", bleed)}>
          {move.savingLine ? (
            <span className="font-medium tabular-nums text-ink">{move.savingLine}</span>
          ) : null}
          {undoOffered && move.lastMove ? (
            <>
              <span className="font-medium tabular-nums text-ink">
                Moved {move.lastMove.patientShort} to {labelMinutes(move.lastMove.to.startMin)}
                {move.lastMove.to.practitionerName ? ` with ${move.lastMove.to.practitionerName}` : ""}.
              </span>
              {/* What actually happened to the text, read back from the stored
                  provider rather than assumed from the intent. A simulated send
                  can never be reported as a real one. */}
              {move.lastMove.notify?.queued ? (
                messagingDryRun ? (
                  <span className="rounded-[3px] border border-tint-amber-line bg-tint-amber px-1 font-semibold text-status-amber">
                    Text simulated, not delivered
                  </span>
                ) : (
                  <span className="font-medium text-muted">Text queued</span>
                )
              ) : move.lastMove.notify?.reason === "no_phone" ? (
                <span className="font-medium text-muted">
                  No text sent: no practice phone number is configured
                </span>
              ) : move.lastMove.notify?.reason === "time_unchanged" ? (
                <span className="font-medium text-muted">No text sent: the time did not change</span>
              ) : null}
              <button
                type="button"
                onClick={move.undo}
                className="rounded-md border border-line-strong bg-card px-2 py-[1px] text-[11px] font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              >
                Undo
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <p id={instructionsId} className="sr-only">
        Use the arrow keys to move between appointments, Home and End for the first and last in a
        column, Enter to open an appointment, and Escape to close it. Press t for today, square
        brackets to change day, d for day view, w for week view, s to show only the focused
        clinician, and n to add a break or a note. Press M on an appointment to move it, R to resize
        it. In move mode the arrow keys shift the time by five minutes and Shift with an arrow by
        thirty; left and right change clinician. Enter opens a confirmation. Escape cancels.
      </p>
      <p role="status" className="sr-only">
        {rangeLabel}. {caption}.
      </p>
      {/* A SECOND live region, dedicated to moving. The one above carries the date
          and the caption, would not retrigger on a move (dayCounts does not
          change) and would fight the day-change announcement. */}
      <p role="status" aria-live="polite" className="sr-only">
        {move.status}
      </p>

      {view === "day" ? (
        <DiaryDay
          columns={visibleGridColumns}
          bounds={bounds}
          zoom={zoom}
          ariaLabel={`Diary, ${longDate(day)}, ${siteName}`}
          soloKey={effectiveSolo}
          onSolo={onSolo}
          countsUnavailable={countsUnavailable}
          funding={funding}
          hoursPending={diaryPending}
          nowTop={dayNowTop}
          nowLabel={nowLabel}
          focusedId={activeFocus?.id ?? null}
          onFocusItem={(colIndex, appt) =>
            setFocus({ colIndex, id: appt.id, startMin: londonMinutes(appt.start) })
          }
          onOpen={openAppointment}
          onOpenEntry={openExistingEntry}
          onKeyDown={onGridKeyDown}
          describedById={instructionsId}
          drag={gridDrag}
        />
      ) : (
        <DiaryDays
          days={spanColumns}
          clinicianName={weekClinicianName}
          bounds={bounds}
          zoom={zoom}
          ariaLabel={`Diary, ${view === "week" ? weekLabel(day) : `${span} days from ${longDate(day)}`}, ${weekClinicianName ?? "no clinician selected"}, ${siteName}`}
          countsUnavailable={countsUnavailable}
          funding={funding}
          hoursPending={diaryPending}
          onPickDay={onPickDay}
          focusedId={activeFocus?.id ?? null}
          onFocusItem={(colIndex, appt) =>
            setFocus({ colIndex, id: appt.id, startMin: londonMinutes(appt.start) })
          }
          onOpen={openAppointment}
          onOpenEntry={openExistingEntry}
          onKeyDown={onGridKeyDown}
          describedById={instructionsId}
          selectedDay={day}
          drag={gridDrag}
        />
      )}

      {selected ? (
        <AppointmentPanel
          appointment={selected}
          clinicianName={selectedClinician}
          siteName={siteName}
          siteId={site?.id ?? ""}
          dayKey={safeDayKey(selected.start) ?? day}
          funding={funding[selected.patientId] ?? "unknown"}
          fundingFailed={fundingFailed}
          clientSlug={clientSlug}
          // The RAW role gate, not move.allowed: the panel tells a reader whose
          // role forbids moving something different from a reader whose role
          // allows it but whose reads failed, and move.allowed folds the two.
          canMove={canMove}
          writeEnabled={writeEnabled}
          moveBlockedReason={moveBlockedReason}
          onPickProposal={onPickProposal}
          onClose={closePanel}
        />
      ) : null}

      {/* The confirmation. Dropping a block does not commit anything: this does,
          and there is exactly ONE of it, reached identically by the pointer and by
          the keyboard. */}
      {move.proposal ? (
        <MoveConfirmDialog
          proposal={move.proposal}
          clinicians={moveClinicians}
          busy={move.proposalBusy}
          error={move.proposalError}
          refusal={move.proposalRefusal}
          notifyBlocker={notifyBlocker}
          dryRun={messagingDryRun}
          onEdit={move.editProposal}
          onNo={move.cancelProposal}
          onYes={move.confirmProposal}
        />
      ) : null}

      {entryDraft ? (
        <EntryDialog
          draft={entryDraft.draft}
          day={entryDraft.day}
          clinicians={entryClinicians}
          busy={entryBusy}
          error={entryError}
          onSave={saveEntry}
          onDelete={deleteEntry}
          onCancel={() => {
            setEntryDraft(null);
            setEntryError(null);
          }}
        />
      ) : null}
    </div>
  );
}
