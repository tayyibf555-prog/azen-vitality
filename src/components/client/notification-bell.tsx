"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

// ---------------------------------------------------------------------------
// The notification bell.
//
// Notifications used to appear TWICE: this bell, and a "Notifications" tab in
// Home's section bar. The bell is the right home for them, so the tab is gone
// and the page is now reached from here.
//
// Opening the bell shows the most recent few and a link through to everything.
// The feed is DERIVED on read rather than stored, so it is fetched when the bell
// opens rather than held in the shell: whatever is true at the moment you look
// is what you see, and a shell that never refetches would go stale within
// minutes on a busy morning.
//
// It fetches ON OPEN, not on mount. A count badge would be nice but it is not
// worth an extra build of the whole feed on every page load of every session,
// and a stale badge is worse than no badge.
// ---------------------------------------------------------------------------

interface PreviewItem {
  id: string;
  type: string;
  urgency: "high" | "medium" | "low" | string;
  title: string;
  detail: string;
  at: string;
  href: string | null;
}

/** "4 minutes ago", "2 days ago". Deliberately coarse: an alert's exact second
 *  is never the point, and a ticking relative time is a distraction. */
function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.round((now - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: PreviewItem[]; total: number; fetchedAt: number };

export function NotificationBell({
  clientSlug,
  href,
}: {
  clientSlug: string;
  /** The full Notifications page. */
  href: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fetched from the CLICK, not from an effect on `open`. The feed is derived on
  // read, so it has to be fetched each time the bell is opened rather than held;
  // doing that in the handler keeps the request tied to the intent that caused
  // it, and avoids setting state from an effect body.
  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/notifications/recent?client=${encodeURIComponent(clientSlug)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      // The clock is read HERE, when the answer arrives, not during render:
      // "4 minutes ago" is relative to when we asked, and reading Date.now() in
      // the render body makes the component impure.
      if (json?.ok)
        setState({
          status: "ready",
          items: json.items ?? [],
          total: json.total ?? 0,
          fetchedAt: Date.now(),
        });
      else setState({ status: "failed" });
    } catch {
      setState({ status: "failed" });
    }
  }

  // Dismiss on outside pointer and on Escape. Both, because Safari does not
  // focus a button on click so blur alone never fires there.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Notifications"
        className="pressable flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-blue-soft hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
      >
        <Bell size={16} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Recent notifications"
          className="absolute right-0 top-full z-30 mt-1.5 w-[340px] overflow-hidden rounded-[10px] border border-line bg-card shadow-[0_12px_34px_rgba(11,32,73,0.14)]"
        >
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h2 className="text-[12px] font-semibold text-navy">Notifications</h2>
            {state.status === "ready" && state.total > state.items.length ? (
              <span className="text-[11px] font-normal text-faint">
                {state.items.length} of {state.total}
              </span>
            ) : null}
          </div>

          <div className="max-h-[320px] overflow-y-auto">
            {state.status === "loading" || state.status === "idle" ? (
              <p className="px-3 py-4 text-[12px] font-normal text-muted">Reading…</p>
            ) : state.status === "failed" ? (
              // Says what happened. An empty list here would read as "nothing
              // needs you", which is the one thing it must not claim falsely.
              <p className="px-3 py-4 text-[12px] font-normal text-muted">
                These could not be read just now. Open the full page to try again.
              </p>
            ) : state.items.length === 0 ? (
              <p className="px-3 py-4 text-[12px] font-normal text-muted">Nothing needs attention.</p>
            ) : (
              <ul className="divide-y divide-line">
                {state.items.map((item) => {
                  const body = (
                    <>
                      <span className="flex items-baseline gap-1.5">
                        {item.urgency === "high" ? (
                          <span
                            aria-hidden
                            className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full bg-status-red"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-navy">
                          {item.title}
                        </span>
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[11.5px] font-normal leading-[1.4] text-muted">
                        {item.detail}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] font-normal text-faint">
                        {ago(item.at, state.fetchedAt)}
                      </span>
                    </>
                  );
                  return (
                    <li key={item.id}>
                      {item.href ? (
                        <Link
                          href={item.href}
                          onClick={() => setOpen(false)}
                          className="block px-3 py-2 transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy/25"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="px-3 py-2">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-line p-2">
            <Link
              href={href}
              onClick={() => setOpen(false)}
              className="block rounded-md bg-card-muted px-3 py-1.5 text-center text-[12px] font-semibold text-navy transition-colors hover:bg-blue-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              View all notifications
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
