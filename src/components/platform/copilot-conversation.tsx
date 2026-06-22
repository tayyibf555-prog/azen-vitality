"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Send, Loader2 } from "lucide-react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How are we doing today?",
  "Tell me everything about Rajesh Patel",
  "Who is in the diary today?",
  "How much is outstanding across the practice?",
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
      <div className="flex-1 space-y-3 overflow-y-auto px-1 py-1">
        {messages.length === 0 ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted">
              I can see the whole practice. Ask me about a patient, today's diary, outstanding balances, or how things
              are going.
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-lg border border-line bg-card-muted/50 px-3 py-2 text-left text-sm text-ink hover:bg-card-muted"
                >
                  {s}
                </button>
              ))}
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
