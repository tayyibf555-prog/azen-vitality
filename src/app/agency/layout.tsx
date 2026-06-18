"use client";

import { AgencySidebar } from "@/components/agency/agency-sidebar";

export default function AgencyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-cream">
      <AgencySidebar />
      <div className="pl-[248px]">
        <main className="mx-auto max-w-[1400px] px-8 py-7">{children}</main>
      </div>
    </div>
  );
}
