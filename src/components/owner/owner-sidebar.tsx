"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NavProgressBar } from "@/components/platform/nav-progress";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Gauge, Wand2, BrainCircuit, LogOut, Search } from "lucide-react";
import { categoriesForRole, canRoleAccessModule } from "@/lib/nav";
import { getClient } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
import { SidebarShortcuts, useModKey } from "@/components/platform/sidebar-shortcuts";
import { useMobileNav } from "@/components/platform/mobile-nav";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<string, string> = {
  agency_admin: "Agency admin",
  client_owner: "Owner",
  client_coordinator: "Coordinator",
};

function initialsOf(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** One row in the panel, whatever category it came from. */
interface Entry {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  soon?: boolean;
}

export function OwnerSidebar({ disabledSlugs = [] }: { disabledSlugs?: string[] }) {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const modKey = useModKey();
  const { open: navOpen, setOpen: setNavOpen, hiddenFromA11y } = useMobileNav();

  const clientSlug = params.client;
  const client = getClient(clientSlug);
  const base = `/owner/${clientSlug}`;

  // Systems the owner has switched OFF drop out of the sidebar (resolved
  // server-side in the layout). "System controls" is never a controllable
  // system, so it is never hidden and stays reachable to switch things back on.
  const disabled = new Set(disabledSlugs);

  // The owner shell only renders for owner/agency roles (the /owner layout guard
  // bounces coordinators), so this normally yields the full nav. We still filter
  // by role for defence in depth; no verified role (dev) shows everything.
  const categories = categoriesForRole(user?.role ?? null, disabled);

  // The owner Overview lives at /owner/[client]/overview, so the base path is
  // reserved for the Management view rather than the funnel Overview.
  const hrefFor = (slug: string) => (slug === "" ? `${base}/overview` : `${base}/${slug}`);

  // Optimistic active state: highlight the clicked tab instantly instead of waiting
  // for usePathname to commit after the server render. Cleared once the route lands.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);
  const markPending = (href: string) => (e: React.MouseEvent) => {
    // Plain left-click only (not cmd/ctrl/shift = open in new tab).
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      setPendingHref(href);
      // Close the drawer even when tapping the CURRENT page's link (no pathname
      // change to auto-close it).
      setNavOpen(false);
    }
  };

  const isHrefActive = (href: string, exact = false) => {
    if (pendingHref !== null) return pendingHref === href; // clicked tab wins while in flight
    if (exact) return pathname === href || pathname === `${href}/`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Same two-level rail + panel as the client shell, with an extra owner-only
  // "Manage" category first: the Management command view, the co-pilot chat and
  // the Practice brain. Co-pilot lives here, so it is deduped out of Operations.
  //
  // Practice brain and the co-pilot are owner-only, so drop them for any non-owner
  // role via the single source of truth (canRoleAccessModule) — defence in depth on
  // top of the /owner layout guard that already bounces coordinators, and the one
  // place the owner sidebar would otherwise hard-code an owner-only entry. The
  // Management view is the owner-overview base path (no module slug), so it is kept
  // for the roles that render this shell; a null role (dev / enforcement off) shows
  // everything, matching the categoriesForRole fallback above.
  const manageEntries: Entry[] = (
    [
      { key: "management", label: "Management", icon: Gauge, href: base },
      { key: "co-pilot", label: "Co-pilot", icon: Wand2, href: hrefFor("co-pilot") },
      { key: "practice-brain", label: "Practice brain", icon: BrainCircuit, href: hrefFor("practice-brain") },
    ] satisfies Entry[]
  ).filter((e) => e.key === "management" || !user?.role || canRoleAccessModule(user.role, e.key));
  const railCategories: { key: string; label: string; icon: LucideIcon; entries: Entry[] }[] = [
    { key: "manage", label: "Manage", icon: Gauge, entries: manageEntries },
    ...categories.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
      entries: c.items
        .filter((i) => i.slug !== "co-pilot")
        .map<Entry>((i) => ({
          key: i.slug || "overview",
          label: i.label,
          icon: i.icon,
          href: hrefFor(i.slug),
          soon: i.status === "placeholder",
        })),
    })),
  ].filter((c) => c.entries.length > 0);

  // Management is the base path, so it must be matched EXACTLY (every module href
  // starts with the base) — otherwise Manage would swallow every route.
  const entryActive = (categoryKey: string, e: Entry) =>
    isHrefActive(e.href, categoryKey === "manage" && e.key === "management");

  const routeCategoryKey =
    railCategories.find((c) => c.entries.some((e) => entryActive(c.key, e)))?.key ??
    railCategories[0]?.key ?? null;
  const [browseKey, setBrowseKey] = useState<string | null>(null);
  useEffect(() => setBrowseKey(null), [pathname]);
  const activeKey = browseKey ?? routeCategoryKey;
  const current = railCategories.find((c) => c.key === activeKey) ?? railCategories[0];

  // Vertical tabs keyboard pattern: arrows/Home/End move the rail selection and
  // focus together (roving tabindex), so the rail is fully keyboard-operable.
  const onRailKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = Math.max(0, railCategories.findIndex((c) => c.key === activeKey));
    const next =
      e.key === "Home" ? 0
        : e.key === "End" ? railCategories.length - 1
          : e.key === "ArrowDown" ? Math.min(idx + 1, railCategories.length - 1)
            : Math.max(idx - 1, 0);
    const key = railCategories[next]?.key;
    if (key) {
      setBrowseKey(key);
      document.getElementById(`orail-${key}`)?.focus();
    }
  };

  return (
    <>
      <NavProgressBar active={pendingHref !== null} />
      {navOpen ? (
        <div
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-navy/50 backdrop-blur-sm lg:hidden"
          aria-hidden
        />
      ) : null}
      <aside
        // Off-canvas on mobile: not keyboard/screen-reader reachable while closed.
        inert={hiddenFromA11y || undefined}
        aria-hidden={hiddenFromA11y || undefined}
        className={cn(
          "chrome-nav fixed left-0 top-0 z-50 flex h-screen w-[296px] max-w-[85vw] shrink-0 flex-col self-start border-r border-navy-line transition-transform lg:border-r-0 duration-200 ease-out",
          // Inside the floating shell at lg the sidebar fills the shell height
          // (h-full) rather than the full viewport, so its foot never clips.
          "lg:sticky lg:z-auto lg:h-full lg:max-w-none lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
      {/* Client context. The mark is a white glyph sitting directly on the blue
          gradient at every breakpoint (matching the mobile drawer and the
          production navy chrome), with no white tile behind it. */}
      <div className="flex items-center gap-4 px-5 py-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/copilot-logo.png"
            alt="Vitality Dental"
            className="h-11 w-11 object-contain brightness-0 invert lg:h-9 lg:w-9"
          />
        </span>
        <p className="truncate text-sm font-semibold text-on-navy">{client ? client.name : "Vitality Dental"}</p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Category rail */}
        <div
          role="tablist"
          aria-label="Areas"
          aria-orientation="vertical"
          onKeyDown={onRailKeyDown}
          className="flex w-[76px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/10 px-1.5 py-2"
        >
          {railCategories.map((c) => {
            const CIcon = c.icon;
            const selected = c.key === activeKey;
            return (
              <button
                key={c.key}
                id={`orail-${c.key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setBrowseKey(c.key)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                  selected
                    ? "bg-white/15 text-white"
                    : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                )}
              >
                <CIcon size={18} className="shrink-0" />
                <span className="text-[11px] font-semibold leading-none">{c.label}</span>
              </button>
            );
          })}
        </div>

        {/* Panel column: the selected category's modules, with the shortcuts card
            pinned at the bottom so the rail divider runs cleanly past it. */}
        <div className="flex min-w-0 flex-1 flex-col">
        <nav className="min-w-0 flex-1 overflow-y-auto px-2.5 py-3" aria-label="Modules">
          {/* Visible search entry point: hidden-by-category modules stay one search
              away, without the user having to know the ⌘K shortcut exists. */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("azen:open-palette"))}
            className="mb-2.5 flex w-full items-center gap-2.5 rounded-xl border border-white/15 px-2.5 py-2 text-sm text-on-navy-muted transition-colors hover:bg-white/10 hover:text-on-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <Search size={15} className="shrink-0" />
            <span>Search</span>
            <kbd className="ml-auto rounded border border-white/20 px-1.5 py-0.5 text-[10px] text-on-navy-muted">{modKey}K</kbd>
          </button>
          {current ? (
            <div role="tabpanel" aria-labelledby={`orail-${current.key}`}>
              <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-on-navy">
                {current.label}
              </p>
              <ul className="space-y-0.5">
                {current.entries.map((e) => {
                  const Icon = e.icon;
                  const active = entryActive(current.key, e);
                  return (
                    <li key={e.key}>
                      <Link
                        href={e.href}
                        title={e.label}
                        aria-current={active ? "page" : undefined}
                        // Hover/focus intent starts the full dynamic prefetch (the
                        // default does nothing for dynamic routes with no loading.tsx).
                        onMouseEnter={() => router.prefetch(e.href)}
                        onFocus={() => router.prefetch(e.href)}
                        onClick={markPending(e.href)}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
                          active
                            ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                            : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                        )}
                      >
                        <Icon size={16} className={cn("shrink-0", active && "text-blue-royal")} />
                        <span className="truncate">{e.label}</span>
                        {e.soon ? (
                          <span className="ml-auto rounded-full border border-navy-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-on-navy-muted">
                            soon
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </nav>
        <SidebarShortcuts />
        </div>
      </div>

      {/* User chip + logout */}
      <div className="border-t border-navy-line px-3 py-3">
        {user ? (
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-soft text-xs font-semibold text-on-navy">
              {initialsOf(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-on-navy">{user.name}</p>
              <p className="truncate text-[11px] text-on-navy-muted">
                {ROLE_LABELS[user.role] ?? user.role}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                logout();
                router.push("/login");
              }}
              aria-label="Log out"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-on-navy-muted transition-colors hover:bg-navy-soft hover:text-on-navy"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center justify-center rounded-lg px-2 py-2 text-xs font-semibold text-on-navy-muted hover:text-on-navy"
          >
            Sign in
          </Link>
        )}
      </div>
    </aside>
    </>
  );
}
