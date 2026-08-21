"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Send, Loader2, Bot, X } from "lucide-react";
import { copilotStartersFor, useCopilotThread } from "@/components/platform/copilot-thread";
import type { CopilotAccess } from "@/lib/copilot/scope";

// ---------------------------------------------------------------------------
// THE BOTTOM-DOCKED POP-UP, and ONLY the pop-up.
//
// This component used to be both surfaces: the shortcut's docked ask-bar AND
// the whole co-pilot page, which rendered it inside a card. That is why the page
// read as an oversized pop-up, and it is fixed by giving the page its own
// component (copilot-page-chat.tsx) rather than by bending this one.
//
// SO NOTHING BELOW THIS LINE IS SHARED LAYOUT ANY MORE. The docked construction
// here — the floating card above a slim ask-bar, the 48vh message cap, the
// single-line input — belongs to the overlay and is pinned by
// copilot-page-chat.test.ts so a change to the page cannot reach it.
//
// WHAT IS STILL SHARED is the transport: the message shape, the request, the
// error sentences, the busy lock and the starter prompts all come from
// copilot-thread.ts, so the two surfaces can never disagree about what sending
// a message does. The starters keep their existing tints (popupTint) because
// this overlay's palette is its own and was not part of the complaint.
// ---------------------------------------------------------------------------

export function CopilotConversation({
  clientSlug,
  autoFocus = true,
  onClose,
  access = "full",
}: {
  clientSlug: string;
  autoFocus?: boolean;
  onClose?: () => void;
  /**
   * Which co-pilot this person has, from their session (resolved in the /c shell
   * layout and threaded down). It filters the STARTERS and nothing else: a
   * manager has no money tool, so a "Who has an outstanding balance?" button
   * would fetch a refusal and, on the way, advertise what she cannot have.
   * Defaults to the owner's set, which is what the /owner shell always gets.
   */
  access?: CopilotAccess;
}) {
  const { messages, busy, send: sendTurn } = useCopilotThread(clientSlug);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 0);
  }, [autoFocus]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  function send(text: string) {
    // Clearing the box is this surface's own business (it owns the input); the
    // turn itself, including the busy lock that stops a double Enter, is the
    // shared hook's. sendTurn ignores an empty or in-flight send on its own.
    if (!text.trim() || busy) return;
    setInput("");
    void sendTurn(text);
  }

  const hasThread = messages.length > 0 || busy;

  return (
    // Bottom-docked: a floating card (identity + starter prompts, or the growing
    // conversation) sits directly above a slim ask-bar. Nothing fills the screen.
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-card border border-line bg-card shadow-[0_20px_55px_rgba(11,32,73,0.30)]">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-royal text-white">
              <Bot size={15} />
            </span>
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-navy">Co-pilot</p>
              <p className="text-[10px] text-muted">Full visibility of your practice</p>
            </div>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-navy"
            >
              <X size={16} />
            </button>
          ) : null}
        </header>

        {hasThread ? (
          <div className="max-h-[48vh] space-y-3 overflow-y-auto px-4 py-4">
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                    m.role === "user"
                      ? "rounded-br-sm bg-blue-dark text-white"
                      : "rounded-bl-sm border border-line bg-card-muted text-ink",
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-line bg-card-muted px-3.5 py-2.5 text-xs text-muted">
                  <Loader2 size={14} className="animate-spin" /> Looking that up…
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        ) : (
          <div className="px-3 py-3">
            <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Try asking</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {copilotStartersFor(access).map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => send(s.prompt)}
                    disabled={busy}
                    className="group flex items-center gap-3 rounded-xl border border-line bg-card-muted/40 px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-card hover:shadow-[0_6px_16px_rgba(20,45,95,0.08)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", s.popupTint)}>
                      <Icon size={16} />
                    </span>
                    <span className="text-[13px] font-semibold leading-snug text-navy">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-card border border-line-strong bg-card px-3 py-2.5 shadow-[0_20px_55px_rgba(11,32,73,0.30)]">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask the co-pilot anything"
          className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
        />
        <button
          type="button"
          onClick={() => send(input)}
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-dark text-white transition-opacity disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
