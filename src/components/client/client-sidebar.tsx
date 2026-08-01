"use client";

import { useState } from "react";
import Link from "next/link";
import { NavProgressBar } from "@/components/platform/nav-progress";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  LogOut,
  Search,
  Wand2,
} from "lucide-react";
import { categoriesForRole } from "@/lib/nav";
import { getClient } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
import { useModKey } from "@/components/platform/sidebar-shortcuts";
import { useMobileNav } from "@/components/platform/mobile-nav";
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_GROUPS_COOKIE,
  groupKeyForActive,
  isModuleActive,
  moduleHref,
  resolveOpenGroups,
  serialiseOpenGroups,
  toggleGroup,
  withGroupOpened,
} from "@/lib/sidebar-prefs";
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

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

/** Shared geometry for the icon-only controls in the collapsed rail. */
const RAIL_BUTTON =
  "group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50";

/**
 * The label that appears beside a collapsed-rail icon on hover or keyboard focus.
 * Positioned CLEAR of the 56px rail (never over the logo, never over a sibling)
 * and lifted above the content panel, since the sidebar itself creates no
 * stacking context at lg.
 */
function RailTip({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-[calc(100%+18px)] top-1/2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-navy-line bg-navy px-2 py-1 text-xs font-medium text-on-navy opacity-0 shadow-[0_8px_24px_rgba(4,20,50,0.35)] transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

export function ClientSidebar({
  disabledSlugs = [],
  initialOpenGroups = null,
}: {
  disabledSlugs?: string[];
  /** Areas the user pinned open, or null when they have never chosen. */
  initialOpenGroups?: string[] | null;
}) {
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

  // ONE level: the five areas (Home / Patients / Messages / Growth / Operations)
  // are collapsible groups in a single column, so every module is one click away
  // from anywhere. Areas are filtered to what this role may reach; with no
  // verified role (dev / un-enforced) we show everything. The server-side guard
  // remains the real boundary.
  const groups = categoriesForRole(user?.role ?? null, disabled);
  const allKeys = groups.map((g) => g.key);

  // Optimistic active state: highlight the clicked item instantly instead of
  // waiting for usePathname to commit after the server render. Storing the
  // pathname it was recorded on lets us DERIVE staleness during render, rather
  // than clearing it from an effect a frame later.
  const [pending, setPending] = useState<{ href: string; from: string } | null>(null);
  const pendingHref = pending && pending.from === pathname ? pending.href : null;

  const hrefFor = (slug: string) => moduleHref(base, slug);
  const isActive = (slug: string) => {
    // While a click is in flight, only the clicked item is active.
    if (pendingHref !== null) return pendingHref === hrefFor(slug);
    return isModuleActive(pathname, base, slug);
  };

  const routeKey = groupKeyForActive(groups, isActive);

  // Which areas are open. Seeded from the cookie (plus the current page's area)
  // and thereafter owned by the user: opening an area never navigates.
  const [openKeys, setOpenKeys] = useState<readonly string[]>(() =>
    resolveOpenGroups(initialOpenGroups, routeKey, allKeys),
  );

  // Navigating into a different area opens it. Adjusting state DURING render
  // (React's documented pattern for deriving from a changed input) rather than
  // in an effect: no extra paint, and no set-state-in-effect.
  const [lastRouteKey, setLastRouteKey] = useState(routeKey);
  if (lastRouteKey !== routeKey) {
    setLastRouteKey(routeKey);
    setOpenKeys((keys) => withGroupOpened(keys, routeKey));
  }

  // ALWAYS the rail on desktop. The areas live in the rail and their modules in
  // the section bar along the top, so there is no expanded column to toggle to.
  // Kept as a named constant rather than deleted through every branch below,
  // because the same flag still distinguishes desktop (rail) from the off-canvas
  // drawer under lg, which DOES show the full labelled column: a phone has no
  // room for a section bar, so the drawer has to carry both levels itself.
  const collapsed = true;

  // Every change goes through the FUNCTIONAL updater, so two toggles landing in
  // one batch cannot each compute from the same stale array and lose one. The
  // same pure `compute` produces the cookie value; calling it twice is free.
  const setGroups = (compute: (prev: readonly string[]) => readonly string[]) => {
    setOpenKeys(compute);
    writeCookie(SIDEBAR_GROUPS_COOKIE, serialiseOpenGroups(compute(openKeys)));
  };
  const onToggleGroup = (key: string) => setGroups((prev) => toggleGroup(prev, key));

  const openPalette = () => window.dispatchEvent(new CustomEvent("azen:open-palette"));
  const openCopilot = () => window.dispatchEvent(new CustomEvent("azen:open-copilot"));

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
          "chrome-nav fixed left-0 top-0 z-50 flex h-screen w-[264px] max-w-[85vw] shrink-0 flex-col self-start border-r border-navy-line transition-transform duration-200 ease-out lg:border-r-0",
          // Inside the floating shell at lg the sidebar fills the shell height
          // (h-full) rather than the full viewport, so its foot never clips.
          "lg:sticky lg:z-30 lg:h-full lg:max-w-none lg:translate-x-0",
          // 232px expanded: the narrowest width at which the longest module name
          // ("Treatment Coordinator") still reads in full at this indent.
          "lg:w-14",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Client context. The mark is a white glyph sitting directly on the blue
            gradient at every breakpoint, with no white tile behind it. */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-3",
            collapsed && "lg:justify-center lg:px-0",
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/copilot-logo.png"
              alt="Vitality Dental"
              className="h-8 w-8 object-contain brightness-0 invert"
            />
          </span>
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-semibold text-on-navy",
              collapsed && "lg:hidden",
            )}
          >
            {client ? client.name : "Vitality Dental"}
          </p>
        </div>

        {/* ------------------------------------------------------------------
            COLLAPSED: the 56px icon rail. Wide screens only; the drawer below
            lg always renders the full column underneath.
            ------------------------------------------------------------------ */}
        {collapsed ? (
          <div className="hidden min-h-0 flex-1 flex-col items-center gap-0.5 px-2 py-2 lg:flex">
            <button
              type="button"
              onClick={openPalette}
              aria-label={`Search (${modKey}K)`}
              className={cn(RAIL_BUTTON, "text-on-navy-muted hover:bg-white/10 hover:text-on-navy")}
            >
              <Search size={17} />
              <RailTip>Search ({modKey}K)</RailTip>
            </button>
            <span aria-hidden className="my-1.5 h-px w-6 shrink-0 bg-white/15" />
            <nav aria-label="Areas" className="flex flex-col items-center gap-0.5">
              {groups.map((g) => {
                const GIcon = g.icon;
                const onRoute = g.key === routeKey;
                return (
                  <Link
                    key={g.key}
                    // Straight to the area's FIRST module. The rail chooses an
                    // area; the section bar along the top then carries everything
                    // else in it. Nothing expands, so there is no second state of
                    // this control to get wrong.
                    href={moduleHref(base, g.items[0]?.slug ?? "")}
                    aria-label={`${g.label}${onRoute ? ", current area" : ""}`}
                    aria-current={onRoute ? "page" : undefined}
                    className={cn(
                      RAIL_BUTTON,
                      onRoute
                        ? "bg-white/15 text-white"
                        : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                    )}
                  >
                    <GIcon size={17} />
                    <RailTip>{g.label}</RailTip>
                  </Link>
                );
              })}
            </nav>
            <span className="flex-1" />
            <button
              type="button"
              onClick={openCopilot}
              aria-label={`Ask the co-pilot (${modKey}J)`}
              className={cn(RAIL_BUTTON, "text-on-navy-muted hover:bg-white/10 hover:text-on-navy")}
            >
              <Wand2 size={17} />
              <RailTip>Ask the co-pilot ({modKey}J)</RailTip>
            </button>
          </div>
        ) : null}

        {/* ------------------------------------------------------------------
            EXPANDED: search, the five collapsible areas, then the co-pilot.
            Always rendered below lg (the drawer is never collapsed).
            ------------------------------------------------------------------ */}
        <div className={cn("flex min-h-0 flex-1 flex-col", collapsed && "lg:hidden")}>
          {/* The one search entry point. Modules with no area of their own stay
              one search away without the user having to know the shortcut. */}
          <div className="shrink-0 px-2.5 pb-1 pt-2.5">
            <button
              type="button"
              onClick={openPalette}
              className="flex w-full items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-[13px] text-on-navy-muted transition-colors hover:border-white/25 hover:bg-white/10 hover:text-on-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <Search size={14} className="shrink-0" />
              <span>Search</span>
              <kbd className="ml-auto rounded border border-white/20 px-1 py-px text-[10px] font-medium text-on-navy-muted">
                {modKey}K
              </kbd>
            </button>
          </div>

          <nav
            aria-label="Modules"
            className="scroll-navy min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
          >
            <ul className="space-y-0.5">
              {groups.map((g) => {
                const GIcon = g.icon;
                const open = openKeys.includes(g.key);
                const panelId = `nav-area-${g.key}`;
                return (
                  <li key={g.key}>
                    <h2>
                      <button
                        type="button"
                        onClick={() => onToggleGroup(g.key)}
                        aria-expanded={open}
                        aria-controls={panelId}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                          open
                            ? "text-on-navy hover:bg-white/10"
                            : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                        )}
                      >
                        <GIcon size={14} className="shrink-0" />
                        <span className="truncate">{g.label}</span>
                        <ChevronDown
                          size={13}
                          aria-hidden
                          className={cn(
                            "ml-auto shrink-0 opacity-70 transition-transform duration-150",
                            !open && "-rotate-90",
                          )}
                        />
                      </button>
                    </h2>
                    {/* `hidden` keeps a closed area out of the tab order and the
                        accessibility tree, so keyboard order matches what is seen. */}
                    <ul
                      id={panelId}
                      hidden={!open}
                      className="mb-1 ml-[15px] space-y-px border-l border-white/10 pl-1.5 pt-0.5"
                    >
                      {g.items.map((item) => {
                        const Icon = item.icon;
                        const href = hrefFor(item.slug);
                        const active = isActive(item.slug);
                        return (
                          <li key={item.slug || "overview"}>
                            <Link
                              href={href}
                              aria-current={active ? "page" : undefined}
                              // Hover/focus intent starts the full dynamic prefetch, so
                              // by the time the click lands the page is often already
                              // cached (default prefetch does nothing for dynamic routes
                              // with no loading.tsx). Production-only by Next's design.
                              onMouseEnter={() => router.prefetch(href)}
                              onFocus={() => router.prefetch(href)}
                              onClick={(e) => {
                                // Plain left-click only (not cmd/ctrl/shift = new tab).
                                if (
                                  e.button !== 0 ||
                                  e.metaKey ||
                                  e.ctrlKey ||
                                  e.shiftKey ||
                                  e.altKey
                                ) {
                                  return;
                                }
                                // Close the drawer even when tapping the CURRENT
                                // page's link (no pathname change to auto-close it).
                                setNavOpen(false);
                                // Mark pending only when something will actually
                                // change: on the current page nothing navigates, so
                                // nothing would ever clear the mark.
                                if (href !== pathname) setPending({ href, from: pathname });
                              }}
                              className={cn(
                                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                                active
                                  ? "bg-white font-semibold text-navy shadow-[0_4px_12px_rgba(4,20,50,0.25)]"
                                  : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                              )}
                            >
                              <Icon
                                size={15}
                                className={cn("shrink-0", active && "text-blue-royal")}
                              />
                              <span className="truncate">{item.label}</span>
                              {item.status === "placeholder" ? (
                                <span
                                  className={cn(
                                    "ml-auto shrink-0 rounded-full border px-1.5 text-[9px] font-semibold uppercase tracking-wide",
                                    active
                                      ? "border-line-strong text-muted"
                                      : "border-navy-line text-on-navy-muted",
                                  )}
                                >
                                  soon
                                </span>
                              ) : null}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* The co-pilot: one entry, at the foot, beside the account control. */}
          <div className="shrink-0 px-2 pb-1.5">
            <button
              type="button"
              onClick={openCopilot}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-on-navy-muted transition-colors hover:bg-white/10 hover:text-on-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <Wand2 size={15} className="shrink-0" />
              <span className="truncate">Ask the co-pilot</span>
              <kbd className="ml-auto shrink-0 rounded border border-white/20 px-1 py-px text-[10px] font-medium text-on-navy-muted">
                {modKey}J
              </kbd>
            </button>
          </div>
        </div>

        {/* Account. Shared by both modes: a row when expanded, a stack when not. */}
        <div
          className={cn(
            "shrink-0 border-t border-white/10 px-2 py-2",
            collapsed && "lg:px-1",
          )}
        >
          {user ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg px-1",
                collapsed && "lg:flex-col lg:gap-1 lg:px-0",
              )}
            >
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-soft text-xs font-semibold text-on-navy"
              >
                {initialsOf(user.name)}
              </span>
              <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
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
                aria-label={`Log out, signed in as ${user.name}`}
                className={cn(
                  RAIL_BUTTON,
                  "h-8 w-8 text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                )}
              >
                <LogOut size={15} />
                {collapsed ? <RailTip>Log out ({user.name})</RailTip> : null}
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
