"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Check } from "lucide-react";
import type { Role } from "@/lib/types";
import { MOCK_USERS, useAuth } from "@/lib/auth/mock-auth";
import { cn } from "@/lib/utils";

const ORDER: Role[] = ["agency_admin", "client_owner", "client_coordinator"];
const LABEL: Record<Role, string> = {
  agency_admin: "Agency admin",
  client_owner: "Practice owner",
  client_coordinator: "Coordinator",
};

function destinationFor(role: Role): string {
  if (role === "agency_admin") return "/agency";
  const clientId = MOCK_USERS[role].clientId ?? "vitality";
  if (role === "client_owner") return `/owner/${clientId}`;
  return `/c/${clientId}`;
}

/**
 * Dev-only affordance: preview any role without signing out. Hidden until a
 * session exists. Disappears entirely when real auth replaces the mock.
 */
export function RoleSwitcher() {
  const { user, switchRole } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  function go(role: Role) {
    switchRole(role);
    setOpen(false);
    router.push(destinationFor(role));
  }

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open ? (
        <div className="mb-2 w-60 overflow-hidden rounded-xl border border-navy-line bg-navy text-on-navy shadow-2xl">
          <p className="border-b border-navy-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-on-navy-muted">
            Preview as
          </p>
          {ORDER.map((role) => (
            <button
              key={role}
              onClick={() => go(role)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-navy-soft",
                role === user.role ? "text-on-navy" : "text-on-navy-muted",
              )}
            >
              <span>
                <span className="block font-semibold">{LABEL[role]}</span>
                <span className="block text-xs text-on-navy-muted">{MOCK_USERS[role].name}</span>
              </span>
              {role === user.role ? <Check size={15} className="text-blue-light" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full bg-navy px-4 py-2.5 text-sm font-semibold text-on-navy shadow-xl ring-1 ring-navy-line transition-transform hover:scale-[1.03]"
      >
        <Eye size={15} className="text-blue-light" />
        Preview as: {LABEL[user.role]}
      </button>
    </div>
  );
}
