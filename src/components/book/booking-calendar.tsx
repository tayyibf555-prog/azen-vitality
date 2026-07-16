"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronRight, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { earliestSlots } from "@/lib/booking/slots";
import { createFunnelTracker, type FunnelTracker } from "@/lib/funnel/client";

// Public booking calendar for /book/<client>. A simple two-step booking in four
// screens, kept as plain as Dentally's own flow (big obvious steps, little
// scrolling):
//
//   times   — "next available" quick-pick chips (soonest first), then a
//             horizontal strip of the next 14 days (extendable once to 28) with
//             per-day slot counts and the selected day's times grouped
//             morning/afternoon.
//   details — STEP 1: the chosen time summarised, plus name/mobile/email. Submit
//             HOLDS the time (POST /api/booking/hold) with NO Dentally write, and
//             a short line that the practice may text about the booking.
//   confirm — STEP 2: the exact slot read back, one big "Confirm" that runs the
//             existing POST /api/booking/create (which flips the hold to
//             confirmed).
//   success — the booked confirmation.
//
// Availability comes from GET /api/booking/slots (max 14 days per request, so
// the "next two weeks" toggle issues exactly one extra request). The server is
// the authority on validation and slot freshness; its error strings are
// patient-friendly and rendered VERBATIM. On a 409 at confirm (slot just taken)
// we re-pull availability so the taken time disappears and return the patient to
// the time grid with the message visible.
//
// Anonymous, PII-free funnel events (viewed / slot_selected / details_submitted /
// confirmed) are fired fire-and-forget for the drop-off report; they never block
// the UI.
//
// All dates and times are presented in Europe/London regardless of the
// device's timezone, matching the practice diary.

interface Slot {
  start: string;
  finish: string;
  practitionerId: string | null;
}

interface Props {
  clientSlug: string;
  siteId: string;
  siteName: string;
}

type Phase = "times" | "details" | "confirm" | "success";

const GENERIC_ERROR = "Sorry, something went wrong. Please try again in a moment.";

/* ---------------------------------------------------------------------------
 * Europe/London date helpers
 * ------------------------------------------------------------------------- */

const TZ = "Europe/London";

// en-CA formats as YYYY-MM-DD, which is exactly our day-key shape.
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const weekdayShortFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: TZ });
const dayMonthFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ });
const longDateFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: TZ,
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: TZ,
});
const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: TZ });

/** Today's date in Europe/London as YYYY-MM-DD. */
function londonToday(): string {
  return dayKeyFmt.format(new Date());
}

/** Pure calendar arithmetic on a YYYY-MM-DD string (no timezone involved). */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * A Date safely inside the given London day, for date-part formatting. Noon UTC
 * is 12:00 or 13:00 in London, so it can never fall on a neighbouring day.
 */
function noonUtc(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00Z`);
}

/** "9:30am" in London time (formatter gives "9:30 am"; drop the space). */
function timeLabel(iso: string): string {
  return timeFmt.format(new Date(iso)).replace(/[\s\u202f\u00a0]/g, "");
}

/** Hour of day (0-23) in London, for morning/afternoon grouping. */
function londonHour(iso: string): number {
  return parseInt(hourFmt.format(new Date(iso)), 10);
}

/* ---------------------------------------------------------------------------
 * Response parsing
 * ------------------------------------------------------------------------- */

/**
 * Normalise a /slots response into { dayKey: sorted slots }. Slots are sorted
 * by start and de-duplicated by start time (two practitioners free at 9:30
 * should read as ONE bookable 9:30 to a patient). Returns null on any shape
 * we don't recognise so the caller can show the retry state.
 */
function parseDays(raw: unknown): Record<string, Slot[]> | null {
  if (!Array.isArray(raw)) return null;
  const out: Record<string, Slot[]> = {};
  for (const day of raw) {
    if (!day || typeof day !== "object") continue;
    const d = day as { date?: unknown; slots?: unknown };
    if (typeof d.date !== "string" || !Array.isArray(d.slots)) continue;
    const slots: Slot[] = [];
    for (const s of d.slots) {
      if (!s || typeof s !== "object") continue;
      const ss = s as { start?: unknown; finish?: unknown; practitionerId?: unknown };
      if (typeof ss.start !== "string" || typeof ss.finish !== "string") continue;
      slots.push({
        start: ss.start,
        finish: ss.finish,
        practitionerId: typeof ss.practitionerId === "string" ? ss.practitionerId : null,
      });
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    const deduped: Slot[] = [];
    for (const s of slots) {
      if (deduped.length === 0 || deduped[deduped.length - 1].start !== s.start) deduped.push(s);
    }
    out[d.date] = deduped;
  }
  return out;
}

/**
 * Expand a parsed response over a full 14-day range: every date in the range
 * gets an entry (missing days become []). This means a re-pull genuinely
 * CLEARS days the server no longer returns, rather than leaving stale slots.
 */
function fillRange(got: Record<string, Slot[]>, from: string): Record<string, Slot[]> {
  const out: Record<string, Slot[]> = {};
  for (let i = 0; i < 14; i++) {
    const d = addDays(from, i);
    out[d] = got[d] ?? [];
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

export function BookingCalendar({ clientSlug, siteId, siteName }: Props) {
  // "today" is fixed for the life of the page so the strip never shifts under
  // the patient mid-flow.
  const [today] = useState(() => londonToday());

  const [phase, setPhase] = useState<Phase>("times");
  const [daysByDate, setDaysByDate] = useState<Record<string, Slot[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [extended, setExtended] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Slot | null>(null);

  // Details step (step 1).
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The step-1 hold id, once the time is held; carried into the step-2 confirm.
  const [holdId, setHoldId] = useState<string | null>(null);

  // Success screen: what the server confirmed we booked.
  const [booked, setBooked] = useState<{ start: string } | null>(null);

  // Bumped on every screen change so the entrance animation re-triggers.
  const [animKey, setAnimKey] = useState(0);
  // Guards a rapid double-tap on the hold / confirm buttons.
  const submitting = useRef(false);

  // PII-free funnel telemetry. Lazy one-time init so listeners are registered once.
  const trackerRef = useRef<FunnelTracker | null>(null);
  if (trackerRef.current === null) {
    trackerRef.current = createFunnelTracker({ surface: "booking", clientSlug });
  }
  useEffect(() => {
    trackerRef.current?.track("viewed");
  }, []);

  const dates = useMemo(() => {
    const count = extended ? 28 : 14;
    return Array.from({ length: count }, (_, i) => addDays(today, i));
  }, [today, extended]);

  /** Fetch one <=14-day range of availability. Returns null on any failure. */
  const fetchRange = useCallback(
    async (from: string, to: string): Promise<Record<string, Slot[]> | null> => {
      try {
        const qs = new URLSearchParams({ client: clientSlug, site: siteId, from, to });
        const res = await fetch(`/api/booking/slots?${qs.toString()}`);
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; days?: unknown }
          | null;
        if (!res.ok || !data?.ok) return null;
        return parseDays(data.days);
      } catch {
        return null;
      }
    },
    [clientSlug, siteId],
  );

  // Initial load (and manual retry via retryKey).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadFailed(false);
      const got = await fetchRange(today, addDays(today, 13));
      if (cancelled) return;
      if (!got) {
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      const filled = fillRange(got, today);
      setDaysByDate(filled);
      // Land the patient on the first day that actually has a time.
      const firstWithSlots = Array.from({ length: 14 }, (_, i) => addDays(today, i)).find(
        (d) => filled[d].length > 0,
      );
      setSelectedDate(firstWithSlots ?? today);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRange, today, retryKey]);

  /** The one-shot "next two weeks" extension (days 14..27). */
  async function loadMore() {
    if (loadingMore || extended) return;
    setLoadingMore(true);
    setError(null);
    const got = await fetchRange(addDays(today, 14), addDays(today, 27));
    if (!got) {
      setError("We couldn't load more times just then. Please try again.");
      setLoadingMore(false);
      return;
    }
    const extra = fillRange(got, addDays(today, 14));
    const merged = { ...daysByDate, ...extra };
    setDaysByDate(merged);
    setExtended(true);
    // If the patient extended because nothing suited (or nothing existed),
    // jump them to the first new day that has a time.
    const selectedHasSlots = selectedDate ? (merged[selectedDate]?.length ?? 0) > 0 : false;
    if (!selectedHasSlots) {
      const firstNew = Array.from({ length: 14 }, (_, i) => addDays(today, 14 + i)).find(
        (d) => extra[d].length > 0,
      );
      if (firstNew) setSelectedDate(firstNew);
    }
    setLoadingMore(false);
  }

  /** Re-pull every loaded range (used after a 409 so taken times disappear). */
  const refreshSlots = useCallback(async () => {
    const base = await fetchRange(today, addDays(today, 13));
    const extra = extended ? await fetchRange(addDays(today, 14), addDays(today, 27)) : null;
    // Best effort, per range: keep a stale range rather than blanking it if
    // its re-pull fails.
    if (!base && !extra) return;
    setDaysByDate((prev) => ({
      ...prev,
      ...(base ? fillRange(base, today) : {}),
      ...(extra ? fillRange(extra, addDays(today, 14)) : {}),
    }));
  }, [fetchRange, today, extended]);

  function chooseSlot(slot: Slot) {
    setChosen(slot);
    setHoldId(null);
    setError(null);
    setPhase("details");
    setAnimKey((k) => k + 1);
    trackerRef.current?.track("slot_selected");
  }

  function backToTimes() {
    if (busy) return;
    setChosen(null);
    setHoldId(null);
    setError(null);
    setPhase("times");
    setAnimKey((k) => k + 1);
  }

  /** From the confirm step, step back to the details (step 1) to edit anything. */
  function backToDetails() {
    if (busy) return;
    setError(null);
    setPhase("details");
    setAnimKey((k) => k + 1);
  }

  // Mirrors the server's requirements so the button only lights up when the
  // form could plausibly succeed; exact patterns are checked on submit.
  const canSubmit =
    firstName.trim() !== "" && lastName.trim() !== "" && phone.trim() !== "" && !busy;

  /** Fetch the short-lived public-funnel page token (best effort). */
  async function fetchPageToken(): Promise<string | undefined> {
    return fetch(`/api/smile-assessment/token?client=${encodeURIComponent(clientSlug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { token?: string | null } | null) => j?.token ?? undefined)
      .catch(() => undefined);
  }

  /**
   * STEP 1 — hold the time. Validates the details, then POSTs /api/booking/hold
   * (NO Dentally write). On success we move to the confirm screen; the real
   * appointment is only created there.
   */
  async function submitHold(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current || busy || !chosen) return;

    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln) {
      setError("Please enter your first and last name.");
      return;
    }
    // Same normalisation the server applies (07... / +44... / spaces all fine),
    // then require a UK mobile so the confirmation text can actually reach them.
    const e164 = toE164(phone);
    if (!e164 || !/^\+447\d{9}$/.test(e164)) {
      setError("Please enter a UK mobile number, like 07700 900123.");
      return;
    }
    const rawEmail = email.trim();
    const normEmail = rawEmail ? normaliseEmail(rawEmail) : null;
    if (rawEmail && !normEmail) {
      setError("Please check your email address, or leave it blank.");
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const pageToken = await fetchPageToken();
      const res = await fetch("/api/booking/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          siteId,
          slotStart: chosen.start,
          finish: chosen.finish,
          practitionerId: chosen.practitionerId,
          firstName: fn,
          lastName: ln,
          phone: phone.trim(),
          email: normEmail ?? undefined,
          pageToken,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; holdId?: unknown; error?: unknown }
        | null;

      if (res.ok && data?.ok && typeof data.holdId === "string") {
        setHoldId(data.holdId);
        setPhase("confirm");
        setAnimKey((k) => k + 1);
        trackerRef.current?.track("details_submitted");
        return;
      }

      const message =
        typeof data?.error === "string" && data.error.trim() !== "" ? data.error : GENERIC_ERROR;
      setError(message);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  /**
   * STEP 2 — confirm. Runs the EXISTING create path, which revalidates the slot
   * against live availability, writes the Dentally appointment and flips the hold
   * to confirmed. On a 409 (taken while they were on the confirm screen) we return
   * to the grid and refresh so the gone time disappears.
   */
  async function confirmBooking() {
    if (submitting.current || busy || !chosen) return;

    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const pageToken = await fetchPageToken();
      const res = await fetch("/api/booking/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          siteId,
          slotStart: chosen.start,
          finish: chosen.finish,
          practitionerId: chosen.practitionerId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          email: email.trim() ? normaliseEmail(email.trim()) ?? undefined : undefined,
          holdId: holdId ?? undefined,
          pageToken,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; booked?: { start?: unknown }; error?: unknown }
        | null;

      if (res.ok && data?.ok) {
        const start =
          data.booked && typeof data.booked.start === "string" ? data.booked.start : chosen.start;
        setBooked({ start });
        setPhase("success");
        setAnimKey((k) => k + 1);
        trackerRef.current?.track("confirmed");
        return;
      }

      // The server's error strings are written for patients; show them as-is.
      const message =
        typeof data?.error === "string" && data.error.trim() !== "" ? data.error : GENERIC_ERROR;

      if (res.status === 409) {
        // The time was taken while they were confirming: back to the grid, message
        // visible, and a fresh pull so the taken time disappears.
        setChosen(null);
        setHoldId(null);
        setPhase("times");
        setError(message);
        setAnimKey((k) => k + 1);
        void refreshSlots();
        return;
      }
      setError(message);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const selectedSlots = selectedDate ? (daysByDate[selectedDate] ?? []) : [];
  const totalSlots = dates.reduce((n, d) => n + (daysByDate[d]?.length ?? 0), 0);

  // The soonest 3 bookable times across every loaded day, for the one-tap "next
  // available" chips. Dentally deliberately leads with the earliest availability;
  // the shared pure helper keeps that ordering identical here and in tests.
  const earliest = useMemo(
    () =>
      earliestSlots(
        dates.map((d) => ({ date: d, slots: daysByDate[d] ?? [] })),
        3,
      ),
    [dates, daysByDate],
  );

  return (
    <div className="overflow-hidden rounded-[1.4rem] border border-line bg-card shadow-[0_8px_40px_rgba(10,14,26,0.08)]">
      <style>{ENTER_KEYFRAMES}</style>
      <div className="p-5 sm:p-7">
        {phase === "success" && booked ? (
          <SuccessScreen animKey={animKey} startIso={booked.start} siteName={siteName} />
        ) : phase === "confirm" && chosen ? (
          <ConfirmStep
            animKey={animKey}
            chosen={chosen}
            siteName={siteName}
            firstName={firstName}
            lastName={lastName}
            phone={phone}
            busy={busy}
            error={error}
            onConfirm={confirmBooking}
            onBack={backToDetails}
          />
        ) : phase === "details" && chosen ? (
          <DetailsStep
            animKey={animKey}
            chosen={chosen}
            siteName={siteName}
            firstName={firstName}
            setFirstName={setFirstName}
            lastName={lastName}
            setLastName={setLastName}
            phone={phone}
            setPhone={setPhone}
            email={email}
            setEmail={setEmail}
            canSubmit={canSubmit}
            busy={busy}
            error={error}
            onSubmit={submitHold}
            onBack={backToTimes}
          />
        ) : loading ? (
          <LoadingSkeleton />
        ) : loadFailed ? (
          <LoadFailed onRetry={() => setRetryKey((k) => k + 1)} />
        ) : (
          <div key={animKey} className="motion-safe:[animation:bookEnter_240ms_ease-out]">
            {error ? (
              <p
                role="alert"
                className="mb-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]"
              >
                {error}
              </p>
            ) : null}

            {totalSlots === 0 ? (
              <EmptyRange extended={extended} loadingMore={loadingMore} onLoadMore={loadMore} />
            ) : (
              <>
                <QuickPicks slots={earliest} today={today} onChoose={chooseSlot} />
                <DayStrip
                  dates={dates}
                  today={today}
                  daysByDate={daysByDate}
                  selectedDate={selectedDate}
                  onSelect={(d) => {
                    setSelectedDate(d);
                    setError(null);
                  }}
                  extended={extended}
                  loadingMore={loadingMore}
                  onLoadMore={loadMore}
                />
                <SlotGrid
                  selectedDate={selectedDate}
                  slots={selectedSlots}
                  onChoose={chooseSlot}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Times screen pieces
 * ------------------------------------------------------------------------- */

/**
 * "Next available" quick-pick chips: the soonest few times, one tap to book.
 * Surfaces the earliest availability first the way Dentally deliberately does, so
 * the common case (book the next free slot) needs no calendar hunting.
 */
function QuickPicks({
  slots,
  today,
  onChoose,
}: {
  slots: Array<Slot & { date: string }>;
  today: string;
  onChoose: (slot: Slot) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-2 flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted">
        <Clock size={12} aria-hidden />
        Next available
      </p>
      <div className="flex flex-wrap gap-2">
        {slots.map((s) => {
          const prefix =
            s.date === today
              ? "Today"
              : s.date === addDays(today, 1)
                ? "Tomorrow"
                : weekdayShortFmt.format(noonUtc(s.date));
          return (
            <button
              key={s.start}
              type="button"
              onClick={() => onChoose(s)}
              aria-label={`Book ${longDateFmt.format(noonUtc(s.date))} at ${timeLabel(s.start)}`}
              className={[
                "inline-flex items-center gap-1.5 rounded-full border border-blue-dark/30 bg-blue-dark/[0.06] px-3 py-2 text-sm transition duration-150 ease-out",
                "hover:border-blue-dark/60 hover:bg-blue-dark/[0.12] motion-safe:hover:-translate-y-0.5",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              ].join(" ")}
            >
              <span className="font-semibold text-navy">{prefix}</span>
              <span className="font-semibold text-blue-deep">{timeLabel(s.start)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayStrip({
  dates,
  today,
  daysByDate,
  selectedDate,
  onSelect,
  extended,
  loadingMore,
  onLoadMore,
}: {
  dates: string[];
  today: string;
  daysByDate: Record<string, Slot[]>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
  extended: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Choose a day"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-3"
    >
      {dates.map((date) => {
        const count = daysByDate[date]?.length ?? 0;
        const selected = date === selectedDate;
        const top =
          date === today
            ? "Today"
            : date === addDays(today, 1)
              ? "Tomorrow"
              : weekdayShortFmt.format(noonUtc(date));
        const main = dayMonthFmt.format(noonUtc(date));
        const aria = `${longDateFmt.format(noonUtc(date))}, ${
          count === 0 ? "no times available" : `${count} ${count === 1 ? "time" : "times"} available`
        }`;
        return (
          <button
            key={date}
            type="button"
            aria-pressed={selected}
            aria-label={aria}
            onClick={() => onSelect(date)}
            className={[
              "flex w-[4.6rem] shrink-0 flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 transition duration-150 ease-out",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              selected
                ? "border-navy bg-navy text-on-navy shadow-[0_3px_14px_rgba(11,32,73,0.22)]"
                : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted",
            ].join(" ")}
          >
            <span
              className={[
                "text-[0.62rem] font-semibold uppercase tracking-wide",
                selected ? "text-on-navy-muted" : "text-muted",
              ].join(" ")}
            >
              {top}
            </span>
            <span className={["text-sm font-bold", selected ? "text-on-navy" : "text-navy"].join(" ")}>
              {main}
            </span>
            <span
              className={[
                "text-[0.65rem] font-semibold",
                count === 0
                  ? selected
                    ? "text-on-navy-muted/70"
                    : "text-muted/60"
                  : selected
                    ? "text-on-navy-muted"
                    : "text-blue-deep",
              ].join(" ")}
              aria-hidden
            >
              {count === 0 ? "—" : `${count} ${count === 1 ? "time" : "times"}`}
            </span>
          </button>
        );
      })}

      {!extended ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className={[
            "flex w-[4.6rem] shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong bg-card px-2 py-2.5 text-muted transition duration-150 ease-out",
            "hover:border-blue-dark/40 hover:bg-card-muted hover:text-blue-deep",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            "disabled:opacity-60",
          ].join(" ")}
        >
          {loadingMore ? (
            <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <ChevronRight size={16} aria-hidden />
          )}
          <span className="text-center text-[0.62rem] font-semibold uppercase tracking-wide leading-tight">
            Next two weeks
          </span>
        </button>
      ) : null}
    </div>
  );
}

function SlotGrid({
  selectedDate,
  slots,
  onChoose,
}: {
  selectedDate: string | null;
  slots: Slot[];
  onChoose: (slot: Slot) => void;
}) {
  if (!selectedDate) return null;
  const morning = slots.filter((s) => londonHour(s.start) < 12);
  const afternoon = slots.filter((s) => londonHour(s.start) >= 12);

  return (
    <div className="mt-1">
      <h2 className="mb-3 text-sm font-bold text-navy">{longDateFmt.format(noonUtc(selectedDate))}</h2>

      {slots.length === 0 ? (
        <p className="rounded-xl bg-card-muted px-4 py-5 text-center text-sm text-muted">
          No times available this day. Try another day above.
        </p>
      ) : (
        <div className="space-y-4">
          {(
            [
              ["Morning", morning],
              ["Afternoon", afternoon],
            ] as const
          ).map(([label, group]) =>
            group.length === 0 ? null : (
              <div key={label}>
                <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted">
                  {label}
                </p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {group.map((slot) => (
                    <button
                      key={slot.start}
                      type="button"
                      onClick={() => onChoose(slot)}
                      className={[
                        "rounded-lg border border-line bg-card px-2 py-2.5 text-sm font-semibold text-navy transition duration-150 ease-out",
                        "hover:border-blue-dark/50 hover:bg-blue-dark/[0.08] motion-safe:hover:-translate-y-0.5",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                      ].join(" ")}
                    >
                      {timeLabel(slot.start)}
                    </button>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function EmptyRange({
  extended,
  loadingMore,
  onLoadMore,
}: {
  extended: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-dark/10 text-blue-dark">
        <CalendarDays size={22} />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-navy">
          {extended ? "No times in the next four weeks" : "No times in the next two weeks"}
        </p>
        <p className="max-w-xs text-sm text-muted">
          {extended
            ? "Please call the practice and the team will find you a time."
            : "Check a little further ahead, or call the practice and the team will find you a time."}
        </p>
      </div>
      {!extended ? (
        <Button type="button" variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
          See the next two weeks
        </Button>
      ) : null}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div aria-hidden className="motion-safe:animate-pulse">
        <div className="-mx-1 flex gap-2 overflow-hidden px-1 pb-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[4.6rem] w-[4.6rem] shrink-0 rounded-xl bg-card-muted" />
          ))}
        </div>
        <div className="mb-3 mt-1 h-4 w-40 rounded bg-card-muted" />
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-10 rounded-lg bg-card-muted" />
          ))}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        Loading available times
      </span>
    </div>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p role="alert" className="max-w-xs text-sm text-muted">
        We couldn&apos;t load the available times. Please check your connection and try again.
      </p>
      <Button type="button" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Details screen
 * ------------------------------------------------------------------------- */

const inputClass =
  "w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";

function DetailsStep({
  animKey,
  chosen,
  siteName,
  firstName,
  setFirstName,
  lastName,
  setLastName,
  phone,
  setPhone,
  email,
  setEmail,
  canSubmit,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  animKey: number;
  chosen: Slot;
  siteName: string;
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  canSubmit: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <form
      key={animKey}
      onSubmit={onSubmit}
      className="space-y-4 motion-safe:[animation:bookEnter_240ms_ease-out]"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
        >
          <ArrowLeft size={14} />
          Change time
        </button>
        <span className="rounded-full bg-card-muted px-2.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-ink">
          Step 1 of 2
        </span>
      </div>

      <div className="rounded-xl bg-blue-dark/[0.08] px-3.5 py-3">
        <p className="text-sm font-bold text-navy">
          {longDateFmt.format(new Date(chosen.start))}, {timeLabel(chosen.start)}
        </p>
        <p className="text-xs text-muted">at {siteName}</p>
        <p className="mt-1 text-xs font-medium text-blue-deep">We&apos;ll hold this time for you.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            First name
          </span>
          <input
            type="text"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            Last name
          </span>
          <input
            type="text"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
          UK mobile number
        </span>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
          Email <span className="normal-case tracking-normal text-muted/80">(optional)</span>
        </span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={!canSubmit}>
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        Hold this time for me
      </Button>
      {/* Consent microcopy: plain, non-clinical, and specific to this booking. */}
      <p className="text-center text-xs text-muted">
        We&apos;ll hold this time and may text you about this booking. Nothing is confirmed until the
        next step.
      </p>
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Confirm screen (step 2)
 * ------------------------------------------------------------------------- */

function ConfirmStep({
  animKey,
  chosen,
  siteName,
  firstName,
  lastName,
  phone,
  busy,
  error,
  onConfirm,
  onBack,
}: {
  animKey: number;
  chosen: Slot;
  siteName: string;
  firstName: string;
  lastName: string;
  phone: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div
      key={animKey}
      className="space-y-4 motion-safe:[animation:bookEnter_240ms_ease-out]"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
        >
          <ArrowLeft size={14} />
          Change details
        </button>
        <span className="rounded-full bg-card-muted px-2.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-ink">
          Step 2 of 2
        </span>
      </div>

      <div className="space-y-1">
        <h2 className="text-lg font-bold text-navy [text-wrap:balance]">Please check and confirm</h2>
        <p className="text-sm text-muted">This is the appointment we&apos;ll book for you.</p>
      </div>

      {/* The exact slot read back, large and unmissable. */}
      <div className="rounded-xl border border-blue-dark/20 bg-blue-dark/[0.06] px-4 py-3.5">
        <p className="text-base font-bold text-navy">
          {longDateFmt.format(new Date(chosen.start))}
        </p>
        <p className="text-base font-bold text-blue-deep">{timeLabel(chosen.start)}</p>
        <p className="mt-1 text-xs text-muted">at {siteName}</p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">Name</dt>
        <dd className="font-semibold text-navy">
          {firstName} {lastName}
        </dd>
        <dt className="text-muted">Mobile</dt>
        <dd className="font-semibold text-navy">{phone}</dd>
      </dl>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]"
        >
          {error}
        </p>
      ) : null}

      <Button type="button" variant="primary" className="w-full" onClick={onConfirm} disabled={busy}>
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        Confirm booking
      </Button>
      <Button type="button" variant="secondary" className="w-full" onClick={onBack} disabled={busy}>
        Go back
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Success screen
 * ------------------------------------------------------------------------- */

function SuccessScreen({
  animKey,
  startIso,
  siteName,
}: {
  animKey: number;
  startIso: string;
  siteName: string;
}) {
  return (
    <div
      key={animKey}
      className="flex flex-col items-center gap-4 py-6 text-center motion-safe:[animation:bookEnter_240ms_ease-out]"
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={28} />
      </span>
      <div className="space-y-1">
        <h1 className="text-2xl text-navy">You&apos;re booked</h1>
        <p className="text-sm font-semibold text-navy">
          {longDateFmt.format(new Date(startIso))} at {timeLabel(startIso)}
        </p>
        <p className="text-sm text-muted">{siteName}</p>
      </div>
      <p className="max-w-sm text-sm text-muted">
        A confirmation may follow by text message. If you need to change or cancel this
        appointment, please call the practice and the team will sort it for you.
      </p>
    </div>
  );
}

// Opacity + small translateY only (no layout-property animation). Gated behind
// motion-safe: at the call site so prefers-reduced-motion users get no movement.
const ENTER_KEYFRAMES = `@keyframes bookEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
