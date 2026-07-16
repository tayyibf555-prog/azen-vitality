"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { MessageSquarePlus, Bug, Lightbulb, HelpCircle, Loader2, X, Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import { cn } from "@/lib/utils";
import { FEEDBACK_SEVERITIES, type FeedbackSeverity } from "@/lib/feedback/types";

// A small, quiet "Report an issue" pill mounted once in each authed shell
// (alongside PlatformShortcuts in the c/[client] and owner/[client] layouts).
// Bottom-LEFT so it never overlaps the co-pilot ask-bar, which docks bottom-
// centre when opened (src/components/platform/copilot-chat.tsx). Opens a compact
// modal: pick a severity, write a note, the current page is auto-captured. On
// success the modal closes and a transient toast confirms, then fades.

const SEVERITY_META: Record<FeedbackSeverity, { label: string; icon: LucideIcon }> = {
  bug: { label: "Bug", icon: Bug },
  idea: { label: "Idea", icon: Lightbulb },
  question: { label: "Question", icon: HelpCircle },
};

const MAX_NOTE = 2000;

export function FeedbackWidget() {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const clientSlug = params?.client ?? "";

  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<FeedbackSeverity>("bug");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  useEscapeKey(() => setOpen(false), open);

  // Auto-fade the confirmation toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!clientSlug) return null;

  function close() {
    if (submitting) return;
    setOpen(false);
    setError(null);
  }

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError("Add a quick note first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          pagePath: pathname || "/",
          note: trimmed,
          severity,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Could not send that. Please try again.");
      }
      setOpen(false);
      setNote("");
      setSeverity("bug");
      setToast(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {/* The pill and the toast share one bottom-left slot (mutually exclusive)
          so the confirmation never stacks awkwardly on top of the trigger. */}
      {!toast ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 left-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold text-muted shadow-[0_2px_8px_rgba(10,14,26,0.10)] transition-colors hover:bg-card-muted hover:text-navy"
        >
          <MessageSquarePlus size={14} />
          Report an issue
        </button>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 bg-navy/25 backdrop-blur-[1px]"
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-navy">Report an issue</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Reporting from <span className="font-medium text-ink">{pathname}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-lg p-1 text-muted transition-colors hover:bg-card-muted hover:text-navy"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              {FEEDBACK_SEVERITIES.map((s) => {
                const { label, icon: Icon } = SEVERITY_META[s];
                const active = severity === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    className={cn(
                      "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors",
                      active
                        ? "border-blue-royal/40 bg-blue-royal/10 text-blue-royal"
                        : "border-line-strong bg-card text-muted hover:bg-card-muted",
                    )}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                );
              })}
            </div>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE))}
              placeholder="What happened, or what would help?"
              rows={4}
              className="mt-3 w-full resize-none rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
            />

            {error ? <p className="mt-2 text-xs font-medium text-danger">{error}</p> : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={submitting}>
                {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                Send
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="fixed bottom-4 left-4 z-[70] flex items-center gap-2 rounded-full border border-success/25 bg-success/10 px-3.5 py-2 text-xs font-semibold text-success shadow-[0_4px_12px_rgba(10,14,26,0.12)]">
          <Check size={14} />
          Sent to the team, thank you
        </div>
      ) : null}
    </>
  );
}
