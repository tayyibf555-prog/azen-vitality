"use client";

import { useRouter } from "next/navigation";
import { Building2, Stethoscope, Headset, ArrowRight } from "lucide-react";
import type { Role } from "@/lib/types";
import { MOCK_USERS, useAuth } from "@/lib/auth/mock-auth";
import { cn } from "@/lib/utils";

/** Where each role lands after sign-in. */
function destinationFor(role: Role): string {
  if (role === "agency_admin") return "/agency";
  const clientId = MOCK_USERS[role].clientId ?? "vitality";
  return `/c/${clientId}`;
}

const ROLE_CARDS: {
  role: Role;
  icon: typeof Building2;
  blurb: string;
}[] = [
  {
    role: "agency_admin",
    icon: Building2,
    blurb: "Azen's cross-client cockpit. Oversee every deployment, leads, bookings and recovered revenue across all sites.",
  },
  {
    role: "client_owner",
    icon: Stethoscope,
    blurb: "The practice owner view. Full funnel across all sites, every module, real-time performance.",
  },
  {
    role: "client_coordinator",
    icon: Headset,
    blurb: "The front-desk view. The day's prioritised tasks, recalls, follow-ups and bookings.",
  },
];

const ROLE_LABEL: Record<Role, string> = {
  agency_admin: "Agency admin",
  client_owner: "Practice owner",
  client_coordinator: "Coordinator",
};

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  function enter(role: Role) {
    login(role);
    router.push(destinationFor(role));
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-navy p-12 text-on-navy lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--blue-dark), transparent 70%)" }}
        />
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-dark text-lg font-extrabold text-white">A</span>
          <span className="text-xl font-extrabold tracking-tight">Azen</span>
        </div>
        <div className="relative max-w-md space-y-4">
          <h1 className="text-4xl leading-tight text-on-navy">The operating layer for Vitality Dental.</h1>
          <p className="text-on-navy-muted">
            Built on Dentally. Catches leads in seconds, books them, and wins back the patients and unfinished
            treatment that quietly leak out the back of the practice.
          </p>
        </div>
        <p className="relative text-xs text-on-navy-muted">Azen AI Ltd. Single tenant, client owns the IP.</p>
      </section>

      {/* Sign-in panel */}
      <section className="flex items-center justify-center bg-cream px-6 py-12">
        <div className="w-full max-w-md space-y-7">
          <div className="space-y-1">
            <span className="lg:hidden mb-3 inline-flex items-center gap-2 font-extrabold text-navy">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-dark text-white">A</span>
              Azen
            </span>
            <h2 className="text-2xl text-navy">Choose a view to enter</h2>
            <p className="text-sm text-muted">
              Mock sign-in for the foundation build. Real authentication lands in a later session.
            </p>
          </div>

          <div className="space-y-3">
            {ROLE_CARDS.map(({ role, icon: Icon, blurb }) => (
              <button
                key={role}
                onClick={() => enter(role)}
                className={cn(
                  "group flex w-full items-center gap-4 rounded-xl border border-line bg-card p-4 text-left transition-all",
                  "hover:border-blue-dark/40 hover:shadow-[0_4px_16px_rgba(10,14,26,0.08)]",
                )}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
                  <Icon size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-bold text-navy">{ROLE_LABEL[role]}</span>
                    <span className="text-xs text-muted">{MOCK_USERS[role].name}</span>
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">{blurb}</span>
                </span>
                <ArrowRight size={18} className="shrink-0 text-muted transition-colors group-hover:text-blue-dark" />
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
