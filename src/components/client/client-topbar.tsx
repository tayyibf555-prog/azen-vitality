"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/mock-auth";
import { Button } from "@/components/ui/button";
import { SiteSwitcher } from "@/components/client/site-switcher";

export function ClientTopbar() {
  const { user } = useAuth();

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-line bg-card px-8">
      {/* Site switcher */}
      <SiteSwitcher />

      {/* Right side */}
      <div className="flex items-center gap-2">
        {user?.role === "agency_admin" ? (
          <Button asChild variant="ghost" size="sm">
            <Link href="/agency">Back to agency</Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
