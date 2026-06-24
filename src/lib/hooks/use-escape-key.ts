"use client";

import { useEffect } from "react";

/**
 * Calls `onEscape` whenever the Escape key is pressed while enabled.
 * Used by popups (modals, drawers, panels) so Esc closes them, alongside the
 * close button. The listener is only attached while the popup is mounted/enabled.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape, enabled]);
}
