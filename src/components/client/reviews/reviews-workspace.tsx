"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Star,
  Check,
  X,
  Clock,
  Send,
  MinusCircle,
  AlertTriangle,
  Loader2,
  CalendarCheck,
} from "lucide-react";
import { SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { ReviewStatus } from "@/lib/reviews/types";

export interface SiteName {
  id: string;
  name: string;
}

// Mirrors the TodayItem shape returned by GET /api/reviews/today.
interface TodayItem {
  appointmentId: string;
  patientId: string;
  patientName: string;
  siteId: string;
  start: string;
  state: string;
  practitioner: string | null;
  reviewStatus: ReviewStatus | null;
  hasReviewRequest: boolean;
}

// Local per-row UI state layered over the fetched items, so we can show an
// optimistic result the moment an attendance is recorded without refetching.
interface RowAction {
  busy: boolean;
  done: boolean;
  status: ReviewStatus | null;
  message: string | null;
  error: string | null;
  // A scheduled send time the POST returned, so the row can show "~3pm".
  sendAt: string | null;
}

const STATUS_TONE: Record<ReviewStatus, Tone> = {
  scheduled: "info",
  sent: "success",
  skipped: "neutral",
  suppressed: "warning",
  failed: "danger",
};
const STATUS_LABEL: Record<ReviewStatus, string> = {
  scheduled: "Scheduled",
  sent: "Sent",
  skipped: "Skipped",
  suppressed: "Opted out",
  failed: "Failed",
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

// "~3pm" / "~10am" style approximate London-local time for a scheduled send.
function approxLondonTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase();
  const suffix = minute === "00" ? "" : `:${minute}`;
  return `~${hour}${suffix}${dayPeriod}`;
}

// Map a POST /api/reviews/attend outcome to a human line shown inline on the row.
function outcomeMessage(status: ReviewStatus | null, sendAt: string | null): string {
  switch (status) {
    case "scheduled":
      return sendAt
        ? `Review request scheduled for ${approxLondonTime(sendAt)}.`
        : "Review request scheduled.";
    case "sent":
      return "Review request already sent.";
    case "skipped":
      return "No SMS or email consent, so no request was sent.";
    case "suppressed":
      return "Patient has opted out, so no request was sent.";
    case "failed":
      return "The last send failed and will be retried.";
    default:
      return "Recorded. No request was scheduled.";
  }
}

export function ReviewsWorkspace({
  clientSlug,
  siteNames,
}: {
  clientSlug: string;
  siteNames: SiteName[];
}) {
  const [items, setItems] = useState<TodayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [showAllItems, setShowAllItems] = useState(false);
  const [showAllRequests, setShowAllRequests] = useState(false);

  const siteName = useMemo(() => {
    const map = new Map(siteNames.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? id;
  }, [siteNames]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/reviews/today?client=${encodeURIComponent(clientSlug)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          appointments?: TodayItem[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setLoadError(json.error ?? "Could not load today's appointments.");
          setItems([]);
          return;
        }
        setItems(json.appointments ?? []);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load today's appointments. Please try again.");
          setItems([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [clientSlug]);

  async function mark(appointmentId: string, attended: boolean) {
    setActions((prev) => ({
      ...prev,
      [appointmentId]: {
        busy: true,
        done: false,
        status: null,
        message: null,
        error: null,
        sendAt: null,
      },
    }));
    try {
      const res = await fetch("/api/reviews/attend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, appointmentId, attended }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        status?: ReviewStatus;
        request?: { status?: ReviewStatus; sendAt?: string } | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setActions((prev) => ({
          ...prev,
          [appointmentId]: {
            busy: false,
            done: false,
            status: null,
            message: null,
            error: json.error ?? "Something went wrong. Please try again.",
            sendAt: null,
          },
        }));
        return;
      }

      const status: ReviewStatus | null = !attended
        ? null
        : json.status ?? json.request?.status ?? null;
      const sendAt = json.request?.sendAt ?? null;

      // Reflect the new state on the underlying item too, so the requests list and
      // any later render stay consistent without a refetch.
      setItems((prev) =>
        prev.map((it) =>
          it.appointmentId === appointmentId
            ? { ...it, reviewStatus: status, hasReviewRequest: attended && status !== null }
            : it,
        ),
      );

      setActions((prev) => ({
        ...prev,
        [appointmentId]: {
          busy: false,
          done: true,
          status,
          message: attended
            ? outcomeMessage(status, sendAt)
            : "Marked as did not attend. No review request sent.",
          error: null,
          sendAt,
        },
      }));
    } catch {
      setActions((prev) => ({
        ...prev,
        [appointmentId]: {
          busy: false,
          done: false,
          status: null,
          message: null,
          error: "Network error. Please try again.",
          sendAt: null,
        },
      }));
    }
  }

  // The requests list draws from items already annotated with a review status,
  // plus any status we set optimistically after an attend action.
  const requestRows = useMemo(() => {
    return items
      .map((it) => {
        const local = actions[it.appointmentId];
        const status = local?.done ? local.status : it.reviewStatus;
        if (!status) return null;
        return {
          appointmentId: it.appointmentId,
          patientName: it.patientName,
          siteId: it.siteId,
          status,
          sendAt: local?.sendAt ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [items, actions]);

  const ITEMS_CAP = 8;
  const REQUESTS_CAP = 6;
  const visibleItems = showAllItems ? items : items.slice(0, ITEMS_CAP);
  const visibleRequests = showAllRequests ? requestRows : requestRows.slice(0, REQUESTS_CAP);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <SectionCard
        title="Today's appointments"
        description="Mark who attended. A compliant Google review request is then sent automatically later, through the consent-aware messaging layer. There is no message to send by hand."
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
            <Loader2 className="animate-spin" size={16} aria-hidden />
            Loading today&rsquo;s appointments&hellip;
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>{loadError}</span>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No appointments today"
            description="Once today's diary has appointments, they will appear here so the team can mark who attended and a review request follows automatically."
          />
        ) : (
          <ul className="divide-y divide-line">
            {visibleItems.map((it) => {
              const action = actions[it.appointmentId];
              const alreadyHandled = it.hasReviewRequest && it.reviewStatus !== null;
              const settled = action?.done || alreadyHandled;
              const status = action?.done ? action.status : it.reviewStatus;
              return (
                <li
                  key={it.appointmentId}
                  className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold tabular-nums text-navy">{hhmm(it.start)}</span>
                      <span className="font-semibold text-navy">{it.patientName}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {it.practitioner ?? "Unassigned"} &middot; {siteName(it.siteId)}
                    </p>
                    {settled && status ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <StatusPill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusPill>
                        <span className="text-xs text-muted">
                          {action?.message ?? outcomeMessage(status, action?.sendAt ?? null)}
                        </span>
                      </div>
                    ) : null}
                    {action?.error ? (
                      <p className="mt-2 text-xs font-medium text-danger" role="alert">
                        {action.error}
                      </p>
                    ) : null}
                  </div>

                  {settled ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-success">
                      <Check size={16} aria-hidden /> Recorded
                    </span>
                  ) : (
                    <div
                      role="group"
                      aria-label={`Attendance for ${it.patientName}`}
                      className="flex shrink-0 items-center gap-2"
                    >
                      <button
                        type="button"
                        onClick={() => mark(it.appointmentId, true)}
                        disabled={action?.busy}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-sm font-semibold text-success transition-colors hover:bg-success/15 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40",
                        )}
                      >
                        {action?.busy ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden />
                        ) : (
                          <Check size={15} aria-hidden />
                        )}
                        Attended
                      </button>
                      <button
                        type="button"
                        onClick={() => mark(it.appointmentId, false)}
                        disabled={action?.busy}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-card-muted hover:text-ink disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30",
                        )}
                      >
                        <X size={15} aria-hidden />
                        Did not attend
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !loadError && items.length > ITEMS_CAP ? (
          <button
            type="button"
            onClick={() => setShowAllItems((v) => !v)}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold text-blue-dark transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
          >
            {showAllItems ? "Show fewer" : `Show all ${items.length}`}
          </button>
        ) : null}
        <p className="mt-4 text-xs text-muted">
          The review request sends automatically a few hours later or the next morning. Consent and
          opt-outs are always respected, and messages are in test mode until go-live.
        </p>
      </SectionCard>

      <SectionCard
        title="Review requests"
        description="Google review requests raised from today's attendance, with their current status and send time."
      >
        {requestRows.length === 0 ? (
          <EmptyState
            icon={Star}
            title="No review requests yet"
            description="Review requests appear here as soon as you mark an appointment attended. Each patient is asked once per appointment."
          />
        ) : (
          <ul className="divide-y divide-line">
            {visibleRequests.map((r) => (
              <li
                key={r.appointmentId}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-navy">{r.patientName}</span>
                  <p className="mt-0.5 text-sm text-muted">{siteName(r.siteId)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {r.status === "scheduled" && r.sendAt ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <Clock size={13} aria-hidden /> {approxLondonTime(r.sendAt)}
                    </span>
                  ) : null}
                  <StatusPill tone={STATUS_TONE[r.status]}>
                    {r.status === "sent" ? <Send size={12} aria-hidden /> : null}
                    {r.status === "skipped" || r.status === "suppressed" ? (
                      <MinusCircle size={12} aria-hidden />
                    ) : null}
                    {STATUS_LABEL[r.status]}
                  </StatusPill>
                </div>
              </li>
            ))}
          </ul>
        )}
        {requestRows.length > REQUESTS_CAP ? (
          <button
            type="button"
            onClick={() => setShowAllRequests((v) => !v)}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold text-blue-dark transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
          >
            {showAllRequests ? "Show fewer" : `View all ${requestRows.length}`}
          </button>
        ) : null}
      </SectionCard>
    </div>
  );
}
