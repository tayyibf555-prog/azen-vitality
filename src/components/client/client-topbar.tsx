"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Building2, Check, ChevronDown } from "lucide-react";
import { getClient, getSites } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ALL_SITES, SITE_VIEW_COOKIE } from "@/lib/site-view-shared";

export function ClientTopbar({ selected: initialSelected = ALL_SITES }: { selected?: string }) {
  const params = useParams<{ client: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const client = getClient(params.client);
  const sites = client ? getSites(client.id) : [];

  const [selected, setSelected] = useState<string>(initialSelected);
  const [open, setOpen] = useState(false);

  const selectedLabel =
    selected === ALL_SITES ? "All sites" : sites.find((s) => s.id === selected)?.name ?? "All sites";

  // Persist the choice (a year) and re-render the server components so the whole
  // dashboard re-scopes to the chosen site. The cookie rides the refresh request.
  function choose(value: string) {
    setSelected(value);
    setOpen(false);
    document.cookie = `${SITE_VIEW_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-line bg-card px-8">
      {/* Site switcher */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="flex items-center gap-2 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:bg-card-muted"
        >
          <Building2 size={15} className="text-blue-dark" />
          <span>{selectedLabel}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
        {open ? (
          <div className="absolute left-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-lg border border-line bg-card py-1 shadow-lg">
            {sites.map((s) => (
              <SiteOption
                key={s.id}
                label={s.name}
                active={selected === s.id}
                onSelect={() => choose(s.id)}
              />
            ))}
            {sites.length ? <div className="my-1 border-t border-line" /> : null}
            <SiteOption
              label="All sites"
              active={selected === ALL_SITES}
              onSelect={() => choose(ALL_SITES)}
            />
          </div>
        ) : null}
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

function SiteOption({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // onMouseDown so it fires before the trigger's onBlur closes the menu.
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-card-muted",
        active ? "font-semibold text-navy" : "text-ink",
      )}
    >
      <span>{label}</span>
      {active ? <Check size={14} className="text-blue-dark" /> : null}
    </button>
  );
}
