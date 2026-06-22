"use client";

import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-cream">
      <ClientSidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <ClientTopbar />
        <main className="flex-1">
          <div className="mx-auto max-w-[1400px] space-y-6 px-8 py-7">{children}</div>
        </main>
      </div>
      <PlatformShortcuts />
    </div>
  );
}
