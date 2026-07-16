"use client";

import { useEffect, useState } from "react";
import { X, Loader2, RefreshCw, MessageSquare } from "lucide-react";
import { StatusPill, type Tone } from "@/components/primitives";
import { cn, relativeTime } from "@/lib/utils";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type { ConversationStatus, MessageRole } from "@/lib/agent/types";
import type { DashboardConversation } from "@/lib/agent/repository";

const STATUS_TONE: Record<ConversationStatus, Tone> = {
  active: "info",
  booked: "success",
  needs_human: "warning",
  closed: "neutral",
};
const STATUS_LABEL: Record<ConversationStatus, string> = {
  active: "In conversation",
  booked: "Booked",
  needs_human: "Needs a human",
  closed: "Closed",
};

interface ThreadMessage {
  id: string;
  role: MessageRole;
  body: string;
  createdAt: string;
}

export function ConversationDrawer({
  conversation,
  nowIso,
  onClose,
}: {
  conversation: DashboardConversation;
  nowIso: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const now = new Date(nowIso);
  const firstName = conversation.patientName.split(" ")[0] || conversation.patientName;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/conversations/${conversation.id}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; messages?: ThreadMessage[] };
      if (!res.ok || !data.ok) throw new Error("failed");
      setMessages(data.messages ?? []);
    } catch {
      setError("Could not load this conversation. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const thread = messages.filter((m) => m.role === "patient" || m.role === "agent");

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{conversation.patientName}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusPill tone={STATUS_TONE[conversation.status]}>{STATUS_LABEL[conversation.status]}</StatusPill>
              {conversation.treatment ? <StatusPill tone="neutral">{conversation.treatment}</StatusPill> : null}
              <StatusPill tone="neutral">{conversation.channel.toUpperCase()}</StatusPill>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={load}
              aria-label="Refresh"
              disabled={loading}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading conversation…
            </div>
          ) : error ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          ) : thread.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <MessageSquare size={22} className="text-muted" />
              <p className="text-sm text-muted">No messages in this conversation yet.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {thread.map((m) => {
                const isAgent = m.role === "agent";
                return (
                  <div key={m.id} className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
                    <div className="max-w-[82%]">
                      <div
                        className={cn(
                          "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                          isAgent
                            ? "rounded-br-sm bg-blue-dark text-white"
                            : "rounded-bl-sm border border-line bg-card-muted text-ink",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      </div>
                      <p className={cn("mt-1 px-1 text-[11px] text-muted", isAgent ? "text-right" : "text-left")}>
                        {isAgent ? "Agent" : firstName} · {relativeTime(m.createdAt, now)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {conversation.status === "needs_human" && !loading ? (
          <div className="border-t border-line bg-warning/10 px-6 py-3 text-sm text-[#9a6700]">
            Handed to your team. The agent has paused on this conversation and is waiting for a person to step in.
          </div>
        ) : null}
      </aside>
    </div>
  );
}
