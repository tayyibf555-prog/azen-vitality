"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, Menu, Search } from "lucide-react";
import { getClient, getSites } from "@/lib/mock";
import { useAuth } from "@/lib/auth/mock-auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ALL_SITES, SITE_VIEW_COOKIE } from "@/lib/site-view-shared";
import { toggleMobileNav } from "@/components/platform/mobile-nav";

// A short round-dot code for a site chip: a leading site code like "N15" is kept
// as-is; otherwise the initials of the first two words. "All sites" -> "ALL".
function siteCode(label: string): string {
  if (label === "All sites") return "ALL";
  const first = label.trim().split(/\s+/)[0] ?? "";
  if (/^[A-Za-z]{1,2}\d{1,3}$/.test(first)) return first.toUpperCase();
  return label
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 3)
    .join("")
    .toUpperCase();
}

// Prettify the current route into a breadcrumb leaf ("no-show-defence" -> "No-show
// defence"). The client base path is "Home".
function sectionLabel(pathname: string | null, base: string): string {
  if (!pathname) return "Home";
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\/+/, "") : "";
  const seg = rest.split("/")[0] ?? "";
  if (!seg) return "Home";
  const words = seg.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ClientTopbar({ selected: initialSelected = ALL_SITES }: { selected?: string }) {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const client = getClient(params.client);
  const sites = client ? getSites(client.id) : [];
  const isOwner = pathname?.startsWith("/owner") ?? false;
  const base = `${isOwner ? "/owner" : "/c"}/${params.client}`;

  const [selected, setSelected] = useState<string>(initialSelected);
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Close on outside click/tap. onBlur alone misses Safari, where buttons do not
  // take focus on click, so the menu never blurred and could not be dismissed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

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
    // Translucent material layer: content scrolls UNDER the pinned bar; the
    // .topbar-material class carries the blur + the scroll-edge fade and its own
    // reduced-transparency/no-blur fallbacks (globals.css).
    <header className="topbar-material sticky top-0 z-10 flex h-14 items-center justify-between gap-3 px-4 lg:px-7">
      {/* Left: mobile menu toggle + breadcrumb + site chip */}
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={toggleMobileNav}
          aria-label="Open menu"
          className="pressable flex h-9 w-9 items-center justify-center rounded-full border border-line-strong text-navy transition-colors hover:bg-card-muted lg:hidden"
        >
          <Menu size={18} />
        </button>

        {/* Breadcrumb: product context -> current section */}
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-[13px] font-semibold text-muted sm:flex">
          <span className="truncate text-navy">{client ? client.name : "Vitality Dental"}</span>
          <span aria-hidden className="text-line-strong">›</span>
          <span className="truncate">{sectionLabel(pathname, base)}</span>
        </nav>

        {/* Site switcher, styled as the mock's round-dot chip */}
        <div className="relative" ref={switcherRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          aria-label="Switch site"
          className="pressable flex items-center gap-2 rounded-full border border-line bg-card-muted py-1 pl-1 pr-3 text-xs font-bold text-navy transition-colors hover:border-line-strong"
        >
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-blue-royal px-1.5 text-[9.5px] font-extrabold text-white">
            {siteCode(selectedLabel)}
          </span>
          <span className="max-w-[10rem] truncate">{selectedLabel}</span>
          <ChevronDown size={13} className="text-muted" />
        </button>
        {open ? (
          <div className="absolute left-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-2xl border border-line bg-card py-1 shadow-lg">
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
      </div>

      {/* Right: round icon buttons for existing actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("azen:open-palette"))}
          aria-label="Search"
          className="pressable flex h-9 w-9 items-center justify-center rounded-full border border-line bg-card text-muted transition-colors hover:border-line-strong hover:text-navy"
        >
          <Search size={16} />
        </button>
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
