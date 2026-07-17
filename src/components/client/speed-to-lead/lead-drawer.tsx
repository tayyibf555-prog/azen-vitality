"use client";

import { useState } from "react";
import { X, Loader2, Check, CalendarCheck, XCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type { Lead, LeadStage } from "@/lib/types";

const STAGE_TONE: Record<LeadStage, Tone> = {
  new: "info",
  contacting: "info", // transient in-flight claim; display like 'new'
  contacted: "success",
  qualifying: "info",
  booked: "success",
  nurture_done: "neutral", // full nurture ran, no reply
  lost: "neutral",
};
const STAGE_LABEL: Record<LeadStage, string> = {
  new: "New",
  contacting: "New", // transient; reads as still-new to staff
  contacted: "Contacted",
  qualifying: "Qualifying",
  booked: "Booked",
  nurture_done: "Nurtured",
  lost: "Lost",
};
const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
};

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

function slaLabel(seconds: number | null): { tone: Tone; text: string } {
  if (seconds === null) return { tone: "danger", text: "Not yet contacted" };
  const t = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const tone: Tone = seconds <= 30 ? "success" : seconds <= 120 ? "warning" : "danger";
  return { tone, text: `First contact in ${t}` };
}

export function LeadDrawer({
  lead,
  onClose,
}: {
  lead: Lead;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const [stage, setStage] = useState<LeadStage>(lead.stage);
  const [busy, setBusy] = useState<"mark-booked" | "mark-lost" | "resend" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function action(path: "mark-booked" | "mark-lost" | "resend") {
    setBusy(path);
    setError(null);
    try {
      const res = await fetch(`/api/speed-to-lead/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: lead.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (path === "mark-booked") {
        setStage("booked");
        setNote("Marked as booked.");
      } else if (path === "mark-lost") {
        setStage("lost");
        setNote("Marked as lost.");
      } else {
        setNote("First contact resent.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete that action.");
    } finally {
      setBusy(null);
    }
  }

  const sla = slaLabel(lead.firstResponseSeconds);
  const resolved = stage === "booked" || stage === "lost";

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{lead.name}</h2>
            <p className="mt-0.5 text-sm text-muted">Enquired {whenLabel(lead.createdAt)}</p>
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
            <StatusPill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</StatusPill>
            <StatusPill tone={sla.tone}>{sla.text}</StatusPill>
            <StatusPill tone="neutral">{CHANNEL_LABEL[lead.channel] ?? lead.channel}</StatusPill>
            {lead.assessmentScore !== null ? (
              <StatusPill tone="info">Score {lead.assessmentScore}</StatusPill>
            ) : null}
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Enquiry</h3>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted">Interest</dt>
              <dd className="text-ink">{lead.treatmentInterest || "General enquiry"}</dd>
              <dt className="text-muted">Source</dt>
              <dd className="text-ink capitalize">{lead.source}</dd>
              <dt className="text-muted">Channel</dt>
              <dd className="text-ink">{CHANNEL_LABEL[lead.channel] ?? lead.channel}</dd>
            </dl>
          </section>

          {note ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
              <Check size={15} />
              {note}
            </div>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">{error}</p>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-navy">Actions</h3>
            {!resolved ? (
              <div className="flex gap-2">
                <Button onClick={() => action("mark-booked")} variant="primary" className="flex-1" disabled={busy !== null}>
                  {busy === "mark-booked" ? <Loader2 size={15} className="animate-spin" /> : <CalendarCheck size={15} />}
                  Mark booked
                </Button>
                <Button onClick={() => action("mark-lost")} variant="secondary" className="flex-1" disabled={busy !== null}>
                  {busy === "mark-lost" ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                  Mark lost
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted">This enquiry is {STAGE_LABEL[stage].toLowerCase()}.</p>
            )}
            <Button onClick={() => action("resend")} variant="secondary" className="w-full" disabled={busy !== null}>
              {busy === "resend" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Resend first contact
            </Button>
            <p className="text-xs text-muted">
              Resending re-drafts and sends a fresh first message, then threads the reply to the booking agent.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
