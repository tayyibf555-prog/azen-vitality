"use client";

import { useState } from "react";
import { X, CalendarPlus, Loader2, Check, Pause, Play, MessageSquare, Mail, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { gbp, relativeTime } from "@/lib/utils";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import { SlotPicker, slotFullLabel } from "@/components/client/booking/slot-picker";
import { manualBookingFieldsFromSlot } from "@/lib/booking/manual-slot-payload";
import type { BookingSlot } from "@/lib/booking/slots";
import type { ReactivationCadence, ReactivationReason, ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";
import { CadenceTimeline } from "./cadence-timeline";
import { DraftEditor, type DraftSent } from "./draft-editor";

const REASON_TONE: Record<ReactivationReason, Tone> = {
  lapsed: "neutral",
  overdue_recall: "warning",
  stalled_plan: "info",
};
const REASON_LABEL: Record<ReactivationReason, string> = {
  lapsed: "Lapsed",
  overdue_recall: "Overdue recall",
  stalled_plan: "Stalled plan",
};
const CHANNEL_LABEL: Record<TouchChannel, string> = { sms: "SMS", email: "Email", whatsapp: "WhatsApp" };

interface SessionTouch {
  id: string;
  kind: "message" | "booking";
  channel?: TouchChannel;
  body: string;
  at: string;
}

function whyNow(t: ReactivationTarget): string {
  switch (t.reason) {
    case "stalled_plan":
      return `${gbp(t.recoverableValue)} outstanding on ${t.treatment ?? "treatment"}. Re-present finance.`;
    case "overdue_recall":
      return `Recall overdue since ${t.recallDueAt ? new Date(t.recallDueAt).toLocaleDateString("en-GB", { timeZone: "Europe/London" }) : "unknown"}. Book it in.`;
    case "lapsed":
      return `Last visit ${t.lastVisitAt ? new Date(t.lastVisitAt).toLocaleDateString("en-GB", { timeZone: "Europe/London" }) : "unknown"}. Invite back for a checkup.`;
  }
}

export function TargetDrawer({
  target,
  cadence,
  nowIso,
  onClose,
}: {
  target: ReactivationTarget;
  cadence: ReactivationCadence | null;
  nowIso: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const now = new Date(nowIso);
  const [touches, setTouches] = useState<SessionTouch[]>([]);
  const [paused, setPaused] = useState(cadence?.status === "paused");
  const [pausing, setPausing] = useState(false);
  const [showBook, setShowBook] = useState(false);
  // The picked live availability slot. Dentally refuses a booking without an end
  // time and a clinician, and only a real slot carries those, so the booking is
  // driven by a selection out of the diary rather than a typed-in time.
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookOk, setBookOk] = useState(false);

  function logSent(touch: DraftSent) {
    setTouches((prev) => [
      ...prev,
      { id: `t-${prev.length}`, kind: "message", channel: touch.channel, body: touch.body, at: new Date().toISOString() },
    ]);
  }

  async function action(path: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/reactivation/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 503) throw new Error("Dentally is not connected yet.");
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function togglePause() {
    setPausing(true);
    try {
      await action(paused ? "resume" : "pause", { targetId: target.id });
      setPaused(!paused);
    } catch {
      // surfaced inline elsewhere; keep the toggle state unchanged on failure
    } finally {
      setPausing(false);
    }
  }

  async function book() {
    const built = manualBookingFieldsFromSlot(slot);
    if ("error" in built) {
      setBookError(built.error);
      return;
    }
    setBookError(null);
    setBooking(true);
    try {
      await action("book", { targetId: target.id, ...built.fields });
      setBookOk(true);
      setShowBook(false);
      setTouches((prev) => [
        ...prev,
        { id: `b-${prev.length}`, kind: "booking", body: `Re-engagement booked for ${slotFullLabel(built.fields.start)}`, at: new Date().toISOString() },
      ]);
    } catch (err) {
      setBookError(err instanceof Error ? err.message : "Could not book the appointment.");
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{target.patientName}</h2>
            <p className="mt-0.5 text-sm text-muted">{REASON_LABEL[target.reason]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-6 px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={REASON_TONE[target.reason]}>{REASON_LABEL[target.reason]}</StatusPill>
            <StatusPill tone="neutral">{gbp(target.recoverableValue)} recoverable</StatusPill>
            {target.priorAttempts > 0 ? (
              <StatusPill tone="neutral">{target.priorAttempts} prior attempts</StatusPill>
            ) : null}
          </div>

          <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why now</p>
            <p className="mt-0.5 text-sm text-ink">{whyNow(target)}</p>
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-navy">Cadence</h3>
              {cadence ? (
                <Button onClick={togglePause} variant="ghost" size="sm" disabled={pausing}>
                  {pausing ? <Loader2 size={14} className="animate-spin" /> : paused ? <Play size={14} /> : <Pause size={14} />}
                  {paused ? "Resume" : "Pause"}
                </Button>
              ) : null}
            </div>
            <CadenceTimeline cadence={cadence} nowIso={nowIso} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Outreach</h3>
            <DraftEditor target={target} onSent={logSent} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Book re-engagement</h3>
            {!showBook ? (
              <Button onClick={() => setShowBook(true)} variant="secondary" className="w-full">
                <CalendarPlus size={15} />
                Book appointment
              </Button>
            ) : (
              <div className="space-y-3 rounded-lg border border-line bg-card-muted/40 p-3">
                <SlotPicker siteId={target.siteId} selected={slot} onSelect={setSlot} disabled={booking} />
                {slot ? (
                  <p className="text-sm text-ink">
                    Booking <span className="font-semibold text-navy">{slotFullLabel(slot.start)}</span>
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setShowBook(false);
                      setSlot(null);
                    }}
                    variant="ghost"
                    className="flex-1"
                    disabled={booking}
                  >
                    Cancel
                  </Button>
                  <Button onClick={book} variant="primary" className="flex-1" disabled={booking || !slot}>
                    {booking ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
                    Confirm
                  </Button>
                </div>
              </div>
            )}
            {bookOk ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
                <Check size={15} />
                Re-engagement booked
              </div>
            ) : null}
            {bookError ? (
              <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">{bookError}</p>
            ) : null}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Activity</h3>
            {touches.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-4 text-center text-sm text-muted">
                No activity in this session yet. Sent messages and bookings will appear here.
              </p>
            ) : (
              <ol className="space-y-3">
                {touches.map((t) => {
                  const Icon = t.kind === "booking" ? CalendarClock : t.channel === "email" ? Mail : MessageSquare;
                  return (
                    <li key={t.id} className="flex gap-3">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-navy">
                          {t.kind === "booking" ? "Booking" : `${t.channel ? CHANNEL_LABEL[t.channel] : "Message"} sent`}
                          <span className="ml-2 font-normal text-muted">{relativeTime(t.at, now)}</span>
                        </p>
                        <p className="mt-0.5 line-clamp-3 text-sm text-ink">{t.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
