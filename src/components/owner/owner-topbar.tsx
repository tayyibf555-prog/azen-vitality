"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Gauge, ListChecks } from "lucide-react";
import { useAuth } from "@/lib/auth/mock-auth";
import { Button } from "@/components/ui/button";
import { SiteSwitcher } from "@/components/client/site-switcher";
import { useOwnerMode, type OwnerMode } from "@/components/owner/owner-mode";
import { cn } from "@/lib/utils";

export function OwnerTopbar() {
  const params = useParams<{ client: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { mode, setMode } = useOwnerMode();

  const clientSlug = params.client;

  const select = (next: OwnerMode) => {
    setMode(next);
    if (next === "management") {
      router.push(`/owner/${clientSlug}`);
    } else {
      router.push(`/owner/${clientSlug}/treatment-coordinator`);
    }
  };

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-line bg-card px-8">
      {/* Left: site switcher + mode segmented control */}
      <div className="flex items-center gap-3">
        <SiteSwitcher />
        <div className="flex items-center gap-0.5 rounded-lg border border-line-strong bg-card-muted p-0.5">
          <ModeButton
            label="Operations"
            icon={ListChecks}
            active={mode === "operations"}
            onClick={() => select("operations")}
          />
          <ModeButton
            label="Management"
            icon={Gauge}
            active={mode === "management"}
            onClick={() => select("management")}
          />
        </div>
      </div>

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

function ModeButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: typeof Gauge;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
        active ? "bg-card text-navy shadow-sm" : "text-muted hover:text-navy",
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}
