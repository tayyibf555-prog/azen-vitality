"use client";

import { useState } from "react";
import { MessageSquare, Mail, Sparkles, Check, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { TouchChannel, TreatmentOpportunity } from "@/lib/coordinator/types";

interface DraftResponse {
  touch?: { id: string; status: string };
  rationale?: string;
  autoQueued?: boolean;
  consentBlocked?: boolean;
  error?: string;
}

type Phase = "idle" | "drafting" | "drafted" | "approving" | "approved" | "sending" | "sent";

const CHANNELS: { value: TouchChannel; label: string; icon: typeof MessageSquare }[] = [
  { value: "sms", label: "SMS", icon: MessageSquare },
  { value: "email", label: "Email", icon: Mail },
  { value: "whatsapp", label: "WhatsApp", icon: MessageSquare },
];

export interface DraftSent {
  channel: TouchChannel;
  body: string;
}

export function DraftEditor({
  opportunity,
  onSent,
}: {
  opportunity: TreatmentOpportunity;
  /** Called once a touch has been sent, so the drawer can log it. */
  onSent: (touch: DraftSent) => void;
}) {
  const [channel, setChannel] = useState<TouchChannel>("sms");
  const [phase, setPhase] = useState<Phase>("idle");
  const [body, setBody] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);
  const [autoQueued, setAutoQueued] = useState(false);
  const [consentBlocked, setConsentBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "drafting" || phase === "approving" || phase === "sending";

  async function post(action: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/coordinator/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as DraftResponse & { ok?: boolean };
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function generate() {
    setError(null);
    setPhase("drafting");
    setRationale(null);
    setAutoQueued(false);
    setConsentBlocked(false);
    try {
      const data = await post("draft", { opportunityId: opportunity.id, channel });
      // The route returns the persisted touch, whose body is the Claude draft.
      const draftBody = (data as { touch?: { body?: string } }).touch?.body ?? "";
      setBody(draftBody);
      setRationale(data.rationale ?? null);
      setTouchId(data.touch?.id ?? null);
      setAutoQueued(Boolean(data.autoQueued));
      setConsentBlocked(Boolean(data.consentBlocked));
      setPhase(data.autoQueued ? "approved" : "drafted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the draft.");
      setPhase("idle");
    }
  }

  async function approve() {
    if (!touchId) return;
    setError(null);
    setPhase("approving");
    try {
      await post("approve", { touchId, opportunityId: opportunity.id, channel });
      setPhase("approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve the draft.");
      setPhase("drafted");
    }
  }

  async function send() {
    if (!touchId) return;
    setError(null);
    setPhase("sending");
    try {
      await post("send", { touchId, opportunityId: opportunity.id });
      setPhase("sent");
      onSent({ channel, body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message.");
      setPhase("approved");
    }
  }

  async function approveAndSend() {
    if (!touchId) return;
    setError(null);
    setPhase("approving");
    try {
      if (phase !== "approved") {
        await post("approve", { touchId, opportunityId: opportunity.id, channel });
      }
      setPhase("sending");
      await post("send", { touchId, opportunityId: opportunity.id });
      setPhase("sent");
      onSent({ channel, body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve and send.");
      setPhase("drafted");
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Channel</p>
        <div className="flex gap-2">
          {CHANNELS.map((c) => {
            const Icon = c.icon;
            const active = channel === c.value;
            return (
              <button
                key={c.value}
                type="button"
                disabled={phase === "sent"}
                onClick={() => setChannel(c.value)}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
                  active
                    ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
                    : "border-line-strong bg-card text-muted hover:bg-card-muted",
                )}
              >
                <Icon size={14} />
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {phase === "idle" ? (
        <Button onClick={generate} className="w-full" variant="primary">
          <Sparkles size={15} />
          Generate draft
        </Button>
      ) : null}

      {phase === "drafting" ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-line bg-card-muted py-6 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Drafting with Claude
        </div>
      ) : null}

      {body || rationale ? (
        <div className="space-y-3">
          {rationale ? (
            <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why now</p>
              <p className="mt-0.5 text-sm text-ink">{rationale}</p>
            </div>
          ) : null}

          {consentBlocked ? (
            <StatusPill tone="warning">No marketing consent for this channel</StatusPill>
          ) : null}
          {autoQueued ? (
            <StatusPill tone="info">Auto queued, low value plan</StatusPill>
          ) : null}

          {body ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                Draft message
              </p>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={phase === "sending" || phase === "sent"}
                rows={6}
                className="w-full resize-y rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-60"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {phase === "sent" ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-success/20 bg-success/10 py-3 text-sm font-semibold text-success">
          <Check size={16} />
          Sent
        </div>
      ) : null}

      {(phase === "drafted" || phase === "approving" || phase === "approved" || phase === "sending") &&
      touchId ? (
        <div className="flex gap-2">
          <Button
            onClick={approve}
            disabled={busy || phase === "approved"}
            variant="secondary"
            className="flex-1"
          >
            {phase === "approving" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {phase === "approved" ? "Approved" : "Approve"}
          </Button>
          {phase === "approved" || phase === "sending" ? (
            <Button onClick={send} disabled={busy} variant="primary" className="flex-1">
              {phase === "sending" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Send
            </Button>
          ) : (
            <Button onClick={approveAndSend} disabled={busy} variant="primary" className="flex-1">
              <Send size={15} />
              Approve and send
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
