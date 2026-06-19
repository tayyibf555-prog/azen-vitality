"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Gauge, LayoutDashboard, LogOut, type LucideIcon } from "lucide-react";
import { CLIENT_NAV, type NavGroup } from "@/lib/nav";
import { getClient } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
import { useOwnerMode } from "@/components/owner/owner-mode";
import { PORTAL_ACCESS, isClientRole } from "@/lib/portal-access";
import { cn } from "@/lib/utils";

/** Slugs that have a placeholder (not yet built) CLIENT_NAV entry. */
const PLACEHOLDER_SLUGS = new Set(
  CLIENT_NAV.flatMap((g) => g.items)
    .filter((i) => i.status === "placeholder")
    .map((i) => i.slug),
);

const ROLE_LABELS: Record<string, string> = {
  agency_admin: "Agency admin",
  client_owner: "Owner",
  client_manager: "Manager",
  client_general: "General",
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
  const { mode } = useOwnerMode();

  const clientSlug = params.client;
  const client = getClient(clientSlug);
  const base = `/owner/${clientSlug}`;

  const isBaseActive = pathname === base || pathname === `${base}/`;

  const isHrefActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // Operations mode renders the CLIENT_NAV groups, skipping the first Overview
  // group (its only item has slug ""), each item linking under /owner/[client].
  const operationsGroups: NavGroup[] = CLIENT_NAV.filter(
    (group) => !group.items.some((item) => item.slug === ""),
  );

  // Owner (and agency_admin previewing) keep the mode-based nav; the two employee
  // roles render their fixed PORTAL_ACCESS nav as a single group instead.
  const role = user?.role;
  const isEmployeePortal = role === "client_manager" || role === "client_general";

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-navy-line bg-navy">
      {/* Client context */}
      <div className="flex items-center gap-3 px-5 py-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-dark text-sm font-extrabold text-white">
          {client ? initialsOf(client.name) : "V"}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-on-navy">
            {client ? client.name : "Client"}
          </p>
          <p className="text-[11px] text-on-navy-muted">on Dentally</p>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {isEmployeePortal && isClientRole(role) ? (
          <div className="mb-4">
            <ul className="space-y-0.5">
              {PORTAL_ACCESS[role].nav.map((item) => {
                const href = item.slug === "" ? base : `${base}/${item.slug}`;
                const active = item.slug === "" ? isBaseActive : isHrefActive(href);
                return (
                  <SidebarLink
                    key={item.slug || "base"}
                    href={href}
                    label={item.label}
                    icon={item.icon}
                    active={active}
                    soon={PLACEHOLDER_SLUGS.has(item.slug)}
                  />
                );
              })}
            </ul>
          </div>
        ) : mode === "management" ? (
          <div className="mb-4">
            <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-navy-muted">
              Management
            </p>
            <ul className="space-y-0.5">
              <SidebarLink
                href={base}
                label="Management"
                icon={Gauge}
                active={isBaseActive}
              />
              <SidebarLink
                href={`${base}/overview`}
                label="Overview"
                icon={LayoutDashboard}
                active={isHrefActive(`${base}/overview`)}
              />
            </ul>
          </div>
        ) : (
          operationsGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-navy-muted">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const href = `${base}/${item.slug}`;
                  return (
                    <SidebarLink
                      key={item.slug}
                      href={href}
                      label={item.label}
                      icon={item.icon}
                      active={isHrefActive(href)}
                      soon={item.status === "placeholder"}
                    />
                  );
                })}
              </ul>
            </div>
          ))
        )}
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

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
  soon,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  soon?: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
          active
            ? "bg-navy-soft text-on-navy"
            : "text-on-navy-muted hover:bg-navy-soft/60 hover:text-on-navy",
        )}
      >
        {active ? (
          <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blue-light" />
        ) : null}
        <Icon size={16} className="shrink-0" />
        <span className="truncate">{label}</span>
        {soon ? (
          <span className="ml-auto rounded-full border border-navy-line px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-on-navy-muted">
            soon
          </span>
        ) : null}
      </Link>
    </li>
  );
}
