"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Send, Loader2, CalendarDays, PoundSterling, AlertTriangle, TrendingUp, type LucideIcon } from "lucide-react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

// Starter prompts shown on the empty state. Each maps to a real co-pilot tool
// (appointments / outstanding_balances / no-show risk / practice_overview) so a
// click returns live data rather than a dead end. Clicking one sends it straight
// away, so a first-time user never faces a blank box.
const SUGGESTIONS: { label: string; prompt: string; icon: LucideIcon; tint: string }[] = [
  {
    label: "What's in today's diary?",
    prompt: "What's in today's diary?",
    icon: CalendarDays,
    tint: "bg-blue-dark/10 text-blue-dark",
  },
  {
    label: "Who has an outstanding balance?",
    prompt: "Which patients have an outstanding balance?",
    icon: PoundSterling,
    tint: "bg-emerald-500/10 text-emerald-600",
  },
  {
    label: "Any high no-show risks today?",
    prompt: "Are there any high no-show risks in today's diary?",
    icon: AlertTriangle,
    tint: "bg-amber-500/10 text-amber-600",
  },
  {
    label: "How is the practice doing this week?",
    prompt: "How is the practice doing this week?",
    icon: TrendingUp,
    tint: "bg-violet-500/10 text-violet-600",
  },
];

export function CopilotConversation({
  clientSlug,
  autoFocus = true,
}: {
  clientSlug: string;
  autoFocus?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 0);
  }, [autoFocus]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || busy) return;
    const next = [...messages, { role: "user" as const, content: body }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next, client: clientSlug }),
      });
      const d = (await res.json()) as { reply?: string };
      setMessages([...next, { role: "assistant", content: d.reply ?? "Sorry, something went wrong." }]);
    } catch {
      setMessages([...next, { role: "assistant", content: "Sorry, I could not reach the co-pilot just now." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex-1 space-y-3 px-1 py-1", messages.length ? "overflow-y-auto" : "overflow-hidden")}>
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-2 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/copilot-logo.png" alt="Vitality Dental" className="h-16 w-16 object-contain" />
            <h2 className="mt-4 text-lg font-extrabold text-navy">How can I help?</h2>
            <p className="mt-1 max-w-md text-sm text-muted">
              I can see everything for the site you have selected. Ask about a patient, today&apos;s diary, outstanding balances, or how things are going.
            </p>
            <div className="mt-5 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => send(s.prompt)}
                    disabled={busy}
                    className="group flex items-center gap-3 rounded-xl border border-line bg-card px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_6px_16px_rgba(20,45,95,0.08)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", s.tint)}>
                      <Icon size={16} />
                    </span>
                    <span className="text-[13px] font-semibold leading-snug text-navy">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
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
          ))
        )}
        {busy ? (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-line bg-card-muted px-3.5 py-2.5 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Looking that up…
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="pt-3">
        <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-card px-3 py-2">
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
    </div>
  );
}
