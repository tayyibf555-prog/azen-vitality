"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NavProgressBar } from "@/components/platform/nav-progress";
import { useParams, usePathname, useRouter } from "next/navigation";
import { LogOut, Search } from "lucide-react";
import { categoriesForRole } from "@/lib/nav";
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

export function ClientSidebar({ disabledSlugs = [] }: { disabledSlugs?: string[] }) {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const modKey = useModKey();
  const { open: navOpen, setOpen: setNavOpen, hiddenFromA11y } = useMobileNav();

  const clientSlug = params.client;
  const client = getClient(clientSlug);
  const base = `/c/${clientSlug}`;

  // Systems the owner has switched OFF are hidden from the sidebar (resolved
  // server-side in the layout and passed down, so a coordinator without the
  // owner-only /api/systems read still gets the filtered nav).
  const disabled = new Set(disabledSlugs);

  // Two-level nav: a slim category rail (Home / Patients / Messages / Growth /
  // Operations) and a panel listing ONLY the selected category's modules — far
  // less to scan than the old all-29-modules list. Categories are filtered to
  // what this role may reach; with no verified role (dev / un-enforced) we show
  // everything. The server-side guard remains the real boundary.
  const categories = categoriesForRole(user?.role ?? null, disabled);

  // Optimistic active state: highlight the clicked tab instantly instead of waiting
  // for usePathname to commit after the server render. Cleared once the route lands.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);

  const hrefFor = (slug: string) => (slug === "" ? base : `${base}/${slug}`);
  const isActive = (slug: string) => {
    const href = hrefFor(slug);
    // While a click is in flight, only the clicked tab is active.
    if (pendingHref !== null) return pendingHref === href;
    if (slug === "") return pathname === base || pathname === `${base}/`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // The rail selection: browsing a category only switches the panel (no page
  // navigation); navigating to a page snaps the rail back to that page's own
  // category so a deep link or a palette jump always highlights correctly.
  const routeCategoryKey =
    categories.find((c) => c.items.some((i) => isActive(i.slug)))?.key ?? categories[0]?.key ?? null;
  const [browseKey, setBrowseKey] = useState<string | null>(null);
  useEffect(() => setBrowseKey(null), [pathname]);
  const activeKey = browseKey ?? routeCategoryKey;
  const current = categories.find((c) => c.key === activeKey) ?? categories[0];

  // Vertical tabs keyboard pattern: arrows/Home/End move the rail selection and
  // focus together (roving tabindex), so the rail is fully keyboard-operable.
  const onRailKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = Math.max(0, categories.findIndex((c) => c.key === activeKey));
    const next =
      e.key === "Home" ? 0
        : e.key === "End" ? categories.length - 1
          : e.key === "ArrowDown" ? Math.min(idx + 1, categories.length - 1)
            : Math.max(idx - 1, 0);
    const key = categories[next]?.key;
    if (key) {
      setBrowseKey(key);
      document.getElementById(`rail-${key}`)?.focus();
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
      {/* Client context. On the light frame the mark sits on a white tile (the
          premium logo-on-tint treatment); the mobile dark drawer keeps the
          light-on-dark glyph. */}
      <div className="flex items-center gap-4 px-5 py-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl lg:bg-white lg:shadow-chip lg:ring-1 lg:ring-navy/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/copilot-logo.png"
            alt="Vitality Dental"
            className="h-11 w-11 object-contain brightness-0 invert lg:h-9 lg:w-9 lg:filter-none"
          />
        </span>
        <p className="truncate text-sm font-semibold text-on-navy lg:text-navy">{client ? client.name : "Vitality Dental"}</p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Category rail */}
        <div
          role="tablist"
          aria-label="Areas"
          aria-orientation="vertical"
          onKeyDown={onRailKeyDown}
          className="flex w-[76px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/10 px-1.5 py-2 lg:border-navy/10"
        >
          {categories.map((c) => {
            const CIcon = c.icon;
            const selected = c.key === activeKey;
            return (
              <button
                key={c.key}
                id={`rail-${c.key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setBrowseKey(c.key)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 lg:focus-visible:ring-navy/25",
                  selected
                    ? "bg-white/15 text-white lg:bg-white lg:text-navy lg:shadow-chip"
                    : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy lg:text-side-ink lg:hover:bg-white/55 lg:hover:text-navy",
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
            className="mb-2.5 flex w-full items-center gap-2.5 rounded-xl border border-white/15 px-2.5 py-2 text-sm text-on-navy-muted transition-colors hover:bg-white/10 hover:text-on-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 lg:border-navy/15 lg:text-side-ink lg:hover:bg-white/55 lg:hover:text-navy lg:focus-visible:ring-navy/25"
          >
            <Search size={15} className="shrink-0" />
            <span>Search</span>
            <kbd className="ml-auto rounded border border-white/20 px-1.5 py-0.5 text-[10px] text-on-navy-muted lg:border-navy/15 lg:text-side-label">{modKey}K</kbd>
          </button>
          {current ? (
            <div role="tabpanel" aria-labelledby={`rail-${current.key}`}>
              <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-on-navy lg:text-side-label">
                {current.label}
              </p>
              <ul className="space-y-0.5">
                {current.items.map((item) => {
                  const Icon = item.icon;
                  const href = hrefFor(item.slug);
                  const active = isActive(item.slug);
                  return (
                    <li key={item.slug || "overview"}>
                      <Link
                        href={href}
                        title={item.label}
                        aria-current={active ? "page" : undefined}
                        // Hover/focus intent starts the full dynamic prefetch, so by
                        // the time the click lands the page is often already cached
                        // (default prefetch does nothing for dynamic routes with no
                        // loading.tsx). Production-only by Next's design.
                        onMouseEnter={() => router.prefetch(href)}
                        onFocus={() => router.prefetch(href)}
                        onClick={(e) => {
                          // Plain left-click only (not cmd/ctrl/shift = open in new tab).
                          if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                            setPendingHref(href);
                            // Close the drawer even when tapping the CURRENT page's
                            // link (no pathname change to auto-close it).
                            setNavOpen(false);
                          }
                        }}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
                          active
                            ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)] lg:shadow-chip"
                            : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy lg:text-side-ink lg:hover:bg-white/55 lg:hover:text-navy",
                        )}
                      >
                        <Icon size={16} className={cn("shrink-0", active && "text-blue-royal")} />
                        <span className="truncate">{item.label}</span>
                        {item.status === "placeholder" ? (
                          <span className="ml-auto rounded-full border border-navy-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-on-navy-muted lg:rounded-md lg:border-line-strong lg:text-faint">
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
      <div className="border-t border-navy-line px-3 py-3 lg:border-navy/10">
        {user ? (
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-soft text-xs font-semibold text-on-navy lg:bg-blue-royal lg:text-white">
              {initialsOf(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-on-navy lg:text-navy">{user.name}</p>
              <p className="truncate text-[11px] text-on-navy-muted lg:text-faint">
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
              className="flex h-8 w-8 items-center justify-center rounded-lg text-on-navy-muted transition-colors hover:bg-navy-soft hover:text-on-navy lg:text-side-ink lg:hover:bg-white/55 lg:hover:text-navy"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center justify-center rounded-lg px-2 py-2 text-xs font-semibold text-on-navy-muted hover:text-on-navy lg:text-side-ink lg:hover:text-navy"
          >
            Sign in
          </Link>
        )}
      </div>
    </aside>
    </>
  );
}
