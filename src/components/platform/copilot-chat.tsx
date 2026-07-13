"use client";

import { X, Bot } from "lucide-react";
import { CopilotConversation } from "./copilot-conversation";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";

export function CopilotChat({
  open,
  onClose,
  clientSlug,
}: {
  open: boolean;
  onClose: () => void;
  clientSlug: string;
}) {
  useEscapeKey(onClose, open);
  if (!open) return null;

  return (
    // Centred command-centre panel (was a right-hand drawer): the co-pilot now
    // opens over the page like the command palette, so the shortcut lands it in
    // the middle of the screen with its starter prompts front and centre.
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[8vh]">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-navy/45 backdrop-blur-[2px]" />
      <div
        role="dialog"
        aria-label="Co-pilot"
        className="relative z-10 flex h-[600px] max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-[0_24px_70px_rgba(11,32,73,0.35)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-royal text-white shadow-sm">
              <Bot size={18} />
            </span>
            <div>
              <p className="text-sm font-extrabold text-navy">Co-pilot</p>
              <p className="text-[11px] text-muted">Full visibility of your practice</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-navy"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 px-4 py-4">
          <CopilotConversation clientSlug={clientSlug} />
        </div>
      </div>
    </div>
  );
}
