"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Search, CornerDownLeft, Bot, User, Loader2 } from "lucide-react";
import { CLIENT_NAV, navForRole } from "@/lib/nav";
import { useAuth } from "@/lib/auth/mock-auth";
import { useModKey } from "@/components/platform/sidebar-shortcuts";
import { cn } from "@/lib/utils";

interface Patient {
  id: string;
  name: string;
  phone: string | null;
  siteId: string;
}
interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: string;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onClose,
  basePath,
  clientSlug,
  onOpenCopilot,
}: {
  open: boolean;
  onClose: () => void;
  basePath: string;
  clientSlug: string;
  onOpenCopilot: () => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const mod = useModKey();
  const isOwner = basePath.startsWith("/owner");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [patients, setPatients] = useState<Patient[]>([]);
  // The query the current `patients` actually answer ("" = the initial bounded
  // slice). Deriving "still searching" from this at render time means the very
  // first paint after a keystroke already shows the searching state, with no
  // effect-timing gap where a false "No results" can flash.
  const [resultsFor, setResultsFor] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setResultsFor("");
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    fetch(`/api/dentally/patients?client=${encodeURIComponent(clientSlug)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { patients?: Patient[] }) => setPatients(d.patients ?? []))
      .catch(() => {});
    return () => clearTimeout(t);
  }, [open, clientSlug]);

  // The initial list is the BOUNDED fast segment (~300 of a 51k live base), so
  // filtering it client-side gives false "no results". Once the user has typed a
  // couple of characters, run the server-side search across the WHOLE base
  // (debounced; latest response wins).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) return;
    let stale = false;
    const t = setTimeout(() => {
      fetch(
        `/api/dentally/patients?client=${encodeURIComponent(clientSlug)}&search=${encodeURIComponent(q)}`,
        { cache: "no-store" },
      )
        .then((r) => r.json())
        .then((d: { patients?: Patient[] }) => {
          if (!stale) {
            setPatients(d.patients ?? []);
            setResultsFor(q);
          }
        })
        .catch(() => {
          // A failed search settles to "No results" rather than a stuck spinner.
          if (!stale) setResultsFor(q);
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, clientSlug, query]);

  useEffect(() => setActive(0), [query]);

  const hrefFor = (slug: string) =>
    slug === "" ? (isOwner ? `${basePath}/overview` : basePath) : `${basePath}/${slug}`;

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const go = (href: string) => {
      onClose();
      router.push(href);
    };
    const list: Item[] = [];

    if (!q || "ask the co-pilot copilot chat assistant".includes(q)) {
      list.push({
        key: "copilot",
        label: "Ask the co-pilot",
        hint: `${mod}J`,
        icon: Bot,
        group: "Actions",
        onSelect: () => {
          onClose();
          onOpenCopilot();
        },
      });
    }

    // Only offer modules this role may reach — mirroring the sidebar. Otherwise a
    // coordinator sees owner-only names ("Reports", "Meta Ads") and lands on a 404
    // dead end when the server guard notFound()s the page.
    const nav = user?.role ? navForRole(user.role) : CLIENT_NAV;
    for (const grp of nav) {
      for (const it of grp.items) {
        if (q && !it.label.toLowerCase().includes(q)) continue;
        list.push({
          key: `nav-${it.slug || "overview"}`,
          label: it.label,
          hint: it.status === "placeholder" ? "Soon" : undefined,
          icon: it.icon,
          group: "Go to",
          onSelect: () => go(hrefFor(it.slug)),
        });
      }
    }

    if (q) {
      for (const p of patients) {
        if (!p.name.toLowerCase().includes(q) && !(p.phone ?? "").includes(q)) continue;
        list.push({
          key: `pat-${p.id}`,
          label: p.name,
          hint: p.phone ?? undefined,
          icon: User,
          group: "Patients",
          onSelect: () => go(`${basePath}/patients?patient=${encodeURIComponent(p.id)}`),
        });
        if (list.length > 40) break;
      }
    }

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, patients, basePath, isOwner, user?.role, mod]);

  if (!open) return null;

  const groups = Array.from(new Set(items.map((i) => i.group)));
  // True from the first keystroke of a server-side search until ITS results land:
  // the whole 51k base is being queried, which can take seconds on live Dentally.
  const searchPending = query.trim().length >= 2 && resultsFor !== query.trim();

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.onSelect();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <div
        onKeyDown={onKeyDown}
        className="relative z-10 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search patients, pages and actions"
            className="w-full bg-transparent py-3.5 text-sm text-ink placeholder:text-muted focus:outline-none"
          />
          <kbd className="hidden rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-muted sm:block">esc</kbd>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {items.length === 0 && !searchPending ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No results.</p>
          ) : (
            groups.map((g) => (
              <div key={g} className="mb-1">
                <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{g}</p>
                {items
                  .filter((i) => i.group === g)
                  .map((it) => {
                    const idx = items.indexOf(it);
                    const Icon = it.icon;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        onMouseEnter={() => setActive(idx)}
                        onClick={it.onSelect}
                        className={cn(
                          "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                          idx === active ? "bg-blue-dark/10 text-navy" : "text-ink hover:bg-card-muted",
                        )}
                      >
                        <Icon size={15} className={cn("shrink-0", idx === active ? "text-blue-dark" : "text-muted")} />
                        <span className="flex-1 truncate">{it.label}</span>
                        {it.hint ? <span className="shrink-0 text-[11px] text-muted">{it.hint}</span> : null}
                        {idx === active ? <CornerDownLeft size={13} className="shrink-0 text-muted" /> : null}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
          {searchPending ? (
            <p className="flex items-center justify-center gap-2 px-4 py-3 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" />
              Searching your patient database…
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
