"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Bell, Check, ChevronDown, Menu, Search } from "lucide-react";
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
    // ------------------------------------------------------------------------
    // ONE BAR, THREE ZONES, laid out as the reference does: menu on the left, a
    // real patient search across the middle, and the account controls on the
    // right. Nothing here repeats anything else on the screen.
    //
    // It replaced a bar the owner called "too overwhelming too complicated",
    // and the complaint was structural rather than cosmetic. The old bar
    // carried a breadcrumb ("Vitality Dental / Home c") that restated the
    // sidebar's own highlighted item and the page's own title; a site chip that
    // printed the site code twice ("N15 N15 Vitality Dental", because the code
    // was prepended to a name that already began with it); and a 16px search
    // icon where the reference has the single most-used control in the product.
    // Meanwhile the dashboard underneath carried a SECOND site dropdown, so the
    // same choice appeared twice within eighty pixels.
    //
    // The rule this now follows: the top bar owns what is true of the whole
    // session (which practice, who you are, find a patient). The page owns what
    // is true of the page. Neither states the other's business.
    // ------------------------------------------------------------------------
    <header className="topbar-material sticky top-0 z-10 flex h-14 items-center gap-3 px-4 lg:px-6">
      <button
        type="button"
        onClick={toggleMobileNav}
        aria-label="Open menu"
        className="pressable -ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-navy transition-colors hover:bg-blue-soft lg:hidden"
      >
        <Menu size={18} />
      </button>

      {/* PATIENT SEARCH, the middle zone. A field rather than an icon: this is
          what reception reaches for all day, and the reference gives it the
          centre of the bar. It opens the existing command palette, so there is
          one search implementation and not two. */}
      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("azen:open-palette"))}
          className="pressable group flex h-9 w-full max-w-[520px] items-center gap-2 rounded-[10px] border border-line bg-card-muted px-3 text-left transition-colors hover:border-line-strong hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <Search size={15} className="shrink-0 text-faint transition-colors group-hover:text-muted" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-faint">
            Search patients
          </span>
          <kbd className="hidden shrink-0 rounded border border-line bg-card px-1.5 py-[1px] text-[10px] font-semibold text-faint sm:inline">
            {modKeyLabel()}K
          </kbd>
        </button>
      </div>

      {/* ACCOUNT ZONE: the practice, then who you are. The ONLY site control in
          the product now; the dashboard's duplicate was removed. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="relative" ref={switcherRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Practice: ${selectedLabel}. Change practice`}
            className="pressable flex items-center gap-1.5 rounded-lg px-2.5 py-[6px] text-[13px] font-semibold text-navy transition-colors hover:bg-blue-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            {/* The code alone below md, the name alone above it. Never both: the
                name already starts with the code. */}
            <span className="max-w-[11rem] truncate md:hidden">{siteCode(selectedLabel)}</span>
            <span className="hidden max-w-[13rem] truncate md:inline">{selectedLabel}</span>
            <ChevronDown size={13} className="shrink-0 text-muted" />
          </button>
          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1.5 w-60 overflow-hidden rounded-[10px] border border-line bg-card py-1 shadow-[0_12px_34px_rgba(11,32,73,0.14)]"
            >
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

        <Link
          href={`${base}/notifications`}
          aria-label="Notifications"
          className="pressable flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-blue-soft hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <Bell size={16} />
        </Link>

        {user ? (
          <span className="hidden items-center gap-2 pl-1 lg:flex">
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-soft text-[10.5px] font-semibold text-blue-royal"
            >
              {initials(user.name)}
            </span>
            <span className="max-w-[9rem] truncate text-[13px] font-semibold text-navy">
              {user.name}
            </span>
          </span>
        ) : null}

        {user?.role === "agency_admin" ? (
          <Button asChild variant="ghost" size="sm">
            <Link href="/agency">Agency</Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/** Two initials for the account chip. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** The platform's modifier key, so the search hint matches the real shortcut. */
function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "⌘";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";
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
