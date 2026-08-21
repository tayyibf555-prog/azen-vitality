"use client";

import { useEffect, useState } from "react";
import {
  ShieldCheck,
  CalendarX,
  UserPlus,
  Sparkles,
  TrendingDown,
  Bell,
  ExternalLink,
  X,
  Undo2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SectionCard, StatusPill, EmptyState, SampleBadge, type Tone } from "@/components/primitives";
import type {
  NotificationItem,
  NotificationType,
  NotificationUrgency,
} from "@/lib/notifications/types";

// Read-only feed plus a lightweight, client-only dismiss overlay backed by
// localStorage (keyed by the notification's stable id). Dismissing only hides the
// row locally — the feed itself stays derived and server-computed, so a dismissed
// item reappears if it is still live and the key is cleared. No server writes.

const DISMISS_KEY = "notifications:dismissed";

const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  compliance: ShieldCheck,
  no_show: CalendarX,
  onboarding: UserPlus,
  lead: Sparkles,
  anomaly: TrendingDown,
  system: Bell,
};

const URGENCY_TONE: Record<NotificationUrgency, Tone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const URGENCY_LABEL: Record<NotificationUrgency, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Relative label that reads correctly for both past and future instants. */
function whenLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((now - t) / 60000);
  const abs = Math.abs(mins);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let phrase: string;
  if (abs < 1) return "just now";
  if (abs < 60) phrase = fmt(abs, "min");
  else if (abs < 60 * 24) phrase = fmt(Math.round(abs / 60), "hr");
  else phrase = fmt(Math.round(abs / (60 * 24)), "day");
  return mins >= 0 ? `${phrase} ago` : `in ${phrase}`;
}

function NotificationRow({
  item,
  now,
  onDismiss,
}: {
  item: NotificationItem;
  now: number;
  onDismiss: (id: string) => void;
}) {
  const Icon = TYPE_ICON[item.type] ?? Bell;
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={URGENCY_TONE[item.urgency]}>{URGENCY_LABEL[item.urgency]}</StatusPill>
          {item.sample ? <SampleBadge /> : null}
          <span className="font-semibold leading-snug text-navy">{item.title}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted">{item.detail}</p>
        <p className="mt-1 text-[11px] uppercase tracking-wide text-muted">{whenLabel(item.at, now)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.href ? (
          <a
            href={item.href}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card-muted"
          >
            <ExternalLink size={13} /> View
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss"
          className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-card p-1.5 text-muted transition-colors hover:bg-card-muted hover:text-navy"
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as unknown;
    if (Array.isArray(ids)) return new Set(ids.filter((x): x is string => typeof x === "string"));
  } catch {
    // ignore corrupt / unavailable storage
  }
  return new Set();
}

/** Client-only state, hydrated once after mount (localStorage + the clock). */
interface ClientState {
  now: number;
  dismissed: Set<string>;
}

export function NotificationsList({ items }: { items: NotificationItem[] }) {
  // null until mount: SSR and the first client paint render the full server list,
  // then we hydrate the clock + dismissed set on the client only. Set once via a
  // deferred microtask so we never call setState synchronously inside the effect.
  const [client, setClient] = useState<ClientState | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setClient({ now: Date.now(), dismissed: readDismissed() });
    });
    return () => {
      active = false;
    };
  }, []);

  function persist(next: Set<string>) {
    setClient((prev) => ({ now: prev?.now ?? Date.now(), dismissed: next }));
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(next)));
    } catch {
      // ignore storage write failures
    }
  }

  const hydrated = client !== null;
  const dismissed = client?.dismissed ?? new Set<string>();
  const now = client?.now ?? 0;

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    persist(next);
  }

  function restoreAll() {
    persist(new Set());
  }

  // Before hydration, render the full server list (avoids a flash of hidden rows
  // and keeps SSR and first client paint identical).
  const visible = hydrated ? items.filter((i) => !dismissed.has(i.id)) : items;
  const hiddenCount = hydrated ? items.length - visible.length : 0;

  return (
    <SectionCard
      title="Feed"
      description="Everything that needs attention now, most urgent first. Dismissing a notification hides it on this device only."
      bodyClassName="p-0"
      actions={
        hiddenCount > 0 ? (
          <button
            type="button"
            onClick={restoreAll}
            className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1 text-xs font-semibold text-muted transition-colors hover:bg-card-muted hover:text-navy"
          >
            <Undo2 size={13} /> Restore {hiddenCount} dismissed
          </button>
        ) : null
      }
    >
      {visible.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Bell}
            title="All clear"
            description={
              items.length === 0
                ? "Nothing needs your attention right now. New alerts appear here as they arise."
                : "You have dismissed everything. Restore the feed to see dismissed items again."
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((item) => (
            <NotificationRow key={item.id} item={item} now={now} onDismiss={dismiss} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
