"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { useAuth } from "@/lib/auth/mock-auth";
import { cn } from "@/lib/utils";

// Owner control for the reactivation daily contact limit. Shows today's usage to
// everyone; only owner-level roles may change the number (the API enforces the
// same rule server-side). Kept as a small client island under the stat cards.

export function DailyLimitCard({ clientSlug }: { clientSlug: string }) {
  const { user } = useAuth();
  // Matches the nav's posture: no verified role (dev, un-enforced) sees everything.
  const canEdit = !user || user.role === "client_owner" || user.role === "agency_admin";

  const [limit, setLimit] = useState<number | null>(null);
  const [usedToday, setUsedToday] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/reactivation/settings?client=${encodeURIComponent(clientSlug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((j: { ok?: boolean; limit?: number; usedToday?: number }) => {
        if (active && j.ok && typeof j.limit === "number") {
          setLimit(j.limit);
          setUsedToday(j.usedToday ?? 0);
        }
      })
      .catch(() => {
        // Leave the card in its loading state; the sweep still enforces the cap.
      });
    return () => {
      active = false;
    };
  }, [clientSlug]);

  async function save() {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 0 || next > 500) {
      setError("Enter a whole number between 0 and 500.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reactivation/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, limit: next }),
      });
      if (!res.ok) throw new Error("save failed");
      setLimit(next);
      setEditing(false);
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const atLimit = limit !== null && limit > 0 && usedToday >= limit;

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f0f4f9] text-side-ink">
          <Gauge size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy">Daily contact limit</p>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            At most this many dormant patients are messaged automatically each day. When the limit is
            reached, outreach pauses and continues the next day{limit === 0 ? ". Set to 0, automatic outreach is paused entirely" : ""}.
          </p>
          {error ? <p className="mt-1 text-xs font-semibold text-danger">{error}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 pl-12 sm:pl-0">
        <span className={cn("text-sm tabular-nums", atLimit ? "font-semibold text-warning" : "text-muted")}>
          {limit === null ? "…" : `${usedToday} of ${limit} used today`}
        </span>
        {editing ? (
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={500}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-20 rounded-lg border border-line-strong bg-card px-2 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-blue-royal px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-dark disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-navy"
            >
              Cancel
            </button>
          </span>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => {
              setDraft(String(limit ?? ""));
              setEditing(true);
            }}
            disabled={limit === null}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:bg-card-muted disabled:opacity-50"
          >
            Change
          </button>
        ) : null}
      </div>
    </section>
  );
}
