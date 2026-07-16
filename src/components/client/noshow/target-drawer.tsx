"use client";

import { useState } from "react";
import { X, CalendarPlus, Loader2, Check, ShieldCheck, XCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type { NoshowTarget, RiskBand } from "@/lib/noshow/types";

const RISK_TONE: Record<RiskBand, Tone> = { high: "warning", medium: "info", low: "neutral" };
const RISK_LABEL: Record<RiskBand, string> = { high: "High risk", medium: "Medium risk", low: "Low risk" };

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

function riskReason(t: NoshowTarget): string {
  if (t.riskBand === "high") return "High no-show risk based on attendance history and booking pattern. Worth a personal nudge.";
  if (t.riskBand === "medium") return "Some no-show risk. The automated confirmations should be enough.";
  return "Low no-show risk. Reliable attendance history.";
}

export function TargetDrawer({
  target,
  nowIso,
  onClose,
}: {
  target: NoshowTarget;
  nowIso: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const [status, setStatus] = useState(target.status);
  const [busy, setBusy] = useState<"confirm" | "cancel" | "book" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBook, setShowBook] = useState(false);
  const [start, setStart] = useState("");

  async function action(path: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/noshow/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; offeredTo?: string | null };
    if (res.status === 503) throw new Error("Dentally is not connected yet.");
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      await action("confirm", { targetId: target.id });
      setStatus("confirmed");
      setNote("Marked as confirmed. Reminders stopped.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      const data = await action("cancel", { targetId: target.id });
      setStatus("cancelled");
      setNote(
        data.offeredTo
          ? "Cancelled and the slot was offered to the next waitlist patient."
          : "Cancelled. No matching waitlist patient to offer the slot to.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel.");
    } finally {
      setBusy(null);
    }
  }

  async function rebook() {
    if (!start) return;
    setBusy("book");
    setError(null);
    try {
      await action("book", {
        targetId: target.id,
        patient_id: target.dentallyPatientId,
        site_id: target.siteId,
        start: new Date(start).toISOString(),
        start_time: new Date(start).toISOString(),
        duration: target.durationMin || 30,
        ...(target.practitioner ? { practitioner: target.practitioner } : {}),
      });
      setStatus("confirmed");
      setShowBook(false);
      setNote(`Rebooked for ${new Date(start).toLocaleString("en-GB", { timeZone: "Europe/London" })}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rebook.");
    } finally {
      setBusy(null);
    }
  }

  const resolved = status === "confirmed" || status === "cancelled";

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{target.patientName}</h2>
            <p className="mt-0.5 text-sm text-muted">{whenLabel(target.appointmentStartAt)}</p>
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
            <StatusPill tone={RISK_TONE[target.riskBand]}>{RISK_LABEL[target.riskBand]} · {target.riskScore}</StatusPill>
            <StatusPill tone={status === "confirmed" ? "success" : status === "cancelled" ? "neutral" : "info"}>
              {status === "confirmed" ? "Confirmed" : status === "cancelled" ? "Cancelled" : "Awaiting confirmation"}
            </StatusPill>
            {target.priorAttempts > 0 ? <StatusPill tone="neutral">{target.priorAttempts} reminders sent</StatusPill> : null}
            {target.practitioner ? <StatusPill tone="neutral">{target.practitioner}</StatusPill> : null}
          </div>

          <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why this score</p>
            <p className="mt-0.5 text-sm text-ink">{riskReason(target)}</p>
          </div>

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
                <Button onClick={confirm} variant="primary" className="flex-1" disabled={busy !== null}>
                  {busy === "confirm" ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                  Mark confirmed
                </Button>
                <Button onClick={cancel} variant="secondary" className="flex-1" disabled={busy !== null}>
                  {busy === "cancel" ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                  Cancel + free slot
                </Button>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Users size={13} /> Cancelling offers the freed slot to the next matching waitlist patient.
              </p>
            </section>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">{status === "cancelled" ? "Rebook" : "Move appointment"}</h3>
            {!showBook ? (
              <Button onClick={() => setShowBook(true)} variant="secondary" className="w-full" disabled={busy !== null}>
                <CalendarPlus size={15} />
                {status === "cancelled" ? "Rebook this patient" : "Book a new time"}
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border border-line bg-card-muted/40 p-3">
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted">New appointment start</label>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                />
                <div className="flex gap-2">
                  <Button onClick={() => setShowBook(false)} variant="ghost" className="flex-1" disabled={busy === "book"}>
                    Cancel
                  </Button>
                  <Button onClick={rebook} variant="primary" className="flex-1" disabled={busy === "book" || !start}>
                    {busy === "book" ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
                    Confirm
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
