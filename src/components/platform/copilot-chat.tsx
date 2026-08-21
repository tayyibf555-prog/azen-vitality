"use client";

import { CopilotConversation } from "./copilot-conversation";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import type { CopilotAccess } from "@/lib/copilot/scope";

export function CopilotChat({
  open,
  onClose,
  clientSlug,
  access = "full",
}: {
  open: boolean;
  onClose: () => void;
  clientSlug: string;
  /** Passed straight through to the starters. See CopilotConversation. */
  access?: CopilotAccess;
}) {
  useEscapeKey(onClose, open);
  if (!open) return null;

  return (
    // Docked at the BOTTOM of the screen (was a centred box): the shortcut drops
    // a slim ask-bar near the bottom with its starter prompts floating just above
    // it, and the conversation grows upward from the bar as you chat.
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-end p-4 pb-5 sm:pb-6">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-navy/25 backdrop-blur-[1px]" />
      <div className="relative z-10 w-full max-w-2xl">
        <CopilotConversation clientSlug={clientSlug} onClose={onClose} access={access} />
      </div>
    </div>
  );
}
