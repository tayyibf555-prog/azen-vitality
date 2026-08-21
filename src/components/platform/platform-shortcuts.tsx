"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { CommandPalette } from "./command-palette";
import { CopilotChat } from "./copilot-chat";
import type { CopilotAccess } from "@/lib/copilot/scope";

/**
 * Global keyboard shortcuts + the surfaces they open.
 *   Cmd/Ctrl + K  → command palette (search patients, pages, actions)
 *   Cmd/Ctrl + J  → co-pilot chat
 * Mounted once per authenticated shell (owner + client layouts).
 */
export function PlatformShortcuts({ copilotAccess = "full" }: { copilotAccess?: CopilotAccess } = {}) {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const clientSlug = params?.client ?? "";
  const isOwner = pathname?.startsWith("/owner") ?? false;
  const basePath = `${isOwner ? "/owner" : "/c"}/${clientSlug}`;

  const [palette, setPalette] = useState(false);
  const [copilot, setCopilot] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setCopilot(false);
        setPalette((v) => !v);
      } else if (k === "j") {
        e.preventDefault();
        setPalette(false);
        setCopilot((v) => !v);
      }
    }
    // The sidebars' visible "Search" row and Shortcuts card open these surfaces
    // via window events, so a non-technical user never has to discover the
    // keyboard shortcuts to use them.
    function onOpenPalette() {
      setCopilot(false);
      setPalette(true);
    }
    function onOpenCopilot() {
      setPalette(false);
      setCopilot(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("azen:open-palette", onOpenPalette);
    window.addEventListener("azen:open-copilot", onOpenCopilot);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("azen:open-palette", onOpenPalette);
      window.removeEventListener("azen:open-copilot", onOpenCopilot);
    };
  }, []);

  if (!clientSlug) return null;

  return (
    <>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        basePath={basePath}
        clientSlug={clientSlug}
        onOpenCopilot={() => setCopilot(true)}
      />
      <CopilotChat open={copilot} onClose={() => setCopilot(false)} clientSlug={clientSlug} access={copilotAccess} />
    </>
  );
}
