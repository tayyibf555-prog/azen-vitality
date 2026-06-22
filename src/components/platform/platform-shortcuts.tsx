"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { CommandPalette } from "./command-palette";
import { CopilotChat } from "./copilot-chat";

/**
 * Global keyboard shortcuts + the surfaces they open.
 *   Cmd/Ctrl + K  → command palette (search patients, pages, actions)
 *   Cmd/Ctrl + J  → co-pilot chat
 * Mounted once per authenticated shell (owner + client layouts).
 */
export function PlatformShortcuts() {
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      <CopilotChat open={copilot} onClose={() => setCopilot(false)} />
    </>
  );
}
