"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSite } from "@/lib/mock/clients";
import { SLOT_DURATION_LABEL } from "@/lib/booking/manual-slot-payload";
import type { BookingSlot } from "@/lib/booking/slots";

// ---------------------------------------------------------------------------
// Live slot picker for the internal "Book appointment" drawers (recall,
// reactivation, treatment coordinator).
//
// It replaces a free-text datetime field that could never produce a bookable
// request: Dentally needs an end time and a clinician, and only real
// availability carries those. Times come from GET /api/booking/slots, the same
// read the public booking calendar uses (fetchAvailabilityDays under the hood),
// so a coordinator can only ever pick a slot the diary actually has.
//
// Everything is shown in Europe/London, matching the practice diary, whatever
// the device timezone says.
// ---------------------------------------------------------------------------

const DAYS_PER_REQUEST = 14; // the slots endpoint clamps a request to 14 days

interface BookingDayView {
  date: string;
  slots: BookingSlot[];
}

const TZ = "Europe/London";
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayChipFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

/** Today in Europe/London as YYYY-MM-DD. */
function londonToday(): string {
  return dayKeyFmt.format(new Date());
}

/** Pure calendar arithmetic on a YYYY-MM-DD string. */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Noon UTC is always inside the same London day, so date parts are safe. */
function dayLabel(dayKey: string): string {
  return dayChipFmt.format(new Date(`${dayKey}T12:00:00Z`));
}

/** "9:30am" in London time (the formatter gives "9:30 am"; drop the space). */
export function slotTimeLabel(iso: string): string {
  return timeFmt.format(new Date(iso)).replace(/[\s\u202f\u00a0]/g, "");
}

/** "Mon 3 Aug, 9:30am" in London time, for confirmations and the activity log. */
export function slotFullLabel(iso: string): string {
  return `${dayLabel(dayKeyFmt.format(new Date(iso)))}, ${slotTimeLabel(iso)}`;
}

/** Selection identity: a slot is its start, its end and its clinician. */
function slotKey(slot: BookingSlot): string {
  return `${slot.start}|${slot.finish}|${slot.practitionerId ?? ""}`;
}

export function SlotPicker({
  siteId,
  selected,
  onSelect,
  disabled = false,
}: {
  siteId: string;
  selected: BookingSlot | null;
  onSelect: (slot: BookingSlot | null) => void;
  disabled?: boolean;
}) {
  const [days, setDays] = useState<BookingDayView[]>([]);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again"; re-runs the read without duplicating the fetch logic.
  const [reloads, setReloads] = useState(0);

  /** One availability read. The server's own message is kept, it is written to be
   *  read by a person and says whether it is worth retrying. */
  const fetchDays = useCallback(async (): Promise<{ days: BookingDayView[] } | { error: string }> => {
    const failed = { error: "We could not load available times right now. Please try again shortly." };
    try {
      // The site must be asked for under its own client, exactly as the public
      // calendar does; an unknown site is a 404 there rather than a leak.
      const clientId = getSite(siteId)?.clientId ?? "";
      const from = londonToday();
      const params = new URLSearchParams({
        client: clientId,
        site: siteId,
        from,
        to: addDays(from, DAYS_PER_REQUEST - 1),
      });
      const res = await fetch(`/api/booking/slots?${params.toString()}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; days?: BookingDayView[]; error?: string };
      if (!res.ok || !data.ok) return data.error ? { error: data.error } : failed;
      return { days: (data.days ?? []).filter((d) => d.slots.length > 0) };
    } catch {
      return failed;
    }
  }, [siteId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const got = await fetchDays();
      if (cancelled) return;
      if ("error" in got) {
        setDays([]);
        setActiveDay(null);
        setError(got.error);
      } else {
        setDays(got.days);
        setActiveDay(got.days[0]?.date ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchDays, reloads]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-card-muted/40 px-3 py-4 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" />
        Loading available times
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5">
        <p className="flex items-center gap-2 text-sm text-[#9a6700]">
          <AlertCircle size={15} />
          {error}
        </p>
        <button
          type="button"
          onClick={() => setReloads((n) => n + 1)}
          className="text-sm font-semibold text-blue-dark underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-4 text-center text-sm text-muted">
        No free appointments in the next {DAYS_PER_REQUEST} days. Book this one in the diary directly.
      </p>
    );
  }

  const daySlots = days.find((d) => d.date === activeDay)?.slots ?? [];

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Day</p>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d) => (
            <button
              key={d.date}
              type="button"
              disabled={disabled}
              onClick={() => {
                setActiveDay(d.date);
                onSelect(null);
              }}
              className={cn(
                "shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
                d.date === activeDay
                  ? "border-blue-royal bg-blue-royal text-white"
                  : "border-line-strong bg-card text-navy hover:bg-card-muted",
              )}
            >
              {dayLabel(d.date)}
              <span className={cn("ml-1.5 font-normal", d.date === activeDay ? "text-white/80" : "text-muted")}>
                {d.slots.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          Time <span className="font-normal normal-case tracking-normal">({SLOT_DURATION_LABEL})</span>
        </p>
        <div className="grid max-h-44 grid-cols-3 gap-1.5 overflow-y-auto">
          {daySlots.map((slot) => {
            const active = selected !== null && slotKey(selected) === slotKey(slot);
            return (
              <button
                key={slotKey(slot)}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(slot)}
                className={cn(
                  "rounded-lg border px-2 py-1.5 text-xs font-semibold tabular-nums transition-colors disabled:opacity-50",
                  active
                    ? "border-blue-royal bg-blue-royal text-white"
                    : "border-line-strong bg-card text-navy hover:bg-card-muted",
                )}
              >
                {slotTimeLabel(slot.start)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
