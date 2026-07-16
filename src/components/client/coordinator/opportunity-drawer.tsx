"use client";

import { useState } from "react";
import {
  X,
  CalendarPlus,
  Loader2,
  Check,
  MessageSquare,
  Mail,
  CalendarClock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { gbp, relativeTime } from "@/lib/utils";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type {
  OpportunityStatus,
  TouchChannel,
  TreatmentOpportunity,
} from "@/lib/coordinator/types";
import { DraftEditor, type DraftSent } from "./draft-editor";

const DAY = 86_400_000;

const STATUS_TONE: Record<OpportunityStatus, Tone> = {
  stalled: "warning",
  accepted: "info",
  in_progress: "neutral",
  completed: "success",
};

const STATUS_LABEL: Record<OpportunityStatus, string> = {
  stalled: "Stalled",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
};

const CHANNEL_LABEL: Record<TouchChannel, string> = {
  sms: "SMS",
  email: "Email",
  whatsapp: "WhatsApp",
};

interface SessionTouch {
  id: string;
  kind: "message" | "booking";
  channel?: TouchChannel;
  body: string;
  at: string;
}

function daysStalled(acceptedAt: string, now: Date): number {
  if (!acceptedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(acceptedAt).getTime()) / DAY));
}

function whyNow(o: TreatmentOpportunity): string {
  const finance = o.financePresented ? "finance already presented" : "finance not yet presented";
  return `${gbp(o.amountOutstanding)} outstanding on ${o.treatment}, ${finance}.`;
}

export function OpportunityDrawer({
  opportunity,
  nowIso,
  onClose,
}: {
  opportunity: TreatmentOpportunity;
  nowIso: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const now = new Date(nowIso);
  const [touches, setTouches] = useState<SessionTouch[]>([]);

  // Booking state.
  const [showBook, setShowBook] = useState(false);
  const [start, setStart] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookOk, setBookOk] = useState(false);

  function logSent(touch: DraftSent) {
    setTouches((prev) => [
      ...prev,
      {
        id: `t-${prev.length}`,
        kind: "message",
        channel: touch.channel,
        body: touch.body,
        at: new Date().toISOString(),
      },
    ]);
  }

  async function book() {
    if (!start) return;
    setBookError(null);
    setBooking(true);
    try {
      const res = await fetch("/api/coordinator/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId: opportunity.id, start: new Date(start).toISOString() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 503) {
        setBookError("Dentally is not connected yet. The booking was not made.");
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || `Booking failed (${res.status})`);
      }
      setBookOk(true);
      setShowBook(false);
      setTouches((prev) => [
        ...prev,
        {
          id: `b-${prev.length}`,
          kind: "booking",
          body: `Next step booked for ${new Date(start).toLocaleString("en-GB")}`,
          at: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setBookError(err instanceof Error ? err.message : "Could not book the next step.");
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]"
      />

      {/* Panel */}
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{opportunity.patientName}</h2>
            <p className="mt-0.5 text-sm text-muted">{opportunity.treatment}</p>
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
          {/* Snapshot */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line bg-card-muted/60 px-3 py-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Planned</p>
              <p className="mt-0.5 text-lg font-bold text-navy tabular-nums">
                {gbp(opportunity.plannedValue)}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-card-muted/60 px-3 py-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Outstanding</p>
              <p className="mt-0.5 text-lg font-bold text-navy tabular-nums">
                {gbp(opportunity.amountOutstanding)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={STATUS_TONE[opportunity.status]}>
              {STATUS_LABEL[opportunity.status]}
            </StatusPill>
            <StatusPill tone="neutral">
              {daysStalled(opportunity.acceptedAt, now)} days stalled
            </StatusPill>
            <StatusPill tone={opportunity.financePresented ? "success" : "warning"}>
              {opportunity.financePresented ? "Finance presented" : "Finance not presented"}
            </StatusPill>
          </div>

          <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why now</p>
            <p className="mt-0.5 text-sm text-ink">{whyNow(opportunity)}</p>
          </div>

          {/* Draft and approve */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Outreach</h3>
            <DraftEditor opportunity={opportunity} onSent={logSent} />
          </section>

          {/* Book next step */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Next step</h3>
            {!showBook ? (
              <Button onClick={() => setShowBook(true)} variant="secondary" className="w-full">
                <CalendarPlus size={15} />
                Book next step
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border border-line bg-card-muted/40 p-3">
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                  Appointment start
                </label>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => setShowBook(false)}
                    variant="ghost"
                    className="flex-1"
                    disabled={booking}
                  >
                    Cancel
                  </Button>
                  <Button onClick={book} variant="primary" className="flex-1" disabled={booking || !start}>
                    {booking ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
                    Confirm
                  </Button>
                </div>
              </div>
            )}
            {bookOk ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
                <Check size={15} />
                Next step booked
              </div>
            ) : null}
            {bookError ? (
              <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">
                {bookError}
              </p>
            ) : null}
          </section>

          {/* Touch history (this session) */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Activity</h3>
            {touches.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-4 text-center text-sm text-muted">
                No activity in this session yet. Sent messages and bookings will appear here.
              </p>
            ) : (
              <ol className="space-y-3">
                {touches.map((t) => {
                  const Icon =
                    t.kind === "booking"
                      ? CalendarClock
                      : t.channel === "email"
                        ? Mail
                        : MessageSquare;
                  return (
                    <li key={t.id} className="flex gap-3">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-navy">
                          {t.kind === "booking"
                            ? "Booking"
                            : `${t.channel ? CHANNEL_LABEL[t.channel] : "Message"} sent`}
                          <span className="ml-2 font-normal text-muted">
                            {relativeTime(t.at, now)}
                          </span>
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
