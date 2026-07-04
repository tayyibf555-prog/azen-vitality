"use client";

import { useEffect, useState } from "react";
import { Search, Wand2 } from "lucide-react";

/**
 * The platform's modifier-key label. Renders "⌘" on first paint (matching the
 * server HTML, so no hydration mismatch) and corrects to "Ctrl+" after mount on
 * non-Apple platforms — dental practices are usually on Windows.
 */
export function useModKey(): string {
  const [mod, setMod] = useState("⌘");
  useEffect(() => {
    const p = navigator.platform ?? "";
    if (!/Mac|iPhone|iPad|iPod/.test(p)) setMod("Ctrl+");
  }, []);
  return mod;
}

/**
 * A quiet card listing every global keyboard shortcut, pinned at the bottom of
 * both sidebars. Each row is also a button that performs the shortcut's action
 * (via the window events PlatformShortcuts listens for), so the card teaches
 * the shortcut AND works as a click target for users who never learn it.
 */
export function SidebarShortcuts() {
  const mod = useModKey();
  const rows = [
    {
      key: "search",
      label: "Search anything",
      icon: Search,
      kbd: `${mod}K`,
      onClick: () => window.dispatchEvent(new CustomEvent("azen:open-palette")),
    },
    {
      key: "copilot",
      label: "Ask the co-pilot",
      icon: Wand2,
      kbd: `${mod}J`,
      onClick: () => window.dispatchEvent(new CustomEvent("azen:open-copilot")),
    },
  ];
  return (
    <div className="mx-3 mb-2 rounded-xl border border-white/15 px-3 py-2">
      <p className="pb-1 text-[10px] font-bold uppercase tracking-wide text-on-navy-muted">Shortcuts</p>
      {rows.map((r) => {
        const Icon = r.icon;
        return (
          <button
            key={r.key}
            type="button"
            onClick={r.onClick}
            className="flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs text-on-navy-muted transition-colors hover:text-on-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon size={12} className="shrink-0" />
              <span className="truncate">{r.label}</span>
            </span>
            <kbd className="shrink-0 rounded border border-white/20 px-1.5 py-0.5 text-[10px] text-on-navy-muted">{r.kbd}</kbd>
          </button>
        );
      })}
    </div>
  );
}
