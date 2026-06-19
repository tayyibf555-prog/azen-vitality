"use client";

import { OwnerSidebar } from "@/components/owner/owner-sidebar";
import { OwnerTopbar } from "@/components/owner/owner-topbar";
import { OwnerModeProvider } from "@/components/owner/owner-mode";
import { RoleGuard } from "@/components/owner/role-guard";

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <OwnerModeProvider>
      <RoleGuard />
      <div className="flex min-h-screen bg-cream">
        <OwnerSidebar />
        <div className="flex min-h-screen flex-1 flex-col">
          <OwnerTopbar />
          <main className="flex-1">
            <div className="mx-auto max-w-[1400px] space-y-6 px-8 py-7">{children}</div>
          </main>
        </div>
      </div>
    </OwnerModeProvider>
  );
}
