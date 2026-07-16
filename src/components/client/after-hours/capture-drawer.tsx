"use client";

import { useState } from "react";
import { X, Loader2, Check, PhoneForwarded, CalendarCheck, Archive, Phone, MessageSquare, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type { AfterHoursCapture, CaptureChannel, CaptureStatus } from "@/lib/after-hours/types";

const STATUS_TONE: Record<CaptureStatus, Tone> = {
  new: "info",
  followed_up: "warning",
  booked: "success",
  closed: "neutral",
};
const STATUS_LABEL: Record<CaptureStatus, string> = {
  new: "New",
  followed_up: "Followed up",
  booked: "Booked",
  closed: "Closed",
};
const CHANNEL_LABEL: Record<CaptureChannel, string> = {
  call: "Missed call",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

function ChannelIcon({ channel }: { channel: CaptureChannel }) {
  if (channel === "call") return <Phone size={13} />;
  if (channel === "whatsapp") return <MessageCircle size={13} />;
  return <MessageSquare size={13} />;
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Busy = "followed-up" | "booked" | "close" | null;

export function CaptureDrawer({
  capture,
  nowIso,
  onClose,
}: {
  capture: AfterHoursCapture;
  nowIso: string;
  onClose: () => void;
}) {
  void nowIso;
  useEscapeKey(onClose);
  const [status, setStatus] = useState<CaptureStatus>(capture.status);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function action(path: string): Promise<void> {
    const res = await fetch(`/api/after-hours/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captureId: capture.id }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  }

  async function run(path: string, busyKey: Exclude<Busy, null>, next: CaptureStatus, message: string) {
    setBusy(busyKey);
    setError(null);
    try {
      await action(path);
      setStatus(next);
      setNote(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this capture.");
    } finally {
      setBusy(null);
    }
  }

  const resolved = status === "booked" || status === "closed";

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{capture.patientName}</h2>
            <p className="mt-0.5 text-sm text-muted">{whenLabel(capture.capturedAt)}</p>
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
            <StatusPill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusPill>
            <StatusPill tone="neutral">
              <ChannelIcon channel={capture.channel} /> {CHANNEL_LABEL[capture.channel]}
            </StatusPill>
            {capture.followUpSent ? <StatusPill tone="success">Auto follow-up sent</StatusPill> : null}
          </div>

          <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">From</p>
            <p className="mt-0.5 font-semibold tabular-nums text-navy">{capture.fromNumber}</p>
          </div>

          {capture.body ? (
            <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Message</p>
              <p className="mt-0.5 text-sm text-ink">{capture.body}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Missed call</p>
              <p className="mt-0.5 text-sm text-ink">
                {capture.followUpSent
                  ? "We sent a text inviting them to book by reply. Follow up if they have not replied."
                  : "No text was sent automatically. Call or text the patient to follow up."}
              </p>
            </div>
          )}

          {note ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
              <Check size={15} />
              {note}
            </div>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">{error}</p>
          ) : null}

          {!resolved ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-navy">Actions</h3>
              <div className="flex gap-2">
                <Button
                  onClick={() => run("mark-followed-up", "followed-up", "followed_up", "Marked as followed up.")}
                  variant="secondary"
                  className="flex-1"
                  disabled={busy !== null || status === "followed_up"}
                >
                  {busy === "followed-up" ? <Loader2 size={15} className="animate-spin" /> : <PhoneForwarded size={15} />}
                  Mark followed up
                </Button>
                <Button
                  onClick={() => run("mark-booked", "booked", "booked", "Marked as booked.")}
                  variant="primary"
                  className="flex-1"
                  disabled={busy !== null}
                >
                  {busy === "booked" ? <Loader2 size={15} className="animate-spin" /> : <CalendarCheck size={15} />}
                  Mark booked
                </Button>
              </div>
              <Button
                onClick={() => run("close", "close", "closed", "Capture closed.")}
                variant="ghost"
                className="w-full"
                disabled={busy !== null}
              >
                {busy === "close" ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />}
                Close
              </Button>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
