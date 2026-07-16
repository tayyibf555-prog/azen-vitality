"use client";

import { useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  MessageCircle,
  Mail,
  PhoneMissed,
  Send,
  Loader2,
  ArrowLeft,
  Inbox as InboxIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/primitives";
import { snippet } from "@/lib/inbox/normalise";
import type { InboxChannel, InboxMessage, Thread } from "@/lib/inbox/types";

const CHANNEL_ICON: Record<InboxChannel, LucideIcon> = {
  sms: MessageSquare,
  whatsapp: MessageCircle,
  email: Mail,
  "after-hours": PhoneMissed,
};

const CHANNEL_LABEL: Record<InboxChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
  "after-hours": "After-hours",
};

function ChannelIcon({ channel, className }: { channel: InboxChannel; className?: string }) {
  const Icon = CHANNEL_ICON[channel];
  return <Icon size={14} className={className} aria-hidden />;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface SendState {
  kind: "sent" | "blocked" | "error";
  text: string;
}

export function InboxWorkspace({
  clientSlug,
  initialThreads,
}: {
  clientSlug: string;
  initialThreads: Thread[];
}) {
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [activeRef, setActiveRef] = useState<string | null>(initialThreads[0]?.contactRef ?? null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SendState | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => threads.find((t) => t.contactRef === activeRef) ?? null,
    [threads, activeRef],
  );

  function openThread(ref: string) {
    setActiveRef(ref);
    setFeedback(null);
    setDraft("");
    // Clear the unread flag locally once the thread is opened.
    setThreads((prev) =>
      prev.map((t) => (t.contactRef === ref ? { ...t, unread: false } : t)),
    );
  }

  async function sendReply() {
    const text = draft.trim();
    if (!text || !active || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/inbox/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          contactRef: active.contactRef,
          channel: active.channel,
          body: text,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        sent?: boolean;
        dryRun?: boolean;
        reason?: string;
        message?: string;
        at?: string;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        setFeedback({ kind: "error", text: data.error ?? "Could not send, please try again." });
        return;
      }
      if (!data.sent) {
        setFeedback({ kind: "blocked", text: data.message ?? "Nothing was sent." });
        return;
      }

      // Append the sent message to the active thread so it shows immediately.
      const at = data.at ?? new Date().toISOString();
      const appended: InboxMessage = {
        id: `local:${at}`,
        contactRef: active.contactRef,
        contactName: active.contactName,
        channel: active.channel,
        direction: "outbound",
        body: text,
        at,
        source: "human",
      };
      setThreads((prev) =>
        prev
          .map((t) =>
            t.contactRef === active.contactRef
              ? {
                  ...t,
                  messages: [...t.messages, appended],
                  lastAt: at,
                  lastSnippet: snippet(text),
                  unread: false,
                }
              : t,
          )
          .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
      );
      setDraft("");
      setFeedback({
        kind: "sent",
        text: data.dryRun
          ? "Recorded in test mode (not delivered yet; it will go out for real once messaging is live)."
          : "Sent.",
      });
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    } catch {
      setFeedback({ kind: "error", text: "Could not reach the server, please try again." });
    } finally {
      setBusy(false);
    }
  }

  if (threads.length === 0) {
    return (
      <EmptyState
        icon={InboxIcon}
        title="No conversations yet"
        description="Patient messages across SMS, WhatsApp, after-hours and the lifecycle agents will appear here as one thread per person. This view is mock safe, so it stays empty until messages arrive."
      />
    );
  }

  return (
    <div className="grid min-h-[34rem] grid-cols-1 overflow-hidden rounded-[10px] border border-line bg-card md:grid-cols-[20rem_1fr] lg:grid-cols-[22rem_1fr]">
      {/* Thread list */}
      <aside
        className={cn(
          "flex min-h-0 flex-col border-line md:border-r",
          // On mobile, hide the list when a thread is open (single-pane).
          active ? "hidden md:flex" : "flex",
        )}
        aria-label="Conversations"
      >
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-navy">Inbox</h2>
          <span className="text-xs text-muted">{threads.length} conversations</span>
        </header>
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {threads.map((t) => {
            const selected = t.contactRef === active?.contactRef;
            return (
              <li key={t.contactRef}>
                <button
                  type="button"
                  onClick={() => openThread(t.contactRef)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-dark/40",
                    selected ? "bg-blue-dark/[0.06]" : "hover:bg-card-muted",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      t.channel === "whatsapp"
                        ? "bg-whatsapp/10 text-[#107c40]"
                        : "bg-blue-dark/10 text-blue-dark",
                    )}
                  >
                    <ChannelIcon channel={t.channel} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="truncate text-sm font-semibold text-navy">{t.contactName}</span>
                        {t.unread ? (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-blue-dark"
                            aria-label="Awaiting reply"
                          />
                        ) : null}
                      </span>
                      <time className="shrink-0 text-[11px] text-muted" dateTime={t.lastAt}>
                        {formatTime(t.lastAt)}
                      </time>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">{t.lastSnippet}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Conversation pane */}
      <section
        className={cn(
          "flex min-h-0 flex-col",
          active ? "flex" : "hidden md:flex",
        )}
        aria-label="Conversation"
      >
        {active ? (
          <>
            <header className="flex items-center gap-3 border-b border-line px-4 py-3">
              <button
                type="button"
                onClick={() => setActiveRef(null)}
                aria-label="Back to conversations"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 md:hidden"
              >
                <ArrowLeft size={18} />
              </button>
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg",
                  active.channel === "whatsapp"
                    ? "bg-whatsapp/10 text-[#107c40]"
                    : "bg-blue-dark/10 text-blue-dark",
                )}
              >
                <ChannelIcon channel={active.channel} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-navy">{active.contactName}</p>
                <p className="text-[11px] text-muted">{CHANNEL_LABEL[active.channel]}</p>
              </div>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {active.messages.map((m) => {
                const outbound = m.direction === "outbound";
                return (
                  <div key={m.id} className={cn("flex", outbound ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[78%]", outbound ? "items-end" : "items-start")}>
                      <div
                        className={cn(
                          "whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                          outbound
                            ? "rounded-br-sm bg-blue-dark text-white"
                            : "rounded-bl-sm border border-line bg-card-muted text-ink",
                        )}
                      >
                        {m.body}
                      </div>
                      <div
                        className={cn(
                          "mt-1 flex items-center gap-1.5 text-[10px] text-muted",
                          outbound ? "justify-end" : "justify-start",
                        )}
                      >
                        <ChannelIcon channel={m.channel} className="opacity-70" />
                        <span>{CHANNEL_LABEL[m.channel]}</span>
                        <span aria-hidden>·</span>
                        <time dateTime={m.at}>{formatStamp(m.at)}</time>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            {/* Reply / takeover box */}
            <div className="border-t border-line px-4 py-3">
              {feedback ? (
                <p
                  role="status"
                  className={cn(
                    "mb-2 rounded-lg px-3 py-2 text-xs",
                    feedback.kind === "sent"
                      ? "bg-success/10 text-success"
                      : feedback.kind === "blocked"
                        ? "bg-warning/10 text-[#9a6700]"
                        : "bg-danger/10 text-danger",
                  )}
                >
                  {feedback.text}
                </p>
              ) : null}
              <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-card px-3 py-2">
                <label htmlFor="inbox-reply" className="sr-only">
                  Reply to {active.contactName}
                </label>
                <textarea
                  id="inbox-reply"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendReply();
                    }
                  }}
                  rows={1}
                  placeholder={`Reply on ${CHANNEL_LABEL[active.channel]}…`}
                  className="max-h-32 min-h-[1.5rem] w-full resize-none bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={busy || !draft.trim()}
                  aria-label="Send reply"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-dark text-white transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                Replies honour consent and opt-outs, and are in test mode until go-live.
              </p>
            </div>
          </>
        ) : (
          <div className="hidden flex-1 items-center justify-center md:flex">
            <p className="text-sm text-muted">Select a conversation to read and reply.</p>
          </div>
        )}
      </section>
    </div>
  );
}
