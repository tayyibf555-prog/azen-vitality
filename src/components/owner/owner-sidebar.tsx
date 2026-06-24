"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Gauge, Wand2, BrainCircuit, LogOut } from "lucide-react";
import { CLIENT_NAV } from "@/lib/nav";
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

  // The owner Overview lives at /owner/[client]/overview, so the base path is
  // reserved for the Management view rather than the funnel Overview.
  const hrefFor = (slug: string) => (slug === "" ? `${base}/overview` : `${base}/${slug}`);

  const isManagementActive = pathname === base || pathname === `${base}/`;

  const isActive = (slug: string) => {
    const href = hrefFor(slug);
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-navy-line bg-navy">
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
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isManagementActive
                    ? "bg-navy-soft text-on-navy"
                    : "text-on-navy-muted hover:bg-navy-soft/60 hover:text-on-navy",
                )}
              >
                {isManagementActive ? (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blue-light" />
                ) : null}
                <Gauge size={16} className="shrink-0" />
                <span className="truncate">Management</span>
              </Link>
            </li>
            <li>
              <Link
                href={hrefFor("co-pilot")}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive("co-pilot")
                    ? "bg-navy-soft text-on-navy"
                    : "text-on-navy-muted hover:bg-navy-soft/60 hover:text-on-navy",
                )}
              >
                {isActive("co-pilot") ? (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blue-light" />
                ) : null}
                <Wand2 size={16} className="shrink-0" />
                <span className="truncate">Co-pilot</span>
              </Link>
            </li>
            <li>
              <Link
                href={hrefFor("practice-brain")}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive("practice-brain")
                    ? "bg-navy-soft text-on-navy"
                    : "text-on-navy-muted hover:bg-navy-soft/60 hover:text-on-navy",
                )}
              >
                {isActive("practice-brain") ? (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blue-light" />
                ) : null}
                <BrainCircuit size={16} className="shrink-0" />
                <span className="truncate">Practice brain</span>
              </Link>
            </li>
          </ul>
        </div>

        {CLIENT_NAV.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-navy-muted">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const href = hrefFor(item.slug);
                const active = isActive(item.slug);
                return (
                  <li key={item.slug || "overview"}>
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
        ))}
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
