"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Gauge, Wand2, BrainCircuit, LogOut, ChevronDown } from "lucide-react";
import { CLIENT_NAV, navForRole } from "@/lib/nav";
import { getClient } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
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

export function OwnerSidebar() {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const clientSlug = params.client;
  const client = getClient(clientSlug);
  const base = `/owner/${clientSlug}`;

  // The owner shell only renders for owner/agency roles (the /owner layout guard
  // bounces coordinators), so this normally yields the full nav. We still filter
  // by role for defence in depth; no verified role (dev) shows everything.
  const nav = user?.role ? navForRole(user.role) : CLIENT_NAV;

  // The owner Overview lives at /owner/[client]/overview, so the base path is
  // reserved for the Management view rather than the funnel Overview.
  const hrefFor = (slug: string) => (slug === "" ? `${base}/overview` : `${base}/${slug}`);

  // Optimistic active state: highlight the clicked tab instantly instead of waiting
  // for usePathname to commit after the server render. Cleared once the route lands.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);
  const markPending = (href: string) => (e: React.MouseEvent) => {
    // Plain left-click only (not cmd/ctrl/shift = open in new tab).
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) setPendingHref(href);
  };

  const isManagementActive =
    pendingHref !== null ? pendingHref === base : pathname === base || pathname === `${base}/`;

  const isActive = (slug: string) => {
    const href = hrefFor(slug);
    if (pendingHref !== null) return pendingHref === href; // clicked tab wins while in flight
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Collapsible nav groups (items branch down under each section header). Track the
  // COLLAPSED set (default: all open). The sidebar lives in the layout, so this
  // persists across navigation. The active item's group is always kept open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  const activeGroupLabel = nav.find((g) => g.items.some((i) => isActive(i.slug)))?.label ?? null;
  useEffect(() => {
    if (!activeGroupLabel) return;
    setCollapsed((prev) => {
      if (!prev.has(activeGroupLabel)) return prev;
      const next = new Set(prev);
      next.delete(activeGroupLabel);
      return next;
    });
  }, [activeGroupLabel]);

  return (
    <aside className="chrome-nav flex h-screen w-64 shrink-0 flex-col border-r border-navy-line">
      {/* Client context */}
      <div className="flex items-center gap-4 px-5 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/copilot-logo.png"
          alt="Vitality Dental"
          className="h-11 w-11 shrink-0 object-contain brightness-0 invert"
        />
        <p className="truncate text-sm font-bold text-on-navy">{client ? client.name : "Vitality Dental"}</p>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {/* Management: the owner's command view, peer of (but above) the funnel. */}
        <div className="mb-4">
          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-navy-muted">
            Practice
          </p>
          <ul className="space-y-0.5">
            <li>
              <Link
                href={base}
                onClick={markPending(base)}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
                  isManagementActive
                    ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                    : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                )}
              >
                {isManagementActive ? (
                  <></>
                ) : null}
                <Gauge size={16} className="shrink-0" />
                <span className="truncate">Management</span>
              </Link>
            </li>
            <li>
              <Link
                href={hrefFor("co-pilot")}
                onClick={markPending(hrefFor("co-pilot"))}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
                  isActive("co-pilot")
                    ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                    : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                )}
              >
                {isActive("co-pilot") ? (
                  <></>
                ) : null}
                <Wand2 size={16} className="shrink-0" />
                <span className="truncate">Co-pilot</span>
              </Link>
            </li>
            <li>
              <Link
                href={hrefFor("practice-brain")}
                onClick={markPending(hrefFor("practice-brain"))}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
                  isActive("practice-brain")
                    ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                    : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                )}
              >
                {isActive("practice-brain") ? (
                  <></>
                ) : null}
                <BrainCircuit size={16} className="shrink-0" />
                <span className="truncate">Practice brain</span>
              </Link>
            </li>
          </ul>
        </div>

        {nav.map((group) => {
          const open = !collapsed.has(group.label);
          return (
          <div key={group.label} className="mb-1.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              aria-expanded={open}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-on-navy transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              <span>{group.label}</span>
              <ChevronDown
                size={13}
                className={cn("shrink-0 transition-transform duration-200", open ? "" : "-rotate-90")}
              />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out",
                open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <ul className="ml-4 space-y-0.5 overflow-hidden border-l border-white/15 pl-3 pt-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const href = hrefFor(item.slug);
                const active = isActive(item.slug);
                return (
                  <li key={item.slug || "overview"}>
                    <Link
                      href={href}
                      onClick={markPending(href)}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors before:pointer-events-none before:absolute before:top-1/2 before:-left-3 before:h-px before:w-3 before:-translate-y-1/2 before:bg-white/20 before:content-['']",
                        active
                          ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                          : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
                      )}
                    >
                      <Icon size={16} className={cn("shrink-0", active && "text-blue-royal")} />
                      <span className="truncate">{item.label}</span>
                      {item.status === "placeholder" ? (
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
          </div>
          );
        })}
      </nav>

      {/* User chip + logout */}
      <div className="border-t border-navy-line px-3 py-3">
        {user ? (
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-soft text-xs font-bold text-on-navy">
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
  );
}
