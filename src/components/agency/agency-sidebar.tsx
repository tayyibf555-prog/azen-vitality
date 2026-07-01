"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, CreditCard, Settings, LogOut, type LucideIcon } from "lucide-react";
import { useAuth } from "@/lib/auth/mock-auth";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { label: "Cockpit", href: "/agency", icon: LayoutDashboard },
  { label: "Billing", icon: CreditCard, soon: true },
  { label: "Settings", icon: Settings, soon: true },
];

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function AgencySidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const displayName = user?.name ?? "Agency";

  // Optimistic active state: highlight the clicked tab instantly rather than after
  // the route commits. Cleared once the new path lands.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);
  const markPending = (href: string) => (e: React.MouseEvent) => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) setPendingHref(href);
  };

  return (
    <aside className="chrome-nav fixed inset-y-0 left-0 z-20 flex w-[248px] flex-col text-on-navy">
      {/* Wordmark lockup */}
      <div className="flex items-center gap-3 px-5 py-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-dark text-base font-extrabold text-white">
          A
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-lg font-extrabold tracking-tight text-on-navy">Azen</span>
          <span className="text-[11px] font-medium uppercase tracking-wide text-on-navy-muted">Agency</span>
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map((item) => {
          const active = item.href
            ? pendingHref !== null
              ? pendingHref === item.href
              : pathname === item.href || pathname.startsWith(item.href + "/")
            : false;
          const Icon = item.icon;

          if (item.soon || !item.href) {
            return (
              <div
                key={item.label}
                aria-disabled
                className="flex cursor-default items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-on-navy-muted/60"
              >
                <span className="flex items-center gap-3">
                  <Icon size={18} />
                  {item.label}
                </span>
                <span className="rounded-full border border-navy-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-navy-muted">
                  soon
                </span>
              </div>
            );
          }

          return (
            <Link
              key={item.label}
              href={item.href}
              onClick={markPending(item.href)}
              className={cn(
                "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-white font-semibold text-navy shadow-[0_6px_16px_rgba(4,20,50,0.28)]"
                  : "text-on-navy-muted hover:bg-white/10 hover:text-on-navy",
              )}
            >
              <Icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User chip */}
      <div className="border-t border-navy-line px-3 py-4">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-dark text-sm font-bold text-white">
            {initials(displayName)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-on-navy">{displayName}</p>
            <p className="truncate text-xs text-on-navy-muted">Agency admin</p>
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
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
