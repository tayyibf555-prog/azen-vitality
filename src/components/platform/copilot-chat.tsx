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
    <div className="fixed inset-0 z-[60]">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-card shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-dark/10 text-blue-dark">
              <Bot size={16} />
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
      </aside>
    </div>
  );
}
