"use client";

import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, MessageSquarePlus, CreditCard, Settings, LogOut, type LucideIcon } from "lucide-react";
import { IntentLink } from "@/components/platform/intent-link";
import { NavProgressBar } from "@/components/platform/nav-progress";
import { usePendingNav } from "@/components/platform/use-pending-nav";
import { useAuth } from "@/lib/auth/mock-auth";
import { isActiveWithPending } from "@/lib/nav-intent";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { label: "Cockpit", href: "/agency", icon: LayoutDashboard },
  { label: "Feedback", href: "/agency/feedback", icon: MessageSquarePlus },
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

  // Optimistic active state + the progress bar + intent-armed prefetch, from the
  // same hook the client shell's rail, section bar and patient tabs use. This
  // shell is force-dynamic like the rest (src/app/agency/layout.tsx), so its
  // un-armed links prefetched NOTHING and every click here was a cold round trip
  // with the old tab still lit — the exact defect the client surfaces were fixed
  // for, missed here because /agency is a different tree.
  const { pendingHref, markPending } = usePendingNav();

  return (
    <>
      {/* Fixed-position, so it costs no layout, and its own 150ms animation delay
          means a prefetched (instant) switch never flashes it. */}
      <NavProgressBar active={pendingHref !== null} />
      <aside className="chrome-nav sticky top-0 flex h-screen w-[248px] shrink-0 flex-col text-on-navy lg:h-full">
        {/* Wordmark lockup */}
        <div className="flex items-center gap-3 px-5 py-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-dark text-base font-bold text-white">
            A
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-on-navy">Azen</span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-on-navy-muted">Agency</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((item) => {
            // The settled rule is this surface's own (a prefix match: the cockpit
            // and its client pages), and isActiveWithPending layers the in-flight
            // click on top of it exactly as it does for the section bar.
            const active = item.href
              ? isActiveWithPending(
                  item.href,
                  pendingHref,
                  pathname === item.href || pathname.startsWith(item.href + "/"),
                )
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
              <IntentLink
                key={item.label}
                href={item.href}
                aria-current={active ? "page" : undefined}
                // A rested hover, a focus or a press arms the FULL dynamic
                // prefetch. The default ("auto") prefetches a dynamic route only
                // down to the nearest loading.tsx, and this app has none by
                // design, so an un-armed link here prefetched nothing at all.
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
              </IntentLink>
            );
          })}
        </nav>

        {/* User chip */}
        <div className="border-t border-navy-line px-3 py-4">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-dark text-sm font-semibold text-white">
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
    </>
  );
}
