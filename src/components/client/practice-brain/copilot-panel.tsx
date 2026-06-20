"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";

interface Cite {
  id: string;
  title: string;
}

interface Turn {
  question: string;
  answer: string;
  citations: Cite[];
  groundedIn: number;
  saveStatus?: string;
  qaId?: string;
  feedback?: number;
}

interface Props {
  onCite: (nodeId: string) => void;
}

export function CopilotPanel({ onCite }: Props) {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingIdx, setSavingIdx] = useState<number | null>(null);

  async function ask() {
    if (!input.trim() || busy) return;
    const question = input.trim();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      }).then((r) => r.json());

      if (res.success) {
        const { answer, citations, groundedIn, qaId } = res.data;
        setMessages((prev) => [
          { question, answer, citations: citations ?? [], groundedIn: groundedIn ?? 0, qaId },
          ...prev,
        ]);
        setInput("");
      } else {
        setError(res.error ?? "The brain could not answer that.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void ask();
    }
  }

  async function sendFeedback(idx: number, qaId: string, value: number) {
    try {
      const res = await fetch("/api/practice-brain/qa-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: qaId, value }),
      }).then((r) => r.json());
      if (res.success) {
        setMessages((prev) =>
          prev.map((turn, i) => (i === idx ? { ...turn, feedback: value } : turn)),
        );
      }
    } catch {
      // Best-effort — silently swallow network errors on feedback
    }
  }

  async function saveToBrain(idx: number, text: string) {
    setSavingIdx(idx);
    try {
      const res = await fetch("/api/practice-brain/learn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).then((r) => r.json());

      if (res.success) {
        const { branch, needsReview } = res.data;
        const status = needsReview ? "Sent to review" : `Saved to ${branch || "the brain"}`;
        setMessages((prev) =>
          prev.map((turn, i) => (i === idx ? { ...turn, saveStatus: status } : turn)),
        );
      }
    } finally {
      setSavingIdx(null);
    }
  }

  return (
    <div className="rounded-xl border border-line-strong bg-card p-4">
      <h3 className="text-sm font-semibold text-ink">Ask the brain</h3>
      <p className="mt-0.5 text-xs text-muted">
        Answers come only from the practice knowledge, filtered to your clearance.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-line bg-card-muted px-2 py-1.5 text-sm text-ink placeholder:text-muted disabled:opacity-50"
        />
        <button
          onClick={() => void ask()}
          disabled={busy || input.trim().length === 0}
          className="rounded-lg bg-blue-dark px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Ask
        </button>
      </div>

      {busy && (
        <p className="mt-2 text-xs text-muted">Thinking...</p>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}

      {messages.length > 0 && (
        <div className="mt-4 flex flex-col gap-4">
          {messages.map((turn, i) => (
            <div key={i} className="rounded-lg border border-line bg-card-muted p-3">
              <p className="text-xs text-muted">
                <span className="font-medium">You:</span> {turn.question}
              </p>
              <p className="mt-1.5 text-sm text-ink">{turn.answer}</p>

              {turn.groundedIn === 0 ? (
                <p className="mt-1.5 text-xs text-muted italic">
                  This was not in the brain, so it went to the gap queue for an owner to fill.
                </p>
              ) : (
                <div className="mt-1.5 flex items-center gap-2">
                  {!turn.saveStatus ? (
                    <button
                      onClick={() => void saveToBrain(i, turn.answer)}
                      disabled={savingIdx === i}
                      className="text-xs text-blue-dark disabled:opacity-50"
                    >
                      {savingIdx === i ? "Saving..." : "Save to brain"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted">{turn.saveStatus}</span>
                  )}
                </div>
              )}

              {turn.citations.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {turn.citations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => onCite(c.id)}
                      className="rounded-full bg-blue-light/20 px-2 py-0.5 text-xs text-blue-dark hover:bg-blue-light/40 transition-colors"
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
              )}

              {turn.qaId && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void sendFeedback(i, turn.qaId!, 1)}
                    disabled={turn.feedback === 1}
                    aria-label="Helpful"
                    className="disabled:cursor-default"
                  >
                    <ThumbsUp
                      size={14}
                      className={turn.feedback === 1 ? "text-blue-dark" : "text-muted hover:text-blue-dark transition-colors"}
                    />
                  </button>
                  <button
                    onClick={() => void sendFeedback(i, turn.qaId!, -1)}
                    disabled={turn.feedback === -1}
                    aria-label="Not helpful"
                    className="disabled:cursor-default"
                  >
                    <ThumbsDown
                      size={14}
                      className={turn.feedback === -1 ? "text-blue-dark" : "text-muted hover:text-blue-dark transition-colors"}
                    />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
