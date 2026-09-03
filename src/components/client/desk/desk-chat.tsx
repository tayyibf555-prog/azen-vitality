"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";

// ===========================================================================
// THE STAFF DESK CHAT — shared by the equipment desk and the IT desk.
//
// ONE COMPONENT, TWO AGENTS, and deliberately NOT the co-pilot's. The co-pilot's
// page chat (src/components/platform/copilot-page-chat.tsx) is a full-height
// reading surface for long structured answers about the whole practice; these two
// are a panel inside a tabbed module, answering short operational questions with
// a register or a playbook list beside them. Reusing that component would put a
// full-height ask surface inside a tab, which is the exact mistake its own header
// comment records being made in the other direction.
//
// WHAT IS SHARED WITH THE CO-PILOT: the honest posture. There is no persistence
// behind this — no thread id, no history endpoint, no table — so it says so, and
// there is no sidebar of past conversations implying one.
//
// A CLIENT COMPONENT THAT EXPORTS ONLY A COMPONENT. Every value it needs (the
// endpoint, the copy, the starters) arrives as a prop from the server view, and
// nothing here is exported for a server file to import. That is the RSC
// value-import trap (pinned by rsc-value-import.test.ts) avoided by construction
// rather than by remembering.
// ===========================================================================

interface Message {
  role: "user" | "assistant";
  content: string;
}

/** Shown when the request never completed. Local to this module (see the note above). */
const UNREACHABLE = "Sorry, I could not reach the desk just now. Please try again.";
const FAILED = "Sorry, something went wrong.";

export function DeskChat({
  endpoint,
  clientSlug,
  emptyHeading,
  emptyBody,
  placeholder,
  starters,
  disabledNote,
}: {
  /** e.g. "/api/equipment/ask". */
  endpoint: string;
  clientSlug: string;
  emptyHeading: string;
  emptyBody: string;
  placeholder: string;
  /** Suggested questions. Each one must be answerable by this agent. */
  starters: string[];
  /**
   * Shown above the composer when the system is switched off. The chat is still
   * usable — the server answers with its own "switched off" sentence — because a
   * disabled box that says nothing is how somebody concludes the page is broken.
   */
  disabledNote?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<Message[]>([]);
  const busyRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      // The busy lock is a REF, not the state, so two Enter presses in the same
      // tick cannot both pass the check and charge two turns.
      if (!body || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setDraft("");
      const next: Message[] = [...threadRef.current, { role: "user", content: body }];
      threadRef.current = next;
      setMessages(next);

      let reply = FAILED;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client: clientSlug, messages: next }),
        });
        const data = ((await response.json()) ?? {}) as { reply?: unknown; error?: unknown };
        if (typeof data.reply === "string" && data.reply.trim().length > 0) {
          reply = data.reply;
        } else if (typeof data.error === "string" && data.error.trim().length > 0) {
          reply = data.error;
        }
      } catch {
        reply = UNREACHABLE;
      }

      const settled: Message[] = [...threadRef.current, { role: "assistant", content: reply }];
      threadRef.current = settled;
      setMessages(settled);
      busyRef.current = false;
      setBusy(false);
    },
    [endpoint, clientSlug],
  );

  const reset = () => {
    if (busyRef.current) return;
    threadRef.current = [];
    setMessages([]);
  };

  return (
    <div className="flex h-[min(60vh,540px)] flex-col rounded-[10px] border border-line bg-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <p className="text-caption text-muted">Nothing here is saved. Refreshing the page clears the conversation.</p>
        {messages.length > 0 ? (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="pressable inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:text-navy disabled:opacity-40"
          >
            <SquarePen size={13} />
            New conversation
          </button>
        ) : null}
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-2xl">
            <h3 className="text-title text-navy">{emptyHeading}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{emptyBody}</p>
            {starters.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Try asking</p>
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="pressable rounded-[10px] border border-line px-3 py-2 text-left text-[13px] text-navy transition-colors hover:bg-[#f7f9fc]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.map((m, i) => (
              <div key={`${i}-${m.role}`} className={cn(m.role === "user" && "flex justify-end")}>
                {m.role === "user" ? (
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-[10px] bg-tile px-3 py-2 text-[13px] text-navy">
                    {m.content}
                  </p>
                ) : (
                  // Not in a bubble: an answer is read, not glanced at, and a
                  // twelve-line troubleshooting reply boxed in a rounded
                  // rectangle loses two gutters and a border for nothing.
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-navy">{m.content}</p>
                )}
              </div>
            ))}
            {busy ? (
              <p className="inline-flex items-center gap-2 text-[13px] text-muted">
                <Loader2 size={14} className="animate-spin" />
                Working on it
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="border-t border-line px-4 py-3">
        {disabledNote ? (
          <p className="mb-2 rounded-[8px] bg-tile px-3 py-2 text-[12px] leading-relaxed text-muted">{disabledNote}</p>
        ) : null}
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="min-h-[38px] max-h-[140px] flex-1 resize-none rounded-[10px] border border-line px-3 py-2 text-[13px] text-navy outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => void send(draft)}
            disabled={busy || draft.trim().length === 0}
            className="pressable inline-flex h-[38px] items-center gap-1.5 rounded-[10px] bg-navy px-3 text-[13px] font-medium text-white disabled:opacity-40"
          >
            <Send size={14} />
            Send
          </button>
        </div>
        <p className="mx-auto mt-1.5 max-w-2xl text-[11px] text-faint">Enter to send, Shift + Enter for a new line</p>
      </div>
    </div>
  );
}
